import type { CommandReceipt, EventPage, MetricsSnapshot, OperatorCommand, RunSnapshot, ServerFrame, SnapshotRecord, WorldChange, WorldEvent } from '../shared/protocol';

export type Connection = 'Connecting' | 'Live' | 'Reconnecting' | 'Offline';
export interface BrowserState {
  snapshot?: RunSnapshot; metrics?: MetricsSnapshot; events: WorldEvent[]; nextBefore?: number;
  connection: Connection; stale: boolean; error?: string; overloaded: boolean; lastFrameAt?: number;
  pending: Record<string, boolean>; commandErrors: Record<string, string>; announcement: string;
  notFound?: boolean;
}
export class APIError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const details = body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' ? body.error : {};
    const message = 'message' in details && typeof details.message === 'string' ? details.message : `Request failed (${response.status})`;
    const code = 'code' in details && typeof details.code === 'string' ? details.code : 'HTTP_ERROR';
    throw new APIError(message, code, response.status);
  }
  return body as T;
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const MAX_SNAPSHOT = 2 * 1024 * 1024;
export type CommandInput = OperatorCommand extends infer C ? C extends OperatorCommand ? Omit<C, 'operationId'> : never : never;
type PendingOperation = { operationId: string; input: CommandInput };

export class MineStore {
  private state: BrowserState = { events: [], connection: 'Connecting', stale: false, overloaded: false, pending: {}, commandErrors: {}, announcement: '' };
  private listeners = new Set<() => void>();
  private renderListeners = new Set<(snapshot: RunSnapshot, connected: boolean) => void>();
  private runId?: string;
  private socket?: WebSocket;
  private stopped = true;
  private reconnectAttempt = 0;
  private loadSequence = 0;
  private reconnectTimer?: number;
  private tickTimer?: number;
  private publishTimer?: number;
  private lastPublish = 0;
  private pollBusy = false;
  private lastPoll = 0;
  private expectedSince?: number;
  private lastPing = 0;
  private needsSnapshot = false;
  private partial?: { id: string; revision: number; count: number; next: number; bytes: number; records: SnapshotRecord[] };
  private operations = new Map<string, PendingOperation>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getState = () => this.state;
  subscribeWorld(listener: (snapshot: RunSnapshot, connected: boolean) => void) {
    this.renderListeners.add(listener);
    if (this.state.snapshot) listener(this.state.snapshot, this.state.connection === 'Live');
    return () => { this.renderListeners.delete(listener); };
  }
  private update(patch: Partial<BrowserState>, immediate = false) {
    this.state = { ...this.state, ...patch };
    const notify = () => { this.publishTimer = undefined; this.lastPublish = performance.now(); for (const listener of this.listeners) listener(); };
    const wait = 250 - (performance.now() - this.lastPublish);
    if (immediate || wait <= 0) { clearTimeout(this.publishTimer); notify(); }
    else if (!this.publishTimer) this.publishTimer = window.setTimeout(notify, wait);
  }
  private publishWorld() {
    if (this.state.snapshot) for (const listener of this.renderListeners) listener(this.state.snapshot, this.state.connection === 'Live');
  }
  start(runId: string) {
    if (!uuidPattern.test(runId)) { this.stop(); this.update({ snapshot: undefined, metrics: undefined, events: [], notFound: true, connection: 'Offline', error: 'Invalid run URL. The run identifier must be a UUID.' }, true); return; }
    if (!this.stopped && this.runId === runId) return;
    this.stop(); this.runId = runId; this.stopped = false; this.reconnectAttempt = 0; this.needsSnapshot = false;
    this.state = { events: [], connection: 'Connecting', stale: false, overloaded: false, pending: {}, commandErrors: {}, announcement: '' };
    this.update({}, true);
    void this.initialLoad();
    this.tickTimer = window.setInterval(() => this.tick(), 500);
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
  }
  stop() {
    this.stopped = true; this.loadSequence++;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.tickTimer);
    this.reconnectTimer = undefined; this.tickTimer = undefined;
    const socket = this.socket; this.socket = undefined; socket?.close(); this.partial = undefined;
    window.removeEventListener('online', this.onOnline); window.removeEventListener('offline', this.onOffline);
  }
  retryConnection() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
    const socket = this.socket; this.socket = undefined; socket?.close();
    this.partial = undefined; this.expectedSince = undefined; this.needsSnapshot = true;
    this.update({ connection: 'Reconnecting', stale: false }); this.publishWorld();
    void this.initialLoad();
  }
  private onOffline = () => { this.socket?.close(); this.disconnected(); };
  private onOnline = () => { if (!this.stopped && (!this.socket || this.socket.readyState > WebSocket.OPEN)) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; if (this.needsSnapshot || !this.state.snapshot) void this.initialLoad(); else this.connect(); } };
  private async initialLoad() {
    const runId = this.runId; const sequence = ++this.loadSequence;
    try {
      const snapshot = await request<RunSnapshot>(`/api/runs/${runId}`);
      if (this.stopped || this.runId !== runId || sequence !== this.loadSequence) return;
      this.install(snapshot); this.needsSnapshot = false; this.connect(); void this.poll();
    } catch (error) {
      if (this.stopped || this.runId !== runId || sequence !== this.loadSequence) return;
      this.update({ error: this.errorText(error), notFound: error instanceof APIError && error.status === 404, overloaded: error instanceof APIError && error.code === 'DO_OVERLOAD', connection: 'Offline' }, true);
      if (!(error instanceof APIError && error.status === 404)) this.scheduleReconnect();
    }
  }
  private connect() {
    if (this.stopped || !this.runId || !navigator.onLine) { this.update({ connection: 'Offline' }); return; }
    this.reconnectTimer = undefined;
    this.update({ connection: this.state.snapshot ? 'Reconnecting' : 'Connecting', stale: false });
    const url = new URL(`/api/runs/${this.runId}/socket`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (this.state.snapshot) url.searchParams.set('after', String(this.state.snapshot.revision));
    const socket = new WebSocket(url); this.socket = socket; this.expectedSince = Date.now();
    socket.onopen = () => { if (socket !== this.socket) return; this.lastPing = Date.now(); socket.send('ping'); this.expectedSince = Date.now(); };
    socket.onmessage = event => {
      if (socket !== this.socket) return;
      try {
        if (typeof event.data !== 'string') throw new Error('Non-text viewer frame');
        if (event.data === 'pong') {
          if (!this.partial) this.expectedSince = undefined;
          this.reconnectAttempt = 0; this.update({ connection: 'Live', stale: false, error: undefined, lastFrameAt: Date.now() }); this.publishWorld(); return;
        }
        if (encoder.encode(event.data).byteLength > 65536) throw new Error('Viewer frame exceeds 64 KiB');
        this.handleFrame(JSON.parse(event.data) as ServerFrame);
        if (socket !== this.socket) return;
        this.update({ connection: 'Live', error: undefined, overloaded: false, lastFrameAt: Date.now() }); this.publishWorld();
      } catch { this.recoverSnapshot(); }
    };
    socket.onclose = () => { if (socket === this.socket) { this.socket = undefined; this.disconnected(); } };
    socket.onerror = () => socket.close();
  }
  private disconnected() {
    if (this.stopped) return;
    this.partial = undefined; this.expectedSince = undefined;
    this.update({ connection: navigator.onLine ? 'Reconnecting' : 'Offline', stale: false }); this.publishWorld(); this.scheduleReconnect();
  }
  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delays = [500, 1000, 2000, 4000, 8000];
    const delay = delays[Math.min(this.reconnectAttempt++, delays.length - 1)] * (0.85 + Math.random() * 0.3);
    this.reconnectTimer = window.setTimeout(() => { this.reconnectTimer = undefined; if (this.state.snapshot && !this.needsSnapshot) this.connect(); else void this.initialLoad(); }, delay);
  }
  private recoverSnapshot() {
    this.partial = undefined; this.expectedSince = undefined;
    const socket = this.socket; this.socket = undefined; socket?.close(1000, 'Snapshot recovery');
    this.update({ connection: 'Reconnecting', stale: false }); this.publishWorld();
    this.needsSnapshot = true; this.scheduleReconnect();
  }
  private ack(revision: number) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'ack', revision })); }
  private handleFrame(frame: ServerFrame) {
    if (!frame || typeof frame !== 'object') throw new Error('Invalid frame');
    if (frame.type === 'snapshot_begin') {
      if (this.partial || typeof frame.snapshotId !== 'string' || !Number.isSafeInteger(frame.revision) || frame.revision < 0 || !Number.isSafeInteger(frame.partCount) || frame.partCount < 1 || frame.partCount > 512) throw new Error('Invalid snapshot header');
      this.partial = { id: frame.snapshotId, revision: frame.revision, count: frame.partCount, next: 0, bytes: 0, records: [] }; this.expectedSince = Date.now(); return;
    }
    if (frame.type === 'snapshot_part') {
      const part = this.partial;
      if (!part || frame.snapshotId !== part.id || frame.index !== part.next || part.next >= part.count || !Array.isArray(frame.payload)) throw new Error('Out-of-order snapshot');
      part.bytes += encoder.encode(JSON.stringify(frame.payload)).byteLength;
      if (part.bytes > MAX_SNAPSHOT) throw new Error('Snapshot exceeds 2 MiB');
      part.records.push(...frame.payload); part.next++; this.expectedSince = Date.now(); return;
    }
    if (frame.type === 'snapshot_end') {
      const part = this.partial;
      if (!part || frame.snapshotId !== part.id || part.next !== part.count) throw new Error('Incomplete snapshot');
      const metadata = part.records.filter(record => record.kind === 'run');
      if (metadata.length !== 1) throw new Error('Invalid snapshot metadata');
      const meta = metadata[0];
      const snapshot: RunSnapshot = { runId: meta.runId, revision: part.revision, serverTime: meta.serverTime, width: meta.width, height: meta.height, run: meta.run, tiles: [], miners: [], actions: [], messages: [] };
      for (const record of part.records) {
        switch (record.kind) {
          case 'run': break;
          case 'tile': snapshot.tiles.push(record.tile); break;
          case 'miner': snapshot.miners.push(record.miner); break;
          case 'action': snapshot.actions.push(record.action); break;
          case 'message': snapshot.messages.push(record.message); break;
          default: throw new Error('Unknown snapshot record');
        }
      }
      this.partial = undefined; this.expectedSince = undefined; this.install(snapshot); this.ack(snapshot.revision); return;
    }
    if (this.partial) throw new Error('Delta during snapshot');
    if (frame.type === 'invalidate') { if (frame.runId !== this.runId) throw new Error('Wrong run'); this.recoverSnapshot(); return; }
    if (frame.type !== 'delta' || frame.runId !== this.runId || !Array.isArray(frame.changes) || !Number.isSafeInteger(frame.fromRevision) || frame.fromRevision < 0 || !Number.isSafeInteger(frame.toRevision) || frame.toRevision < frame.fromRevision || !Number.isFinite(frame.serverTime)) throw new Error('Invalid delta');
    const current = this.state.snapshot;
    if (!current) throw new Error('Delta without baseline');
    if (frame.fromRevision === current.revision && frame.toRevision === current.revision && frame.changes.length === 0) {
      this.expectedSince = undefined; this.install({ ...current, serverTime: frame.serverTime }); this.ack(current.revision); return;
    }
    if (frame.toRevision <= current.revision) { this.ack(current.revision); return; }
    if (frame.fromRevision !== current.revision) throw new Error('Revision gap');
    const next = applyChanges(current, frame.changes, frame.toRevision, frame.serverTime);
    this.expectedSince = undefined; this.install(next); this.ack(next.revision);
  }
  private install(snapshot: RunSnapshot) {
    if (snapshot.runId !== this.runId || snapshot.run.runId !== this.runId || snapshot.run.revision !== snapshot.revision || !Number.isFinite(snapshot.serverTime) || snapshot.width !== 96 || snapshot.height !== 64) throw new Error('Snapshot identity mismatch');
    if (encoder.encode(JSON.stringify(snapshot)).byteLength > MAX_SNAPSHOT) throw new Error('Snapshot exceeds 2 MiB');
    if (this.state.snapshot && snapshot.revision < this.state.snapshot.revision) return;
    this.update({ snapshot, notFound: false }); this.publishWorld();
  }
  private tick() {
    if (this.stopped || this.state.notFound) return;
    const now = Date.now();
    const stale = this.expectedSince !== undefined && now - this.expectedSince > 3000;
    if (stale !== this.state.stale) this.update({ stale });
    if (this.expectedSince !== undefined && now - this.expectedSince > 10000) { this.socket?.close(); return; }
    if (this.socket?.readyState === WebSocket.OPEN && !this.partial && now - this.lastPing >= 10000) { this.socket.send('ping'); this.expectedSince = now; this.lastPing = now; }
    if (now - this.lastPoll >= 2000 && navigator.onLine) void this.poll();
  }
  async poll() {
    if (!this.runId || this.pollBusy) return;
    this.pollBusy = true; this.lastPoll = Date.now(); const runId = this.runId;
    const [metrics, events] = await Promise.allSettled([request<MetricsSnapshot>(`/api/runs/${runId}/metrics`), request<EventPage>(`/api/runs/${runId}/events?limit=100`)]);
    if (!this.stopped && runId === this.runId) {
      if (metrics.status === 'fulfilled') this.update({ metrics: metrics.value });
      if (events.status === 'fulfilled') {
        const merged = new Map(this.state.events.map(event => [event.revision, event]));
        for (const event of events.value.events) merged.set(event.revision, event);
        const list = [...merged.values()].sort((a, b) => b.revision - a.revision).slice(0, 200);
        const nextBefore = list.length ? list[list.length - 1].revision : events.value.nextBefore;
        this.update({ events: list, nextBefore: nextBefore && nextBefore > events.value.oldestAvailableRevision ? nextBefore : undefined });
      }
      for (const result of [metrics, events]) if (result.status === 'rejected' && result.reason instanceof APIError && result.reason.code === 'DO_OVERLOAD') this.update({ overloaded: true });
    }
    this.pollBusy = false;
  }
  async olderEvents(before: number): Promise<EventPage> {
    if (!this.runId) throw new Error('No run selected.');
    return request<EventPage>(`/api/runs/${this.runId}/events?before=${before}&limit=100`);
  }
  private errorText(error: unknown) { return error instanceof Error ? error.message : 'The request could not be completed.'; }
  pendingCommand(key: string): CommandInput | undefined {
    const storageKey = `coal-garden:${this.runId}:${key}`;
    const operation = this.operations.get(storageKey);
    if (operation) return operation.input;
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) return (JSON.parse(saved) as PendingOperation).input;
    } catch { /* In-memory retries remain available when browser storage is disabled. */ }
    return undefined;
  }
  private operation(key: string, input: CommandInput): PendingOperation {
    const storageKey = `coal-garden:${this.runId}:${key}`;
    let operation = this.operations.get(storageKey);
    if (!operation) {
      try { const stored = sessionStorage.getItem(storageKey); if (stored) operation = JSON.parse(stored) as PendingOperation; } catch { /* Storage may be disabled. In-memory retries remain stable. */ }
    }
    if (!operation) { operation = { operationId: crypto.randomUUID(), input }; }
    this.operations.set(storageKey, operation);
    try { sessionStorage.setItem(storageKey, JSON.stringify(operation)); } catch { /* Keep the in-memory operation. */ }
    return operation;
  }
  async command(key: string, input: CommandInput): Promise<CommandReceipt> {
    if (!this.runId || this.state.connection !== 'Live' || !navigator.onLine) throw new Error('Reconnect before changing the mine.');
    if (this.state.pending[key]) throw new Error('This control already has a pending request.');
    const storageKey = `coal-garden:${this.runId}:${key}`;
    const operation = this.operation(key, input);
    this.update({ pending: { ...this.state.pending, [key]: true }, commandErrors: { ...this.state.commandErrors, [key]: '' } }, true);
    try {
      const receipt = await request<CommandReceipt>(`/api/runs/${this.runId}/commands`, { method: 'POST', body: JSON.stringify({ ...operation.input, operationId: operation.operationId }) });
      this.operations.delete(storageKey); try { sessionStorage.removeItem(storageKey); } catch { /* No persistent storage. */ }
      this.update({ announcement: `${operation.input.type.replaceAll('_', ' ')} acknowledged at revision ${receipt.revision}.`, overloaded: false });
      void this.poll(); return receipt;
    } catch (error) {
      this.update({ commandErrors: { ...this.state.commandErrors, [key]: `${this.errorText(error)} Retry retains the original ${operation.input.type.replaceAll('_', ' ')} command ID.` }, overloaded: this.state.overloaded || error instanceof APIError && error.code === 'DO_OVERLOAD' }); throw error;
    } finally { this.update({ pending: { ...this.state.pending, [key]: false } }); }
  }
}

export function applyChanges(snapshot: RunSnapshot, changes: WorldChange[], revision: number, serverTime: number): RunSnapshot {
  const tiles = new Map(snapshot.tiles.map(tile => [tile.key, tile]));
  const miners = new Map(snapshot.miners.map(miner => [miner.agentId, miner]));
  const actions = new Map(snapshot.actions.map(action => [action.actionId, action]));
  const messages = new Map(snapshot.messages.map(message => [message.sequence, message]));
  let run = snapshot.run;
  for (const change of changes) {
    switch (change.kind) {
      case 'tile_upsert': tiles.set(change.tile.key, change.tile); break;
      case 'miner_upsert': miners.set(change.miner.agentId, change.miner); break;
      case 'action_upsert': actions.set(change.action.actionId, change.action); break;
      case 'message_append': messages.set(change.message.sequence, change.message); break;
      case 'run_update': run = change.run; break;
      default: throw new Error('Unknown world change');
    }
  }
  return { ...snapshot, revision, serverTime, run: { ...run, revision }, tiles: [...tiles.values()], miners: [...miners.values()], actions: [...actions.values()].filter(action => action.status === 'accepted'), messages: [...messages.values()].slice(-200) };
}
export const mineStore = new MineStore();

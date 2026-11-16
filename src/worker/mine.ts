import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { initializeSchema, MetricsStore } from './storage';
import { generateWorld, tileKey, findPath, isExhausted, manhattan, projectKnowledge, reveal } from '../shared/world';
import { ALLOWANCE_MICRO_USD, HOPPER, INVENTORY_CAPACITY, MAX_IN_FLIGHT, RESERVATION_MICRO_USD, RESOURCE_VALUES, WORLD_WIDTH, WORLD_HEIGHT, PublicError, type CommandReceipt, type CoordinationMessage, type EventPage, type NoticeReason, type OperatorCommand, type PhysicalAction, type PublicMiner, type RunRecord, type RunSnapshot, type RuntimePolicy, type Tile, type WorldChange, type WorldEvent } from '../shared/protocol';
import type { Observation, ToolArguments, ToolEnvelope, ToolError, ToolResult } from '../shared/protocol';
import type { DecisionRequest, DecisionQueueReceipt, InferenceClaim, InferenceClaimResult, InferenceGrant, InferenceSettlement, MinerReport } from '../shared/protocol';
import type { DeltaFrame, MetricsSnapshot, MinerNotice, MinerState, ServerFrame, SnapshotRecord } from '../shared/protocol';
export type { RuntimePolicy } from '../shared/protocol';
type Row = Record<string, SqlStorageValue>;
interface Delivery { miner_id: string; desired_revision: number; reasons: string; next_attempt_at: number; attempt_count: number; created_at: number; grant: string | null }
interface ModelCall { grant_id: string; invocation_id: string | null; miner_id: string; generation: number; burst_id: string; created_at: number; claimed_at: number | null; expires_at: number; state: 'granted' | 'claimed' | 'unknown' | 'settled' | 'unused'; reservation: number; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; charged: number; settlement: string | null }
interface DecisionRow { miner_id: string; generation: number; burst_id: string; eligible_at: number; ordinal: number; queued_at: number }
interface PendingDelivery { row: Delivery; notice: MinerNotice; leaseUntil: number }
interface DeliveryOutcome { delivery: PendingDelivery; revision?: number; error?: string; overloaded?: boolean }
interface ViewerState { runId: string; revision: number; pending: boolean; pendingRevision?: number; sentAt?: number; closed?: boolean }
interface ViewerBatch { frames: string[]; revision: number }
interface ViewerSend { socket: WebSocket; state: ViewerState; batch: ViewerBatch }
const FRAME_BYTES = 65_536;
const SNAPSHOT_BYTES = 2 * 1024 * 1024;
const VIEWER_ACK_MS = 5_000;
const encoder = new TextEncoder();

/** The only writer of shared world records. No external I/O occurs inside mutate(). */
export class Mine extends DurableObject<Env> {
  protected readonly metrics: MetricsStore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.transactionSync(() => initializeSchema(ctx.storage.sql));
    this.metrics = new MetricsStore(ctx.storage.sql);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  // Qwen's standard text-generation quota is 300 RPM; retain 20% headroom.
  protected runtimePolicy(): RuntimePolicy { return { providerMode: 'live', defaultRPM: 240, maxInFlight: MAX_IN_FLIGHT, reservationMicroUSD: RESERVATION_MICRO_USD }; }
  private rows<T = Row>(query: string, ...bindings: SqlStorageValue[]): T[] {
    const cursor = this.ctx.storage.sql.exec(query, ...bindings);
    const result = cursor.toArray() as T[];
    // Cursor counters exclude these two bookkeeping statements to avoid recursion.
    this.metrics.increment('sqlRowsRead', cursor.rowsRead);
    this.metrics.increment('sqlRowsWritten', cursor.rowsWritten);
    return result;
  }
  private execute(query: string, ...bindings: SqlStorageValue[]): void { this.rows(query, ...bindings); }
  private jsonRecord<T>(query: string, ...bindings: SqlStorageValue[]): T | undefined {
    const row = this.rows<{ data: string }>(query, ...bindings)[0];
    return row ? JSON.parse(row.data) as T : undefined;
  }
  private run(): RunRecord {
    const run = this.jsonRecord<RunRecord>('SELECT data FROM cg_run WHERE id=1');
    if (!run) throw new PublicError('RUN_NOT_FOUND', 'This mine does not exist.', 404);
    return run;
  }
  private saveRun(run: RunRecord): void { this.execute('INSERT INTO cg_run(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', JSON.stringify(run)); }
  private tiles(): Tile[] { return this.rows<{ key: number; x: number; y: number; terrain: Tile['terrain']; visible: number; available: number; reserved: number }>('SELECT * FROM cg_tiles ORDER BY key').map(t => ({ ...t, visible: t.visible === 1 })); }
  private tile(key: number): Tile | undefined {
    const row = this.rows<{ key: number; x: number; y: number; terrain: Tile['terrain']; visible: number; available: number; reserved: number }>('SELECT * FROM cg_tiles WHERE key=?', key)[0];
    return row ? { ...row, visible: row.visible === 1 } : undefined;
  }
  private saveTile(tile: Tile): void {
    this.execute('INSERT INTO cg_tiles(key,x,y,terrain,visible,available,reserved) VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET terrain=excluded.terrain,visible=excluded.visible,available=excluded.available,reserved=excluded.reserved', tile.key, tile.x, tile.y, tile.terrain, Number(tile.visible), tile.available, tile.reserved);
  }
  private miner(agentId: string): PublicMiner {
    const miner = this.jsonRecord<PublicMiner>('SELECT data FROM cg_miners WHERE agent_id=?', agentId);
    if (!miner) throw new PublicError('MINER_NOT_FOUND', 'This miner does not exist.', 404);
    return miner;
  }
  private miners(): PublicMiner[] { return this.rows<{ data: string }>('SELECT data FROM cg_miners ORDER BY CAST(agent_id AS INTEGER)').map(r => JSON.parse(r.data) as PublicMiner); }
  private saveMiner(miner: PublicMiner): void { this.execute('INSERT INTO cg_miners(agent_id,data) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET data=excluded.data', miner.agentId, JSON.stringify(miner)); }
  private action(id: string): PhysicalAction | undefined { return this.jsonRecord<PhysicalAction>('SELECT data FROM cg_actions WHERE action_id=?', id); }
  private saveAction(action: PhysicalAction): void {
    this.execute('INSERT INTO cg_actions(action_id,effect_id,agent_id,kind,generation,target_key,ends_at,status,data) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(action_id) DO UPDATE SET ends_at=excluded.ends_at,status=excluded.status,data=excluded.data', action.actionId, action.effectId, action.agentId, action.kind, action.generation, tileKey(action.target.x, action.target.y), action.endsAt, action.status, JSON.stringify(action));
  }
  private activeActions(): PhysicalAction[] { return this.rows<{ data: string }>("SELECT data FROM cg_actions WHERE status='accepted' ORDER BY ends_at,action_id").map(r => JSON.parse(r.data) as PhysicalAction); }
  private publicTile(tile: Tile): Tile { return tile.visible ? tile : { key: tile.key, x: tile.x, y: tile.y, terrain: 'rock', visible: false, available: 0, reserved: 0 }; }
  private publicMiner(miner: PublicMiner): PublicMiner { return { ...miner, lastTools: [] }; }
  private messages(limit = 200): CoordinationMessage[] {
    return this.rows<{ sequence: number; sender: string; audience: 'mine' | 'agent'; recipient: string | null; body: string; at_key: number | null; revision: number; timestamp: number }>('SELECT * FROM cg_messages ORDER BY sequence DESC LIMIT ?', limit).reverse().map(m => ({ sequence: m.sequence, sender: m.sender, audience: m.audience, ...(m.recipient ? { agentId: m.recipient } : {}), body: m.body, ...(m.at_key !== null ? { at: { x: m.at_key % WORLD_WIDTH, y: Math.floor(m.at_key / WORLD_WIDTH) } } : {}), revision: m.revision, timestamp: m.timestamp }));
  }
  private snapshot(run: RunRecord): RunSnapshot {
    const actions = this.activeActions();
    const claims = new Map(actions.filter(a => a.kind === 'mine').map(a => [tileKey(a.target.x, a.target.y), a.agentId]));
    return { runId: run.runId, revision: run.revision, serverTime: Date.now(), width: WORLD_WIDTH, height: WORLD_HEIGHT, run, tiles: this.tiles().map(t => ({ ...this.publicTile(t), ...(claims.has(t.key) ? { claimant: claims.get(t.key) } : {}) })), miners: this.miners().map(miner => this.publicMiner(miner)), actions, messages: this.messages() };
  }
  private earliestDeadline(run: RunRecord): number | undefined {
    const deadlines: number[] = [];
    if (run.mode === 'running') {
      const action = this.rows<{ deadline: number | null }>("SELECT MIN(ends_at) AS deadline FROM cg_actions WHERE status='accepted'")[0]?.deadline;
      if (action != null) deadlines.push(action);
    }
    if (run.mode !== 'capacity_paused') {
      const delivery = this.rows<{ deadline: number | null }>('SELECT MIN(next_attempt_at) AS deadline FROM cg_deliveries')[0]?.deadline;
      if (delivery != null) deadlines.push(delivery);
    }
    const expiry = this.rows<{ deadline: number | null }>("SELECT MIN(expires_at) AS deadline FROM cg_model_calls WHERE state IN ('granted','claimed') OR (state='unknown' AND expires_at>?)", Date.now())[0]?.deadline;
    if (expiry != null) deadlines.push(expiry);
    if (run.flushAt !== undefined) deadlines.push(run.flushAt);
    if (run.sweepAt !== undefined && run.mode !== 'capacity_paused') deadlines.push(run.sweepAt);
    for (const socket of this.ctx.getWebSockets()) {
      const viewer = this.viewerState(socket);
      if (viewer?.pending && !viewer.closed && viewer.sentAt !== undefined) deadlines.push(viewer.sentAt + VIEWER_ACK_MS);
    }
    if (run.mode === 'running' && !run.exhausted && !this.rows("SELECT grant_id FROM cg_model_calls WHERE state='granted' LIMIT 1").length && this.occupiedSlots(Date.now()) < run.maxInFlight) {
      const head = this.rows<{ eligible_at: number }>("SELECT q.eligible_at FROM cg_model_queue q JOIN cg_miners m ON q.miner_id=m.agent_id WHERE q.generation=? AND json_extract(m.data,'$.retired')=0 AND json_extract(m.data,'$.activeAction') IS NULL ORDER BY q.eligible_at,q.ordinal LIMIT 1", run.generation)[0];
      if (head) deadlines.push(Math.max(head.eligible_at, run.nextStartAt, this.rollingStartAt(run, Date.now())));
    }
    return deadlines.length ? Math.min(...deadlines) : undefined;
  }
  private async mutate<T>(change: (run: RunRecord) => T): Promise<T> {
    try {
      return await this.ctx.storage.transaction(async () => {
        const run = this.run();
        const previousRevision = run.revision;
        const policy = this.runtimePolicy();
        if (run.verifiedModelRPM === undefined && (run.effectiveRPM !== policy.defaultRPM || run.maxInFlight !== policy.maxInFlight)) {
          run.effectiveRPM = policy.defaultRPM;
          run.maxInFlight = policy.maxInFlight;
          this.event(run, 'control', 'Default inference limits updated', [{ kind: 'run_update', run: { ...run } }]);
        }
        const result = change(run);
        run.nextAlarmAt = this.earliestDeadline(run);
        if (run.revision !== previousRevision) this.completeEventProjection(run, previousRevision);
        this.saveRun(run);
        if (run.nextAlarmAt !== undefined) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, run.nextAlarmAt));
        else await this.ctx.storage.deleteAlarm();
        return result;
      });
    } catch (error) {
      if (error instanceof Error && ['COAL_RESOURCE_INVARIANT', 'DIAMOND_RESOURCE_INVARIANT', 'RESOURCE_TILE_INVARIANT', 'INVENTORY_RESOURCE_INVARIANT'].includes(error.message)) {
        // The failed world transaction rolled back; keep its failure evidence separately.
        await this.ctx.storage.transaction(async () => { this.metrics.increment('invariantFailures'); });
      }
      throw error;
    }
  }
  private event(run: RunRecord, type: WorldEvent['type'], summary: string, changes: WorldChange[] = [], extra: Pick<WorldEvent, 'agentId' | 'at' | 'detail'> = {}): number {
    run.revision++;
    const event: WorldEvent = { revision: run.revision, timestamp: Date.now(), type, summary, ...extra, changes: changes.map(change => change.kind === 'miner_upsert' ? { kind: 'miner_upsert', miner: this.publicMiner(change.miner) } : change) };
    // Transactions larger than one frame are invalidations, never partial patches.
    if (new TextEncoder().encode(JSON.stringify(event)).length > 60_000) { event.changes = []; event.invalidation = true; }
    this.execute('INSERT INTO cg_events(revision,timestamp,type,data) VALUES(?,?,?,?)', event.revision, event.timestamp, type, JSON.stringify(event));
    this.execute('DELETE FROM cg_events WHERE revision<=?', run.revision - 10_000);
    run.flushAt = Math.min(run.flushAt ?? Infinity, Date.now() + 250);
    if (type !== 'observation' && (type !== 'message' || changes.some(change => change.kind === 'message_append' && change.message.audience === 'mine'))) run.sweepAt ??= Date.now() + 5_000;
    return run.revision;
  }
  private completeEventProjection(run: RunRecord, afterRevision: number): void {
    const row = this.rows<{ data: string }>('SELECT data FROM cg_events WHERE revision=?', run.revision)[0];
    if (!row) return;
    const event = JSON.parse(row.data) as WorldEvent;
    if (event.invalidation) return;
    event.changes = event.changes.filter(change => change.kind !== 'run_update' && change.kind !== 'miner_upsert');
    const touched = new Set<string>();
    for (const row of this.rows<{ data: string }>('SELECT data FROM cg_events WHERE revision>? ORDER BY revision', afterRevision)) {
      const changed = JSON.parse(row.data) as WorldEvent;
      if (changed.agentId) touched.add(changed.agentId);
      for (const change of changed.changes) if (change.kind === 'miner_upsert') touched.add(change.miner.agentId);
    }
    for (const agentId of touched) {
      const miner = this.jsonRecord<PublicMiner>('SELECT data FROM cg_miners WHERE agent_id=?', agentId);
      if (miner) event.changes.push({ kind: 'miner_upsert', miner: this.publicMiner(miner) });
    }
    event.changes.push({ kind: 'run_update', run: { ...run } });
    if (encoder.encode(JSON.stringify(event)).length > 60_000) { event.changes = []; event.invalidation = true; }
    this.execute('UPDATE cg_events SET data=? WHERE revision=?', JSON.stringify(event), run.revision);
  }
  private receipt<T>(operationId: string, fingerprint: string): T | undefined {
    const row = this.rows<{ fingerprint: string; result: string }>('SELECT fingerprint,result FROM cg_receipts WHERE operation_id=?', operationId)[0];
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new PublicError('OPERATION_CONFLICT', 'This operation ID has another request.', 409, operationId);
    this.metrics.increment('receiptReplays');
    return JSON.parse(row.result) as T;
  }
  private saveReceipt(operationId: string, fingerprint: string, result: unknown): void { this.execute('INSERT INTO cg_receipts(operation_id,fingerprint,result) VALUES(?,?,?)', operationId, fingerprint, JSON.stringify(result)); }
  private deliver(run: RunRecord, agentId: string, reasons: NoticeReason[], time = Date.now(), grant?: unknown): void {
    const previous = this.rows<Delivery>('SELECT * FROM cg_deliveries WHERE miner_id=?', agentId)[0];
    const merged = [...new Set<NoticeReason>([...(previous ? JSON.parse(previous.reasons) as NoticeReason[] : []), ...reasons])];
    const urgent = reasons.some(reason => reason !== 'world_changed');
    const nextAttempt = previous && previous.attempt_count > 0 && !urgent ? previous.next_attempt_at : Math.min(previous?.next_attempt_at ?? Infinity, time);
    this.execute('INSERT INTO cg_deliveries(miner_id,desired_revision,reasons,next_attempt_at,attempt_count,created_at,grant) VALUES(?,?,?,?,0,?,?) ON CONFLICT(miner_id) DO UPDATE SET desired_revision=MAX(desired_revision,excluded.desired_revision),reasons=excluded.reasons,next_attempt_at=excluded.next_attempt_at,grant=COALESCE(excluded.grant,grant)', agentId, run.revision, JSON.stringify(merged), nextAttempt, previous?.created_at ?? Date.now(), grant ? JSON.stringify(grant) : null);
  }
  private clearGrantDeliveries(agentId?: string): void {
    const rows = agentId === undefined ? this.rows<Delivery>('SELECT * FROM cg_deliveries WHERE grant IS NOT NULL') : this.rows<Delivery>('SELECT * FROM cg_deliveries WHERE miner_id=? AND grant IS NOT NULL', agentId);
    for (const row of rows) {
      const reasons = (JSON.parse(row.reasons) as NoticeReason[]).filter(reason => reason !== 'grant_available');
      if (reasons.length) this.execute('UPDATE cg_deliveries SET grant=NULL,reasons=? WHERE miner_id=?', JSON.stringify(reasons), row.miner_id);
      else this.execute('DELETE FROM cg_deliveries WHERE miner_id=?', row.miner_id);
    }
  }
  private finishDue(run: RunRecord, at: number, limit = 100): void {
    const due = this.rows<{ data: string }>("SELECT data FROM cg_actions WHERE status='accepted' AND ends_at<=? ORDER BY ends_at,action_id LIMIT ?", at, limit);
    for (const row of due) {
      const action = JSON.parse(row.data) as PhysicalAction;
      const miner = this.miner(action.agentId);
      if (action.kind === 'mine') {
        const resource = action.resource ?? 'coal';
        action.resource = resource;
        const tile = this.tile(tileKey(action.target.x, action.target.y))!;
        tile.reserved -= action.quantity;
        if (resource === 'diamond') {
          run.reservedDiamonds -= action.quantity;
          run.minedDiamonds += action.quantity;
          miner.diamonds += action.quantity;
          miner.inventory.diamonds += action.quantity;
        } else {
          run.reservedCoal -= action.quantity;
          run.minedCoal += action.quantity;
          miner.coal += action.quantity;
          miner.inventory.coal += action.quantity;
        }
        if (tile.available === 0 && tile.reserved === 0) tile.terrain = 'floor';
        this.saveTile(tile);
        this.metrics.sample({ [resource === 'diamond' ? 'diamonds' : 'coal']: action.quantity, value: action.quantity * RESOURCE_VALUES[resource] }, at);
        action.result = { mined: action.quantity, resource };
      } else {
        miner.x = action.target.x; miner.y = action.target.y;
        action.result = { position: action.target };
      }
      action.status = 'completed';
      miner.activeAction = undefined;
      miner.state = miner.retired ? 'retired' : run.mode === 'running' ? 'idle' : 'paused';
      this.saveAction(action); this.saveMiner(miner);
      const changes: WorldChange[] = [{ kind: 'action_upsert', action }, { kind: 'miner_upsert', miner }];
      if (action.kind === 'mine') changes.push({ kind: 'tile_upsert', tile: this.tile(tileKey(action.target.x, action.target.y))! });
      this.event(run, 'action', action.kind === 'mine' ? `Miner ${miner.agentId} extracted ${action.quantity} ${action.resource}` : `Miner ${miner.agentId} reached (${miner.x}, ${miner.y})`, changes, { agentId: miner.agentId, at: action.target, detail: { actionId: action.actionId, completed: true, tool: action.kind, ...(action.kind === 'mine' ? { resource: action.resource!, mined: action.quantity, value: action.quantity * RESOURCE_VALUES[action.resource!] } : {}) } });
      this.metrics.histogram('actionLateness', Math.max(0, at - action.endsAt));
      this.deliver(run, miner.agentId, ['action_completed']);
    }
    if (due.length) this.assertResources(run);
  }
  private cancelAction(run: RunRecord, miner: PublicMiner): void {
    if (!miner.activeAction) return;
    const action = this.action(miner.activeAction);
    if (action?.status === 'accepted') {
      if (action.kind === 'mine') {
        const resource = action.resource ?? 'coal';
        action.resource = resource;
        const tile = this.tile(tileKey(action.target.x, action.target.y))!;
        tile.reserved -= action.quantity; tile.available += action.quantity;
        if (resource === 'diamond') {
          run.reservedDiamonds -= action.quantity; run.availableDiamonds += action.quantity;
        } else {
          run.reservedCoal -= action.quantity; run.availableCoal += action.quantity;
        }
        this.saveTile(tile);
      }
      action.status = 'cancelled'; action.result = { cancelled: true, ...(action.kind === 'mine' ? { resource: action.resource! } : {}) };
      this.saveAction(action);
      this.metrics.increment('actionCancellations');
      const changes: WorldChange[] = [{ kind: 'action_upsert', action }];
      if (action.kind === 'mine') changes.push({ kind: 'tile_upsert', tile: this.tile(tileKey(action.target.x, action.target.y))! });
      this.event(run, 'action', `Miner ${miner.agentId} ${action.resource ?? 'walk'} action cancelled`, changes, { agentId: miner.agentId, at: action.target, detail: { actionId: action.actionId, cancelled: true, tool: action.kind, ...(action.resource ? { resource: action.resource } : {}) } });
    }
    miner.activeAction = undefined;
  }
  private freeze(run: RunRecord, mode: RunRecord['mode'], cause?: string): void {
    const now = Date.now();
    if (run.mode === 'running') {
      // All effects already due precede the generation fence, even above one alarm batch.
      while (this.rows<{ n: number }>("SELECT COUNT(*) n FROM cg_actions WHERE status='accepted' AND ends_at<=?", now)[0].n) this.finishDue(run, now);
      run.elapsedRunningMs += now - (run.runningSince ?? now);
      run.runningSince = undefined;
      run.pausedAt = now;
    }
    run.pausedAt ??= now;
    run.mode = mode; run.cause = cause; run.generation++;
    this.execute('DELETE FROM cg_model_queue');
    this.execute("UPDATE cg_model_calls SET state='unused' WHERE state='granted'");
    this.clearGrantDeliveries();
    this.recountBudget(run);
  }
  private recountBudget(run: RunRecord): void {
    const row = this.rows<{ reserved: number; unknown: number; charged: number }>("SELECT COALESCE(SUM(CASE WHEN state IN ('granted','claimed') THEN reservation ELSE 0 END),0) reserved, COALESCE(SUM(CASE WHEN state='unknown' THEN reservation ELSE 0 END),0) unknown, COALESCE(SUM(charged),0) charged FROM cg_model_calls")[0];
    run.reservedMicroUSD = row.reserved; run.unknownMicroUSD = row.unknown; run.observedMicroUSD = row.charged;
  }
  private controlNotice(run: RunRecord): void {
    for (const miner of this.miners()) {
      if (!miner.retired) miner.state = run.exhausted && !miner.activeAction ? 'idle' : !miner.provisioned ? 'provisioning' : run.mode !== 'running' ? 'paused' : miner.activeAction ? this.action(miner.activeAction)!.kind === 'mine' ? 'mining' : 'walking' : 'idle';
      this.saveMiner(miner);
      this.deliver(run, miner.agentId, ['control_changed']);
    }
    // A large control transition uses snapshot recovery, not a partial transaction.
    this.event(run, 'control', run.cause ?? `Run ${run.mode}`, [{ kind: 'run_update', run: { ...run } }, ...this.miners().map(miner => ({ kind: 'miner_upsert' as const, miner })), ...this.activeActions().map(action => ({ kind: 'action_upsert' as const, action }))]);
    this.execute('UPDATE cg_deliveries SET desired_revision=?', run.revision);
  }
  async initialize(input: { runId: string; seed: number }): Promise<RunSnapshot> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.runId) || !Number.isInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff) throw new PublicError('INVALID_ARGUMENT', 'Use a UUID and an unsigned 32-bit seed.');
    let created: RunSnapshot | undefined;
    this.ctx.storage.transactionSync(() => {
      const existing = this.jsonRecord<RunRecord>('SELECT data FROM cg_run WHERE id=1');
      if (existing) {
        if (existing.runId !== input.runId || existing.seed !== input.seed) throw new PublicError('OPERATION_CONFLICT', 'The immutable mine identity or seed differs.', 409);
        return;
      }
      const policy = this.runtimePolicy();
      const tiles = generateWorld(input.seed);
      const initialCoal = tiles.reduce((total, t) => total + (t.terrain === 'coal' ? t.available : 0), 0);
      const initialDiamonds = tiles.reduce((total, t) => total + (t.terrain === 'diamond' ? t.available : 0), 0);
      for (const tile of tiles) this.saveTile(tile);
      this.saveRun({ ...input, mode: 'paused', revision: 0, generation: 0, createdAt: Date.now(), pausedAt: Date.now(), elapsedRunningMs: 0, initialCoal, minedCoal: 0, availableCoal: initialCoal, reservedCoal: 0, initialDiamonds, minedDiamonds: 0, availableDiamonds: initialDiamonds, reservedDiamonds: 0, hopper: { ...HOPPER, coal: 0, diamonds: 0 }, allowanceMicroUSD: ALLOWANCE_MICRO_USD, observedMicroUSD: 0, reservedMicroUSD: 0, unknownMicroUSD: 0, effectiveRPM: policy.defaultRPM, maxInFlight: policy.maxInFlight, nextStartAt: 0, exhausted: false, providerMode: policy.providerMode, nextAgentOrdinal: 1 });
      created = this.snapshot(this.run());
      this.saveReceipt(`create:${input.runId}`, canonical(input), created);
    });
    return this.mutate(() => {
      const original = created ?? this.receipt<RunSnapshot>(`create:${input.runId}`, canonical(input));
      if (!original) throw new Error('CREATION_RECEIPT_MISSING');
      return original;
    });
  }
  async getSnapshot(): Promise<RunSnapshot> { return this.mutate(run => this.snapshot(run)); }
  async getMetrics(): Promise<MetricsSnapshot> {
    return this.mutate(run => {
      const now = Date.now(), miners = this.miners(), counters = this.metrics.counters();
      const states: Record<MinerState, number> = { provisioning: 0, queued: 0, thinking: 0, walking: 0, mining: 0, idle: 0, paused: 0, error: 0, retired: 0 };
      let provisioned = 0, retired = 0, real = 0, validated = 0, inputTokens = 0, outputTokens = 0;
      for (const miner of miners) { states[miner.state]++; provisioned += Number(miner.provisioned); retired += Number(miner.retired); real += Number(miner.realResponses > 0); validated += Number(miner.validatedTools > 0); inputTokens += miner.inputTokens; outputTokens += miner.outputTokens; }
      const ledger = this.rows<{ recent: number; in_flight: number; unclaimed: number }>("SELECT COALESCE(SUM(CASE WHEN claimed_at>? THEN 1 ELSE 0 END),0) recent,COALESCE(SUM(CASE WHEN state='claimed' OR (state='unknown' AND expires_at>?) THEN 1 ELSE 0 END),0) in_flight,COALESCE(SUM(CASE WHEN state='granted' THEN 1 ELSE 0 END),0) unclaimed FROM cg_model_calls", now - 60000, now)[0];
      const deliveries = this.rows<{ n: number; oldest: number | null }>('SELECT COUNT(*) n,MIN(created_at) oldest FROM cg_deliveries')[0];
      const due = this.rows<{ n: number; oldest: number | null }>("SELECT COUNT(*) n,MIN(ends_at) oldest FROM cg_actions WHERE status='accepted' AND ends_at<=?", now)[0];
      let viewerLag = 0, oldestViewerAckMs = 0;
      for (const socket of this.ctx.getWebSockets()) { const state = this.viewerState(socket); if (!state || state.closed) continue; viewerLag = Math.max(viewerLag, run.revision - state.revision); if (state.sentAt !== undefined) oldestViewerAckMs = Math.max(oldestViewerAckMs, now - state.sentAt); }
      const runningMs = run.elapsedRunningMs + (run.mode === 'running' ? now - (run.runningSince ?? now) : 0);
      const value = run.minedCoal * RESOURCE_VALUES.coal + run.minedDiamonds * RESOURCE_VALUES.diamond;
      return { runId: run.runId, serverTime: now, providerMode: run.providerMode, model: '@cf/qwen/qwen3.8-27b', seed: run.seed, mode: run.mode, cause: run.cause,
        retained: miners.length, provisioned, retired, agentsWithRealInference: real, agentsWithValidatedTools: validated, states,
        modelCallsPerMinute: ledger.recent, modelCallsTotal: counters.modelCallsTotal ?? 0, inFlight: ledger.in_flight, unclaimed: ledger.unclaimed,
        effectiveRPM: run.effectiveRPM, verifiedModelRPM: run.verifiedModelRPM, maxInFlight: run.maxInFlight, coal: run.minedCoal, initialCoal: run.initialCoal, availableCoal: run.availableCoal, reservedCoal: run.reservedCoal, coalPerMinute: runningMs > 0 ? run.minedCoal * 60000 / runningMs : 0,
        diamonds: run.minedDiamonds, initialDiamonds: run.initialDiamonds, availableDiamonds: run.availableDiamonds, reservedDiamonds: run.reservedDiamonds, value, valuePerMinute: runningMs > 0 ? value * 60000 / runningMs : 0,
        inputTokens, outputTokens, observedMicroUSD: run.observedMicroUSD, reservedMicroUSD: run.reservedMicroUSD, unknownMicroUSD: run.unknownMicroUSD, allowanceMicroUSD: run.allowanceMicroUSD,
        deliveryBacklog: deliveries.n, oldestDeliveryAgeMs: deliveries.oldest === null ? 0 : now - deliveries.oldest, viewerLag, oldestViewerAckMs, viewerResyncs: counters.viewerResyncs ?? 0,
        receiptReplays: counters.receiptReplays ?? 0, rejectedClaims: counters.admissionRejected ?? 0, actionCancellations: counters.actionCancellations ?? 0, restarts: counters.restarts ?? 0, invariantFailures: counters.invariantFailures ?? 0,
        dueActions: run.mode === 'running' ? due.n : 0, oldestActionLatenessMs: run.mode === 'running' && due.oldest !== null ? now - due.oldest : 0, sqlDatabaseSize: this.ctx.storage.sql.databaseSize, sqlRowsRead: counters.sqlRowsRead ?? 0, sqlRowsWritten: counters.sqlRowsWritten ?? 0,
        worldRPC: this.metrics.summary('worldRPC'), queueWait: this.metrics.summary('queueWait'), inferenceLatency: this.metrics.summary('inferenceLatency'), actionLateness: this.metrics.summary('actionLateness'), deliverySweep: this.metrics.summary('deliverySweep'), errors: Object.fromEntries(Object.entries(counters).filter(([key]) => key.startsWith('error:')).map(([key,value]) => [key.slice(6), value])), cumulative: counters, buckets: this.metrics.recentSamples(now), cpu: 'unavailable', memory: 'unavailable' };
    });
  }
  async getEvents(input: { before?: number; limit: number }): Promise<EventPage> {
    return this.mutate(run => {
      const oldest = this.rows<{ revision: number | null }>('SELECT MIN(revision) revision FROM cg_events')[0]?.revision ?? run.revision;
      if (input.before !== undefined && oldest > 1 && input.before <= oldest && input.before <= run.revision) throw new PublicError('HISTORY_EXPIRED', 'This history cursor has expired.', 410);
      const limit = Math.max(1, Math.min(100, input.limit));
      const rows = this.rows<{ data: string }>('SELECT data FROM cg_events WHERE revision<? ORDER BY revision DESC LIMIT ?', input.before ?? run.revision + 1, limit + 1);
      const events = rows.slice(0, limit).map(row => JSON.parse(row.data) as WorldEvent);
      return { events, ...(rows.length > limit ? { nextBefore: events.at(-1)!.revision } : {}), oldestAvailableRevision: oldest };
    });
  }
  async command(input: OperatorCommand): Promise<CommandReceipt> {
    return this.mutate(run => {
      const fingerprint = canonical(input);
      const operationId = `command:${input.operationId}`;
      const replay = this.receipt<CommandReceipt>(operationId, fingerprint);
      if (replay) return replay;
      if (run.mode === 'stopped') throw new PublicError('RUN_STOPPED', 'A stopped run is terminal.', 409, input.operationId);
      let crewId: string | undefined;
      switch (input.type) {
        case 'spawn': {
          if (!Number.isInteger(input.count) || input.count < 1 || input.count > 1000) throw new PublicError('INVALID_ARGUMENT', 'Spawn count must be 1–1,000.', 400, input.operationId);
          if (run.nextAgentOrdinal + input.count - 1 > 1000) throw new PublicError('MINER_LIMIT', 'This run retains at most 1,000 miner identities.', 429, input.operationId);
          crewId = `crew:${input.operationId}`;
          const changes: WorldChange[] = [];
          const tiles = this.tiles();
          const floors = tiles.filter(tile => tile.terrain === 'floor');
          for (let i = 0; i < input.count; i++) {
            const agentId = String(run.nextAgentOrdinal++);
            const spawn = floors[Math.floor(Math.random() * floors.length)]!;
            const miner: PublicMiner = { agentId, crewId, doId: this.env.MINERS.idFromName(`miner:${run.runId}:${agentId}`).toString(), state: 'provisioning', generation: run.generation, retired: false, x: spawn.x, y: spawn.y, coal: 0, diamonds: 0, inventory: { coal: 0, diamonds: 0 }, lastAppliedRevision: run.revision, lastContact: 0, provisioned: false, inputTokens: 0, outputTokens: 0, realResponses: 0, validatedTools: 0, lastTools: [] };
            this.saveMiner(miner); changes.push({ kind: 'miner_upsert', miner });
            // Reveal only the new miner's local area, not the route from another spawn.
            for (let y = Math.max(0, spawn.y - 3); y <= Math.min(WORLD_HEIGHT - 1, spawn.y + 3); y++) {
              for (let x = Math.max(0, spawn.x - 3); x <= Math.min(WORLD_WIDTH - 1, spawn.x + 3); x++) {
                const tile = tiles[tileKey(x, y)]!;
                if (tile.visible || manhattan(tile, spawn) > 3) continue;
                tile.visible = true;
                this.saveTile(tile); changes.push({ kind: 'tile_upsert', tile });
              }
            }
            this.deliver(run, agentId, ['initialize']);
          }
          this.event(run, 'miner', `Provision ${input.count} miners`, changes);
          this.execute('UPDATE cg_deliveries SET desired_revision=?', run.revision);
          break;
        }
        case 'pause':
          if (run.mode !== 'budget_paused') { this.freeze(run, 'paused'); this.controlNotice(run); }
          break;
        case 'resume': {
          if (run.mode === 'budget_paused') throw new PublicError('ALLOWANCE_REACHED', 'Inference allowance reached. Create a new run.', 409, input.operationId);
          if (run.mode !== 'running') {
            const now = Date.now(); const duration = now - (run.pausedAt ?? now);
            for (const action of this.activeActions()) { action.startedAt += duration; action.endsAt += duration; this.saveAction(action); }
            run.mode = 'running'; run.cause = undefined; run.generation++; run.runningSince = now; run.pausedAt = undefined;
            this.clearGrantDeliveries();
            this.controlNotice(run);
          }
          break;
        }
        case 'stop':
          this.freeze(run, 'stopped');
          for (const miner of this.miners()) { this.cancelAction(run, miner); if (!miner.retired) miner.state = 'paused'; this.saveMiner(miner); }
          this.controlNotice(run); break;
        case 'retire': {
          const miner = this.miner(input.agentId);
          if (!miner.retired) {
            this.cancelAction(run, miner); miner.retired = true; miner.state = 'retired'; this.saveMiner(miner);
            this.execute('DELETE FROM cg_model_queue WHERE miner_id=?', miner.agentId);
            this.execute("UPDATE cg_model_calls SET state='unused' WHERE miner_id=? AND state='granted'", miner.agentId);
            this.clearGrantDeliveries(miner.agentId);
            this.recountBudget(run);
            this.event(run, 'miner', `Miner ${miner.agentId} retired`, [{ kind: 'miner_upsert', miner }], { agentId: miner.agentId });
            this.deliver(run, miner.agentId, ['control_changed']);
          }
          break;
        }
        case 'retry_provisioning': {
          const miner = this.miner(input.agentId);
          if (!miner.retired && !miner.provisioned) { miner.error = undefined; miner.state = 'provisioning'; this.saveMiner(miner); this.deliver(run, miner.agentId, ['initialize']); this.event(run, 'miner', `Retry miner ${miner.agentId}`, [{ kind: 'miner_upsert', miner }], { agentId: miner.agentId }); }
          break;
        }
        case 'set_quota':
          if (!Number.isInteger(input.verifiedModelRPM) || input.verifiedModelRPM < 1 || input.verifiedModelRPM > 1000 || !Number.isInteger(input.maxInFlight) || input.maxInFlight < 1 || input.maxInFlight > MAX_IN_FLIGHT) throw new PublicError('INVALID_ARGUMENT', `Enter a verified quota from 1–1,000 and concurrency from 1–${MAX_IN_FLIGHT}.`, 400, input.operationId);
          run.verifiedModelRPM = input.verifiedModelRPM; run.effectiveRPM = Math.max(1, Math.floor(input.verifiedModelRPM * 0.8)); run.maxInFlight = input.maxInFlight;
          this.event(run, 'control', 'Verified inference quota updated', [{ kind: 'run_update', run: { ...run } }]); break;
      }
      const receipt: CommandReceipt = { ok: true, operationId: input.operationId, revision: run.revision, mode: run.mode, ...(crewId ? { crewId, requested: input.type === 'spawn' ? input.count : undefined } : {}) };
      this.saveReceipt(operationId, fingerprint, receipt);
      this.assertResources(run);
      return receipt;
    });
  }
  private knownTiles(): Tile[] {
    const tiles = this.tiles();
    for (const action of this.activeActions()) if (action.kind === 'mine') tiles[tileKey(action.target.x, action.target.y)].claimant = action.agentId;
    return tiles;
  }
  private checkExhaustion(run: RunRecord, tiles: Tile[], miner: PublicMiner): void {
    if (!run.exhausted && !this.rows("SELECT agent_id FROM cg_miners WHERE json_extract(data,'$.retired')=0 AND json_extract(data,'$.inventory.coal')+json_extract(data,'$.inventory.diamonds')>0 LIMIT 1").length && isExhausted(tiles, miner)) {
      run.exhausted = true;
      this.execute('DELETE FROM cg_model_queue');
      this.execute("UPDATE cg_model_calls SET state='unused' WHERE state='granted'");
      this.clearGrantDeliveries();
      this.recountBudget(run);
      for (const peer of this.miners()) {
        if (!peer.retired && !peer.activeAction) { peer.state = 'idle'; this.saveMiner(peer); }
      }
      this.event(run, 'control', 'Mine exhausted', [{ kind: 'run_update', run: { ...run } }]);
      this.controlNotice(run);
    }
  }
  async observe(agentId: string): Promise<Observation> {
    return this.mutate(run => {
      const self = this.miner(agentId);
      const tiles = this.knownTiles();
      const knowledge = projectKnowledge(tiles, self);
      this.checkExhaustion(run, tiles, self);
      const peers = this.miners().filter(m => m.agentId !== agentId && !m.retired && manhattan(m, self) <= 8).sort((a, b) => manhattan(a, self) - manhattan(b, self) || Number(a.agentId) - Number(b.agentId));
      for (const peer of peers) peer.lastTools = [];
      const cursor = (self as PublicMiner & { messageCursor?: number }).messageCursor ?? 0;
      const rows = this.rows<{ sequence: number; sender: string; audience: 'mine' | 'agent'; recipient: string | null; body: string; at_key: number | null; revision: number; timestamp: number }>("SELECT * FROM cg_messages WHERE sequence>? AND (audience='mine' OR recipient=?) ORDER BY sequence LIMIT 21", cursor, agentId);
      const messages: CoordinationMessage[] = rows.slice(0, 20).map(m => ({ sequence: m.sequence, sender: m.sender, audience: m.audience, ...(m.recipient ? { agentId: m.recipient } : {}), body: m.body, ...(m.at_key !== null ? { at: { x: m.at_key % WORLD_WIDTH, y: Math.floor(m.at_key / WORLD_WIDTH) } } : {}), revision: m.revision, timestamp: m.timestamp }));
      const messageCursor = messages.at(-1)?.sequence ?? cursor;
      return { runId: run.runId, revision: run.revision, generation: run.generation, mode: run.mode, exhausted: run.exhausted, serverTime: Date.now(), self: { ...self, ...(run.exhausted && !self.activeAction && !self.retired ? { state: 'idle' as const } : {}) }, hopper: { ...run.hopper }, action: self.activeAction ? this.action(self.activeAction) : undefined, localTiles: knowledge.localTiles, resourceTargets: knowledge.resourceTargets, frontiers: knowledge.frontiers, nearbyMiners: peers.slice(0, 8), messages, messageCursor, ...(rows.length > 20 ? { nextMessageCursor: messageCursor } : {}), truncated: { ...knowledge.truncated, miners: peers.length > 8, messages: rows.length > 20 } };
    });
  }
  async applyTool(input: ToolEnvelope): Promise<ToolResult> {
    return this.mutate(run => {
      const effectId = `tool:${input.operationId}`;
      const fingerprint = canonical({ runId: input.runId, agentId: input.agentId, generation: input.generation, tool: input.tool, args: input.args });
      try {
        const replay = this.receipt<ToolResult>(effectId, fingerprint);
        if (replay) return replay;
      } catch (error) {
        if (error instanceof PublicError && error.code === 'OPERATION_CONFLICT') return { ok: false, code: 'OPERATION_CONFLICT', revision: run.revision };
        throw error;
      }
      const miner = this.jsonRecord<PublicMiner>('SELECT data FROM cg_miners WHERE agent_id=?', input.agentId);
      let validatedArgs: ToolArguments | undefined;
      const fail = (code: ToolError, extra: { claimant?: string; nearestFloor?: { x: number; y: number }; frontiers?: Observation['frontiers']; retryAt?: number } = {}): ToolResult => {
        this.event(run, 'conflict', `${input.tool}: ${code}`, [], { agentId: input.agentId, detail: { tool: input.tool, code } });
        const result: ToolResult = { ok: false, code, revision: run.revision, ...extra };
        if (miner && validatedArgs) {
          miner.validatedTools++;
          miner.lastContact = Date.now();
          miner.lastTools = [...miner.lastTools, { tool: input.tool, args: validatedArgs, result, at: Date.now() }].slice(-8);
          this.saveMiner(miner);
        }
        this.saveReceipt(effectId, fingerprint, result);
        return result;
      };
      if (input.runId !== run.runId || !miner) return fail('NO_SUCH_AGENT');
      if (miner.retired) return fail('RETIRED');
      if (input.generation !== run.generation) return fail('STALE_GENERATION');
      if (run.mode !== 'running') return fail('RUN_PAUSED');
      const args = validateToolArguments(input.tool, input.args);
      if (!args) return fail('INVALID_ARGUMENT');
      validatedArgs = args;
      if (input.tool !== 'talk' && miner.activeAction) return fail('BUSY');
      let result: ToolResult;
      const now = Date.now();
      const routeChanges: WorldChange[] = [];
      if (input.tool === 'walk_to' || input.tool === 'mine') {
        const target = this.tile(tileKey(args.x!, args.y!))!;
        const returningToHopper = input.tool === 'walk_to' && target.x === run.hopper.x && target.y === run.hopper.y;
        if (!target.visible && !returningToHopper) return fail('UNKNOWN_TILE');
        let action: PhysicalAction;
        if (input.tool === 'walk_to') {
          if (target.terrain !== 'floor') {
            const alternatives = this.tiles().filter(t => t.visible && t.terrain === 'floor').sort((a, b) => manhattan(a, target) - manhattan(b, target) || a.key - b.key);
            return fail('BLOCKED', alternatives[0] ? { nearestFloor: { x: alternatives[0].x, y: alternatives[0].y } } : {});
          }
          if (target.x === miner.x && target.y === miner.y) return fail('NO_CHANGE');
          const tiles = this.tiles();
          const fullPath = findPath(tiles, miner, target, returningToHopper);
          if (!fullPath) return fail('UNREACHABLE');
          const path = fullPath.slice(0, 32);
          if (returningToHopper) for (const point of path) {
            const cell = tiles[tileKey(point.x, point.y)]!;
            if (cell.visible) continue;
            cell.visible = true;
            this.saveTile(cell);
            routeChanges.push({ kind: 'tile_upsert', tile: cell });
          }
          action = { actionId: effectId, effectId, agentId: miner.agentId, kind: 'walk_to', generation: input.generation, origin: { x: miner.x, y: miner.y }, path, target: path.at(-1)!, quantity: 0, startedAt: now, endsAt: now + 250 * path.length, status: 'accepted' };
          miner.state = 'walking';
        } else {
          const freeSlots = INVENTORY_CAPACITY - miner.inventory.coal - miner.inventory.diamonds;
          if (freeSlots <= 0) return fail('INVENTORY_FULL', { nearestFloor: { x: run.hopper.x, y: run.hopper.y } });
          if (manhattan(miner, target) !== 1) return fail('TOO_FAR');
          const claim = this.rows<{ agent_id: string }>("SELECT agent_id FROM cg_actions WHERE status='accepted' AND kind='mine' AND target_key=?", target.key)[0];
          if (claim) { this.metrics.increment('rejectedClaims'); return fail('CLAIMED', { claimant: claim.agent_id }); }
          if (target.available === 0) return fail('DEPLETED');
          if (target.terrain !== 'coal' && target.terrain !== 'diamond') return fail('BLOCKED');
          const resource = target.terrain;
          const quantity = Math.min(target.available, freeSlots);
          target.available -= quantity; target.reserved += quantity;
          if (resource === 'diamond') {
            run.availableDiamonds -= quantity; run.reservedDiamonds += quantity;
          } else {
            run.availableCoal -= quantity; run.reservedCoal += quantity;
          }
          this.saveTile(target);
          action = { actionId: effectId, effectId, agentId: miner.agentId, kind: 'mine', resource, generation: input.generation, origin: { x: miner.x, y: miner.y }, path: [], target: { x: target.x, y: target.y }, quantity, startedAt: now, endsAt: now + 1500, status: 'accepted' };
          miner.state = 'mining';
        }
        miner.activeAction = action.actionId;
        miner.goal = { ...action.target };
        this.saveAction(action);
        const changes: WorldChange[] = [...routeChanges, { kind: 'action_upsert', action }, { kind: 'miner_upsert', miner }];
        if (action.kind === 'mine') changes.push({ kind: 'tile_upsert', tile: { ...target, claimant: miner.agentId } });
        this.event(run, 'action', `Miner ${miner.agentId}: ${input.tool}${action.resource ? ` ${action.resource}` : ''} accepted`, changes, { agentId: miner.agentId, at: action.target, detail: { tool: input.tool, actionId: action.actionId, acceptedAmount: action.quantity, observedRevision: input.observedRevision, ...(action.resource ? { resource: action.resource } : {}) } });
        result = { ok: true, revision: run.revision, action, ...(action.kind === 'mine' ? { acceptedAmount: action.quantity } : { endpoint: action.target }) };
      } else if (input.tool === 'deposit') {
        if (manhattan(miner, run.hopper) > 1) return fail('TOO_FAR', { nearestFloor: { x: run.hopper.x, y: run.hopper.y } });
        if (miner.inventory.coal + miner.inventory.diamonds === 0) return fail('EMPTY_INVENTORY');
        const deposited = miner.inventory;
        run.hopper.coal += deposited.coal;
        run.hopper.diamonds += deposited.diamonds;
        miner.inventory = { coal: 0, diamonds: 0 };
        this.event(run, 'action', `Miner ${miner.agentId} deposited ${deposited.coal} coal and ${deposited.diamonds} diamonds`, [{ kind: 'miner_upsert', miner }], { agentId: miner.agentId, at: { x: run.hopper.x, y: run.hopper.y }, detail: { tool: 'deposit', coal: deposited.coal, diamonds: deposited.diamonds } });
        result = { ok: true, revision: run.revision, deposited, inventory: { ...miner.inventory }, hopper: { ...run.hopper } };
      } else if (input.tool === 'discover') {
        const tiles = this.knownTiles();
        const cells = reveal(tiles, miner, 6);
        if (cells.length === 0) return fail('NO_CHANGE', { frontiers: projectKnowledge(tiles, miner).frontiers });
        for (const cell of cells) { this.saveTile(cell); tiles[cell.key] = cell; }
        const knowledge = projectKnowledge(tiles, miner);
        this.event(run, 'discovery', `Miner ${miner.agentId} revealed ${cells.length} tiles`, cells.map(tile => ({ kind: 'tile_upsert', tile })), { agentId: miner.agentId, at: { x: miner.x, y: miner.y }, detail: { tool: 'discover', cells: cells.length } });
        this.checkExhaustion(run, tiles, miner);
        result = { ok: true, revision: run.revision, cells, resourceTargets: knowledge.resourceTargets, frontiers: knowledge.frontiers };
      } else {
        if (args.audience === 'agent' && !this.jsonRecord<PublicMiner>('SELECT data FROM cg_miners WHERE agent_id=?', args.agentId!)) return fail('NO_SUCH_AGENT');
        if (args.at && !this.tile(tileKey(args.at.x, args.at.y))!.visible) return fail('UNKNOWN_TILE');
        const last = this.rows<{ timestamp: number }>('SELECT timestamp FROM cg_messages WHERE sender=? ORDER BY timestamp DESC LIMIT 1', miner.agentId)[0];
        if (last && now - last.timestamp < 5000) return fail('RATE_LIMITED', { retryAt: last.timestamp + 5000 });
        const sequence = this.rows<{ sequence: number }>('INSERT INTO cg_messages(sender,audience,recipient,body,at_key,revision,timestamp) VALUES(?,?,?,?,?,?,?) RETURNING sequence', miner.agentId, args.audience!, args.agentId ?? null, args.message!.trim(), args.at ? tileKey(args.at.x, args.at.y) : null, run.revision + 1, now)[0].sequence;
        const message: CoordinationMessage = { sequence, sender: miner.agentId, audience: args.audience!, ...(args.agentId ? { agentId: args.agentId } : {}), body: args.message!.trim(), ...(args.at ? { at: args.at } : {}), revision: run.revision + 1, timestamp: now };
        this.event(run, 'message', `Miner ${miner.agentId} → ${args.audience === 'mine' ? 'mine' : args.agentId}: ${message.body}`, [{ kind: 'message_append', message }], { agentId: miner.agentId, at: args.at, detail: { tool: 'talk', sequence, audience: args.audience! } });
        if (args.audience === 'agent') this.deliver(run, args.agentId!, ['world_changed'], Math.max(now, run.sweepAt ?? now + 5000));
        result = { ok: true, revision: run.revision, sequence };
      }
      miner.validatedTools++;
      miner.lastContact = now;
      const memoryResult: ToolResult = result.ok ? { ok: true, revision: result.revision, acceptedAmount: result.acceptedAmount, endpoint: result.action?.target ?? result.endpoint, sequence: result.sequence, inventory: result.inventory, deposited: result.deposited, hopper: result.hopper } : result;
      miner.lastTools = [...miner.lastTools, { tool: input.tool, args, result: memoryResult, at: now }].slice(-8);
      this.saveMiner(miner);
      if (input.tool === 'deposit') this.checkExhaustion(run, this.knownTiles(), miner);
      this.saveReceipt(effectId, fingerprint, result);
      this.assertResources(run);
      return result;
    });
  }
  private occupiedSlots(now: number): number { return this.rows<{ n: number }>("SELECT COUNT(*) n FROM cg_model_calls WHERE state IN ('granted','claimed') OR (state='unknown' AND expires_at>?)", now)[0].n; }
  private rollingStartAt(run: RunRecord, now: number): number {
    const ledger = this.rows<{ n: number; oldest: number | null }>('SELECT COUNT(*) n,MIN(claimed_at) oldest FROM cg_model_calls WHERE claimed_at>?', now - 60000)[0];
    return ledger.n >= run.effectiveRPM ? (ledger.oldest ?? now) + 60000 : now;
  }
  private queue(run: RunRecord, miner: PublicMiner, burstId: string, eligibleAt: number): void {
    if (this.rows('SELECT miner_id FROM cg_model_queue WHERE miner_id=?', miner.agentId).length) return;
    this.metrics.increment('queueOrdinal');
    const now = Date.now();
    this.execute('INSERT INTO cg_model_queue(miner_id,generation,burst_id,eligible_at,ordinal,queued_at) VALUES(?,?,?,?,?,?)', miner.agentId, run.generation, burstId, eligibleAt, this.metrics.count('queueOrdinal'), now);
    miner.queuedAt = now;
    if (!miner.activeAction) miner.state = 'queued';
    this.saveMiner(miner);
    this.event(run, 'miner', `Miner ${miner.agentId}: queued for inference`, [{ kind: 'miner_upsert', miner }], { agentId: miner.agentId });
  }
  private expireCalls(run: RunRecord, now: number): void {
    for (const call of this.rows<ModelCall>("SELECT * FROM cg_model_calls WHERE state IN ('granted','claimed') AND expires_at<=?", now)) {
      if (call.state === 'granted') {
        this.execute("UPDATE cg_model_calls SET state='unused' WHERE grant_id=?", call.grant_id);
        const delivery = this.rows<Delivery>('SELECT * FROM cg_deliveries WHERE miner_id=?', call.miner_id)[0];
        if (delivery?.grant && (JSON.parse(delivery.grant) as InferenceGrant).grantId === call.grant_id) {
          const reasons = (JSON.parse(delivery.reasons) as NoticeReason[]).filter(r => r !== 'grant_available');
          if (reasons.length) this.execute('UPDATE cg_deliveries SET grant=NULL,reasons=? WHERE miner_id=?', JSON.stringify(reasons), call.miner_id);
          else this.execute('DELETE FROM cg_deliveries WHERE miner_id=?', call.miner_id);
        }
        const miner = this.miner(call.miner_id);
        if (run.mode === 'running' && !run.exhausted && !miner.retired) this.queue(run, miner, call.burst_id, Math.max(now, miner.nextEligibleAt ?? 0));
        this.metrics.increment('unusedGrantExpirations');
      } else {
        this.execute("UPDATE cg_model_calls SET state='unknown' WHERE grant_id=?", call.grant_id);
        this.metrics.increment('unknownCalls');
        this.event(run, 'error', `Miner ${call.miner_id}: inference outcome unknown`, [], { agentId: call.miner_id, detail: { grantId: call.grant_id, cause: 'INFERENCE_TIMEOUT' } });
      }
    }
    this.recountBudget(run);
  }
  private admit(run: RunRecord, now: number): void {
    this.expireCalls(run, now);
    if (run.mode !== 'running' || run.exhausted || now < run.nextStartAt || this.rollingStartAt(run, now) > now || this.occupiedSlots(now) >= run.maxInFlight || this.rows("SELECT grant_id FROM cg_model_calls WHERE state='granted' LIMIT 1").length) return;
    const entry = this.rows<DecisionRow>("SELECT q.* FROM cg_model_queue q JOIN cg_miners m ON q.miner_id=m.agent_id WHERE q.generation=? AND q.eligible_at<=? AND json_extract(m.data,'$.retired')=0 AND json_extract(m.data,'$.activeAction') IS NULL ORDER BY q.ordinal LIMIT 1", run.generation, now)[0];
    if (!entry) return;
    const reserve = this.runtimePolicy().reservationMicroUSD;
    if (run.observedMicroUSD + run.reservedMicroUSD + run.unknownMicroUSD + reserve > run.allowanceMicroUSD) {
      this.freeze(run, 'budget_paused', 'INFERENCE_ALLOWANCE_REACHED');
      this.controlNotice(run);
      return;
    }
    const grant: InferenceGrant = { grantId: crypto.randomUUID(), burstId: entry.burst_id, generation: run.generation, expiresAt: now + 10000 };
    this.execute("INSERT INTO cg_model_calls(grant_id,miner_id,generation,burst_id,created_at,expires_at,state,reservation,charged) VALUES(?,?,?,?,?,?,'granted',?,0)", grant.grantId, entry.miner_id, run.generation, entry.burst_id, now, grant.expiresAt, reserve);
    this.execute('DELETE FROM cg_model_queue WHERE miner_id=?', entry.miner_id);
    this.metrics.histogram('queueWait', Math.max(0, now - entry.queued_at));
    this.event(run, 'inference', `Grant available for miner ${entry.miner_id}`, [], { agentId: entry.miner_id, detail: { grantId: grant.grantId, burstId: grant.burstId } });
    this.deliver(run, entry.miner_id, ['grant_available'], now, grant);
    this.recountBudget(run);
  }
  async enqueueDecision(input: DecisionRequest): Promise<DecisionQueueReceipt> {
    return this.mutate(run => {
      const miner = this.miner(input.agentId);
      const result = (status: DecisionQueueReceipt['status']): DecisionQueueReceipt => ({ status, mode: run.mode, generation: run.generation });
      if (miner.retired) return result('retired');
      if (run.exhausted) { miner.state = miner.activeAction ? miner.state : 'idle'; this.saveMiner(miner); return result('exhausted'); }
      if (run.mode !== 'running') return result('paused');
      const outstanding = this.rows<ModelCall>("SELECT * FROM cg_model_calls WHERE miner_id=? AND burst_id=? AND state IN ('granted','claimed') LIMIT 1", input.agentId, input.burstId)[0];
      if (!outstanding) this.queue(run, miner, input.burstId, Math.max(Date.now(), input.eligibleAt ?? 0, miner.nextEligibleAt ?? 0, miner.activeAction ? this.action(miner.activeAction)?.endsAt ?? 0 : 0));
      this.admit(run, Date.now());
      return result(run.mode === 'running' ? 'queued' : 'paused');
    });
  }
  async claimInference(input: InferenceClaim): Promise<InferenceClaimResult> {
    return this.mutate(run => {
      const call = this.rows<ModelCall>('SELECT * FROM cg_model_calls WHERE grant_id=?', input.grantId)[0];
      const identityMatches = call && input.runId === run.runId && input.agentId === call.miner_id && input.burstId === call.burst_id && input.generation === call.generation;
      // A retry of the same committed invocation acknowledges its old claim even after a fence.
      if (identityMatches && call.invocation_id === input.invocationId && call.claimed_at !== null) return { ok: true, claimedAt: call.claimed_at, expiresAt: call.expires_at };
      const now = Date.now();
      const denied = (): InferenceClaimResult => { this.metrics.increment('admissionRejected'); return { ok: false, code: 'ADMISSION_REQUIRED', mode: run.mode, generation: run.generation }; };
      if (!identityMatches || call.state !== 'granted' || call.expires_at <= now || run.mode !== 'running' || run.generation !== input.generation || run.exhausted || this.miner(input.agentId).retired || now < run.nextStartAt || this.rollingStartAt(run, now) > now) return denied();
      this.execute("UPDATE cg_model_calls SET invocation_id=?,claimed_at=?,expires_at=?,state='claimed' WHERE grant_id=?", input.invocationId, now, now + 120000, call.grant_id);
      run.nextStartAt = now + Math.ceil(60000 / run.effectiveRPM);
      const miner = this.miner(input.agentId); miner.state = 'thinking'; miner.lastContact = now; miner.queuedAt = undefined; this.saveMiner(miner);
      this.metrics.increment('modelCallsTotal'); this.metrics.sample({ calls: 1 }, now);
      this.event(run, 'inference', `Miner ${miner.agentId}: model request admitted`, [{ kind: 'miner_upsert', miner }], { agentId: miner.agentId, detail: { invocationId: input.invocationId, grantId: call.grant_id, burstId: call.burst_id, generation: call.generation } });
      return { ok: true, claimedAt: now, expiresAt: now + 120000 };
    });
  }
  async settleInference(input: InferenceSettlement): Promise<void> {
    await this.mutate(run => {
      const call = this.rows<ModelCall>('SELECT * FROM cg_model_calls WHERE invocation_id=?', input.invocationId)[0];
      if (!call || call.miner_id !== input.agentId || call.state === 'settled' || call.claimed_at === null) return;
      const known = input.inputTokens !== undefined && input.outputTokens !== undefined && [input.inputTokens, input.outputTokens, input.cacheReadTokens ?? 0].every(n => Number.isSafeInteger(n) && n >= 0);
      if (call.settlement && !known) return;
      const firstTerminal = call.settlement === null;
      const charged = known && run.providerMode === 'live' ? Math.ceil((input.inputTokens! * 45 + input.outputTokens! * 320 + (input.cacheReadTokens ?? 0) * 5) / 100) : 0;
      const settlement = { ...input, priceBasis: { inputPerMillionUSD: 0.45, outputPerMillionUSD: 3.2, cacheReadPerMillionUSD: 0.05 }, known, terminalObserved: true };
      this.execute('UPDATE cg_model_calls SET state=?,input_tokens=?,output_tokens=?,cache_read_tokens=?,charged=?,settlement=? WHERE grant_id=?', known ? 'settled' : 'unknown', known ? input.inputTokens! : null, known ? input.outputTokens! : null, known ? input.cacheReadTokens ?? 0 : null, charged, JSON.stringify(settlement), call.grant_id);
      const miner = this.miner(call.miner_id);
      if (known && run.providerMode === 'live') miner.realResponses++;
      if (known) { miner.inputTokens += input.inputTokens!; miner.outputTokens += input.outputTokens!; }
      miner.lastContact = Date.now();
      if (input.error) { miner.error = input.error.slice(0, 400); if (!miner.activeAction && !miner.retired) miner.state = 'error'; this.metrics.increment(`error:MODEL_${input.status ?? 'TRANSPORT'}`); this.metrics.sample({ errors: 1 }); }
      this.saveMiner(miner);
      if (firstTerminal && input.durationMs !== undefined && Number.isFinite(input.durationMs) && input.durationMs >= 0) this.metrics.histogram('inferenceLatency', input.durationMs);
      this.recountBudget(run);
      this.event(run, input.error ? 'error' : 'inference', input.error ? `Miner ${miner.agentId}: ${input.error.slice(0, 180)}` : `Miner ${miner.agentId}: model response observed`, [{ kind: 'miner_upsert', miner }], { agentId: miner.agentId, detail: { invocationId: input.invocationId, knownUsage: known, inputTokens: input.inputTokens ?? 0, outputTokens: input.outputTokens ?? 0, model: input.outbound?.model ?? '@cf/qwen/qwen3.8-27b', reasoningEffort: input.outbound?.reasoningEffort ?? 'unobserved', maxTokens: input.outbound?.maxTokens ?? 0, noFallback: input.outbound?.noFallback ?? false, maxAttempts: input.outbound?.maxAttempts ?? 0, observedMicroUSD: charged } });
      if (run.mode !== 'stopped' && run.mode !== 'budget_paused' && [401, 403, 404, 410, 429].includes(input.status ?? 0)) {
        this.freeze(run, 'quota_paused', input.status === 429 ? 'MODEL_RATE_LIMIT' : `MODEL_UNAVAILABLE_${input.status}`);
        this.controlNotice(run);
      }
      this.admit(run, Date.now());
    });
  }
  async reportMiner(input: MinerReport): Promise<void> {
    await this.mutate(run => {
      const miner = this.miner(input.agentId);
      miner.lastContact = Date.now();
      miner.lastAppliedRevision = Math.max(miner.lastAppliedRevision, input.observedRevision ?? 0);
      if (input.blocked !== undefined) miner.blocked = input.blocked;
      if (input.error) { miner.error = input.error.slice(0, 400); this.metrics.increment('error:MINER_DRIVER'); }
      if (input.restart) this.metrics.increment('restarts');
      if (input.durationMs !== undefined && Number.isFinite(input.durationMs) && input.durationMs >= 0 && input.tool) { this.metrics.histogram('worldRPC', input.durationMs); this.metrics.sample({ toolRPCs: 1 }); }
      if (input.memory) { miner.goal = input.memory.goal; miner.messageCursor = Math.max(miner.messageCursor ?? 0, input.memory.messageCursor); }
      if (input.state && !miner.retired && !miner.activeAction && run.mode === 'running' && !run.exhausted) miner.state = input.state;
      if (input.settledBurst) {
        const id = `settled:${miner.agentId}:${input.settledBurst}`;
        if (!this.rows('SELECT operation_id FROM cg_receipts WHERE operation_id=?', id).length) { miner.nextEligibleAt = Math.max(miner.nextEligibleAt ?? 0, Date.now() + 10000); this.saveReceipt(id, input.settledBurst, { accepted: true }); }
      }
      this.saveMiner(miner);
      if (input.observation) this.event(run, 'observation', `Miner ${miner.agentId} observed revision ${input.observation.revision}`, [], { agentId: miner.agentId, detail: { observedRevision: input.observation.revision, messageSequences: input.observation.messageSequences.slice(0, 20), resourceTargets: input.observation.resourceTargets.slice(0, 8) } });
      else if (input.state || input.error || input.settledBurst) this.event(run, input.error ? 'error' : 'miner', input.error ? `Miner ${miner.agentId}: ${input.error.slice(0, 180)}` : `Miner ${miner.agentId}: ${miner.state}`, [{ kind: 'miner_upsert', miner }], { agentId: miner.agentId });
    });
  }
  private assertResources(run: RunRecord): void {
    const totals = this.rows<{ coalAvailable: number; coalReserved: number; diamondAvailable: number; diamondReserved: number; invalid: number }>("SELECT COALESCE(SUM(CASE WHEN terrain='coal' THEN available ELSE 0 END),0) coalAvailable,COALESCE(SUM(CASE WHEN terrain='coal' THEN reserved ELSE 0 END),0) coalReserved,COALESCE(SUM(CASE WHEN terrain='diamond' THEN available ELSE 0 END),0) diamondAvailable,COALESCE(SUM(CASE WHEN terrain='diamond' THEN reserved ELSE 0 END),0) diamondReserved,COALESCE(SUM(CASE WHEN terrain NOT IN ('coal','diamond') AND (available<>0 OR reserved<>0) THEN 1 ELSE 0 END),0) invalid FROM cg_tiles")[0];
    if (totals.invalid) throw new Error('RESOURCE_TILE_INVARIANT');
    if (totals.coalAvailable !== run.availableCoal || totals.coalReserved !== run.reservedCoal || totals.coalAvailable + totals.coalReserved + run.minedCoal !== run.initialCoal) throw new Error('COAL_RESOURCE_INVARIANT');
    if (totals.diamondAvailable !== run.availableDiamonds || totals.diamondReserved !== run.reservedDiamonds || totals.diamondAvailable + totals.diamondReserved + run.minedDiamonds !== run.initialDiamonds) throw new Error('DIAMOND_RESOURCE_INVARIANT');
    const inventory = this.rows<{ coal: number; diamonds: number; invalid: number }>(`SELECT COALESCE(SUM(json_extract(m.data,'$.inventory.coal')),0) coal,COALESCE(SUM(json_extract(m.data,'$.inventory.diamonds')),0) diamonds,COALESCE(SUM(CASE WHEN json_type(m.data,'$.inventory.coal') IS NOT 'integer' OR json_type(m.data,'$.inventory.diamonds') IS NOT 'integer' OR json_extract(m.data,'$.inventory.coal')<0 OR json_extract(m.data,'$.inventory.diamonds')<0 OR json_extract(m.data,'$.inventory.coal')+json_extract(m.data,'$.inventory.diamonds')+COALESCE(json_extract(a.data,'$.quantity'),0)>${INVENTORY_CAPACITY} THEN 1 ELSE 0 END),0) invalid FROM cg_miners m LEFT JOIN cg_actions a ON a.agent_id=m.agent_id AND a.status='accepted' AND a.kind='mine'`)[0];
    if (inventory.invalid || !Number.isSafeInteger(run.hopper.coal) || !Number.isSafeInteger(run.hopper.diamonds) || run.hopper.coal < 0 || run.hopper.diamonds < 0 || inventory.coal + run.hopper.coal !== run.minedCoal || inventory.diamonds + run.hopper.diamonds !== run.minedDiamonds) throw new Error('INVENTORY_RESOURCE_INVARIANT');
  }
  private sweepNotices(run: RunRecord, now: number): void {
    if (run.mode === 'capacity_paused' || run.sweepAt === undefined || run.sweepAt > now) return;
    run.sweepAt = undefined;
    for (const miner of this.miners()) if (!miner.retired) this.deliver(run, miner.agentId, ['world_changed'], now);
  }
  private selectDeliveries(run: RunRecord, now: number): PendingDelivery[] {
    if (run.mode === 'capacity_paused') return [];
    const due = this.rows<Delivery>(`SELECT * FROM cg_deliveries WHERE next_attempt_at<=? ORDER BY
      CASE WHEN instr(reasons,'control_changed')>0 THEN 0 WHEN instr(reasons,'grant_available')>0 THEN 1
      WHEN instr(reasons,'action_completed')>0 THEN 2 WHEN instr(reasons,'initialize')>0 THEN 3 ELSE 4 END,
      next_attempt_at,created_at,CAST(miner_id AS INTEGER) LIMIT 25`, now);
    return due.map(row => {
      const miner = this.miner(row.miner_id);
      let reasons = JSON.parse(row.reasons) as NoticeReason[];
      let grant = row.grant ? JSON.parse(row.grant) as InferenceGrant : undefined;
      if (grant && (grant.generation !== run.generation || grant.expiresAt <= now || run.mode !== 'running' || run.exhausted || miner.retired || !this.rows("SELECT grant_id FROM cg_model_calls WHERE grant_id=? AND state='granted'", grant.grantId).length)) {
        grant = undefined;
        reasons = reasons.filter(reason => reason !== 'grant_available');
        this.execute('UPDATE cg_deliveries SET grant=NULL,reasons=? WHERE miner_id=?', JSON.stringify(reasons), row.miner_id);
        row = { ...row, grant: null, reasons: JSON.stringify(reasons) };
      }
      // A persisted lease makes a crashed dispatch retryable without a resident timer.
      const leaseUntil = now + 30_000;
      this.execute('UPDATE cg_deliveries SET next_attempt_at=? WHERE miner_id=?', leaseUntil, row.miner_id);
      return { row, leaseUntil, notice: { runId: run.runId, agentId: miner.agentId, generation: run.generation, revision: Math.max(row.desired_revision, run.revision), mode: run.mode, reasons, ...(grant ? { grant } : {}), retired: miner.retired, exhausted: run.exhausted } };
    });
  }
  private async dispatchDeliveries(deliveries: PendingDelivery[]): Promise<DeliveryOutcome[]> {
    const outcomes: DeliveryOutcome[] = [];
    for (let index = 0; index < deliveries.length; index += 5) {
      const group = await Promise.all(deliveries.slice(index, index + 5).map(async (delivery): Promise<DeliveryOutcome> => {
        try {
          // Never retain a failed stub across a durable retry.
          const recipient = this.env.MINERS.getByName(`miner:${delivery.notice.runId}:${delivery.notice.agentId}`);
          const result = await recipient.synchronize(delivery.notice);
          if (!Number.isSafeInteger(result.revision) || result.revision < delivery.notice.revision) throw new Error('INVALID_NOTICE_ACK');
          return { delivery, revision: result.revision };
        } catch (error) {
          return { delivery, error: error instanceof Error ? error.message.slice(0, 400) : 'Miner delivery failed', overloaded: typeof error === 'object' && error !== null && 'overloaded' in error && error.overloaded === true };
        }
      }));
      outcomes.push(...group);
      if (group.some(outcome => outcome.overloaded)) break;
    }
    return outcomes;
  }
  private acknowledgeDeliveries(run: RunRecord, deliveries: PendingDelivery[], outcomes: DeliveryOutcome[], now: number): void {
    const attempted = new Set(outcomes.map(outcome => outcome.delivery.row.miner_id));
    for (const delivery of deliveries) if (!attempted.has(delivery.row.miner_id)) {
      this.execute('UPDATE cg_deliveries SET next_attempt_at=MIN(next_attempt_at,?) WHERE miner_id=?', delivery.row.next_attempt_at, delivery.row.miner_id);
    }
    for (const outcome of outcomes) {
      const { row, notice, leaseUntil } = outcome.delivery;
      const current = this.rows<Delivery>('SELECT * FROM cg_deliveries WHERE miner_id=?', row.miner_id)[0];
      if (outcome.revision !== undefined) {
        // Keep a newer revision (even the same reason) intact after an interleaved command.
        if (current && current.desired_revision <= notice.revision && current.reasons === row.reasons && current.grant === row.grant && current.next_attempt_at === leaseUntil) this.execute('DELETE FROM cg_deliveries WHERE miner_id=?', row.miner_id);
        else if (current) this.execute('UPDATE cg_deliveries SET attempt_count=0,next_attempt_at=MIN(next_attempt_at,?) WHERE miner_id=?', now, row.miner_id);
        const miner = this.miner(row.miner_id);
        const firstAck = !miner.provisioned;
        miner.provisioned = true;
        miner.lastAppliedRevision = Math.max(miner.lastAppliedRevision, Math.min(outcome.revision, run.revision));
        miner.lastContact = now;
        miner.generation = Math.max(miner.generation, notice.generation);
        if (firstAck) {
          miner.error = undefined;
          if (!miner.retired && !miner.activeAction && (miner.state === 'provisioning' || miner.state === 'error')) miner.state = run.exhausted ? 'idle' : run.mode === 'running' ? 'idle' : 'paused';
        }
        this.saveMiner(miner);
        if (firstAck) this.event(run, 'miner', `Miner ${miner.agentId} provisioned`, [{ kind: 'miner_upsert', miner }], { agentId: miner.agentId });
      } else if (current) {
        const attempt = current.attempt_count + 1;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
        this.execute('UPDATE cg_deliveries SET attempt_count=?,next_attempt_at=? WHERE miner_id=?', attempt, now + delay, row.miner_id);
        const miner = this.miner(row.miner_id);
        if (!miner.provisioned && !miner.retired) { miner.error = outcome.error; miner.state = 'error'; this.saveMiner(miner); }
        this.metrics.increment('error:MINER_DELIVERY');
        this.event(run, 'error', `Miner ${row.miner_id}: notice delivery failed`, [{ kind: 'miner_upsert', miner }], { agentId: row.miner_id, detail: { code: outcome.overloaded ? 'DO_OVERLOAD' : 'DELIVERY_FAILED', attempt } });
      }
    }
    if (outcomes.some(outcome => outcome.overloaded) && run.mode !== 'capacity_paused' && run.mode !== 'stopped' && run.mode !== 'budget_paused') {
      this.freeze(run, 'capacity_paused', 'DO_OVERLOAD');
      this.controlNotice(run);
    }
  }
  private viewerState(socket: WebSocket): ViewerState | undefined {
    try {
      const state = socket.deserializeAttachment() as ViewerState | null;
      return state && typeof state.runId === 'string' && Number.isSafeInteger(state.revision) ? state : undefined;
    } catch { return undefined; }
  }
  private closeViewer(socket: WebSocket, code: number, reason: string): void {
    const state = this.viewerState(socket);
    if (state) socket.serializeAttachment({ ...state, pending: false, pendingRevision: undefined, sentAt: undefined, closed: true } satisfies ViewerState);
    try { socket.close(code, reason); } catch { /* An already-closed transport has no pending work. */ }
  }
  private expireViewers(now: number): void {
    for (const socket of this.ctx.getWebSockets()) {
      const viewer = this.viewerState(socket);
      if (!viewer || viewer.closed) continue;
      if (viewer.pending && viewer.sentAt !== undefined && now - viewer.sentAt >= VIEWER_ACK_MS) this.closeViewer(socket, 1013, 'Viewer acknowledgement timed out');
    }
  }
  private snapshotBatch(run: RunRecord): ViewerBatch {
    const snapshot = this.snapshot(run);
    const snapshotId = crypto.randomUUID();
    const records: SnapshotRecord[] = [{ kind: 'run', run: snapshot.run, runId: snapshot.runId, serverTime: snapshot.serverTime, width: snapshot.width, height: snapshot.height }];
    for (const tile of snapshot.tiles) records.push({ kind: 'tile', tile });
    for (const miner of snapshot.miners) records.push({ kind: 'miner', miner });
    for (const action of snapshot.actions) records.push({ kind: 'action', action });
    for (const message of snapshot.messages) records.push({ kind: 'message', message });
    const parts: string[] = [];
    let current: string[] = [], size = 0, total = 0;
    const finishPart = () => {
      if (!current.length) return;
      parts.push(`{"type":"snapshot_part","snapshotId":"${snapshotId}","index":${parts.length},"payload":[${current.join(',')}]}`);
      current = []; size = 0;
    };
    for (const record of records) {
      const json = JSON.stringify(record), bytes = encoder.encode(json).length;
      if (bytes + 200 > FRAME_BYTES) throw new PublicError('SNAPSHOT_TOO_LARGE', 'A public record exceeds the viewer frame limit.', 503);
      if (size + bytes + current.length + 200 > FRAME_BYTES) finishPart();
      current.push(json); size += bytes; total += bytes + 1;
      if (total > SNAPSHOT_BYTES - 16_384) throw new PublicError('SNAPSHOT_TOO_LARGE', 'The viewer snapshot exceeds two MiB.', 503);
    }
    finishPart();
    this.metrics.increment('viewerResyncs');
    return { revision: run.revision, frames: [JSON.stringify({ type: 'snapshot_begin', snapshotId, revision: run.revision, partCount: parts.length } satisfies ServerFrame), ...parts, JSON.stringify({ type: 'snapshot_end', snapshotId } satisfies ServerFrame)] };
  }
  private viewerBatch(run: RunRecord, revision?: number, initial = true): ViewerBatch {
    const invalidation: ViewerBatch = { revision: run.revision, frames: [JSON.stringify({ type: 'invalidate', runId: run.runId, revision: run.revision } satisfies ServerFrame)] };
    if (revision === undefined || revision > run.revision) return initial ? this.snapshotBatch(run) : invalidation;
    const retained = this.rows<{ first: number | null; n: number }>('SELECT MIN(revision) first,COUNT(*) n FROM cg_events WHERE revision>?', revision)[0];
    if (retained.n !== run.revision - revision || (retained.n > 0 && retained.first !== revision + 1)) return initial ? this.snapshotBatch(run) : invalidation;
    const changes: WorldChange[] = [];
    let cursor = revision;
    let bytes = 2_048 + encoder.encode(JSON.stringify(run)).length;
    while (cursor < run.revision) {
      // Read bounded pages, and stop before accumulating a frame-sized patch.
      const rows = this.rows<{ revision: number; data: string }>('SELECT revision,data FROM cg_events WHERE revision>? ORDER BY revision LIMIT 64', cursor);
      for (const row of rows) {
        const event = JSON.parse(row.data) as WorldEvent;
        if (row.revision !== cursor + 1 || event.invalidation) return initial ? this.snapshotBatch(run) : invalidation;
        bytes += encoder.encode(JSON.stringify(event.changes)).length;
        if (bytes > FRAME_BYTES) return invalidation;
        changes.push(...event.changes);
        cursor = row.revision;
      }
    }
    changes.push({ kind: 'run_update', run: { ...run } });
    const delta: DeltaFrame = { type: 'delta', runId: run.runId, fromRevision: revision, toRevision: run.revision, serverTime: Date.now(), changes };
    const json = JSON.stringify(delta);
    return encoder.encode(json).length <= FRAME_BYTES ? { revision: run.revision, frames: [json] } : invalidation;
  }
  private selectViewerSends(run: RunRecord, now: number): ViewerSend[] {
    if (run.flushAt === undefined || run.flushAt > now) return [];
    run.flushAt = undefined;
    const sends: ViewerSend[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const state = this.viewerState(socket);
      if (!state || state.closed || state.pending || state.runId !== run.runId || state.revision >= run.revision) continue;
      sends.push({ socket, state, batch: this.viewerBatch(run, state.revision, false) });
    }
    // The persisted fallback precedes every send, including a process interruption before attachment writes.
    if (sends.length) run.flushAt = now + VIEWER_ACK_MS;
    return sends;
  }
  private sendViewer({ socket, state, batch }: ViewerSend): void {
    socket.serializeAttachment({ ...state, pending: true, pendingRevision: batch.revision, sentAt: Date.now() } satisfies ViewerState);
    try { for (const frame of batch.frames) socket.send(frame); }
    catch { this.closeViewer(socket, 1013, 'Viewer transport unavailable'); }
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new PublicError('UPGRADE_REQUIRED', 'A WebSocket upgrade is required.');
      if (request.headers.get('Origin') !== url.origin) throw new PublicError('ORIGIN_REJECTED', 'A matching Origin header is required.', 403);
      const route = /^\/api\/runs\/([^/]+)\/socket$/.exec(url.pathname);
      if (!route) throw new PublicError('NOT_FOUND', 'Endpoint not found.', 404);
      const after = url.searchParams.get('after');
      if (after !== null && (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))) throw new PublicError('INVALID_ARGUMENT', 'Invalid viewer cursor.');
      this.expireViewers(Date.now());
      const initial = await this.mutate(run => {
        if (route[1] !== run.runId) throw new PublicError('RUN_NOT_FOUND', 'This mine does not exist.', 404);
        if (this.ctx.getWebSockets().filter(socket => !this.viewerState(socket)?.closed).length >= 20) throw new PublicError('VIEWER_LIMIT', 'This mine allows twenty viewers.', 429);
        const batch = this.viewerBatch(run, after === null ? undefined : Number(after));
        run.flushAt = Math.min(run.flushAt ?? Infinity, Date.now() + VIEWER_ACK_MS);
        return { batch, runId: run.runId };
      });
      // Recheck after the storage await: concurrent upgrades cannot overbook viewer capacity.
      if (this.ctx.getWebSockets().filter(socket => !this.viewerState(socket)?.closed).length >= 20) throw new PublicError('VIEWER_LIMIT', 'This mine allows twenty viewers.', 429);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      this.sendViewer({ socket: pair[1], state: { runId: initial.runId, revision: after === null ? 0 : Math.min(Number(after), initial.batch.revision), pending: false }, batch: initial.batch });
      return new Response(null, { status: 101, webSocket: pair[0] });
    } catch (error) {
      if (!(error instanceof PublicError)) throw error;
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = this.viewerState(socket);
    let ack: unknown;
    try { if (typeof message === 'string' && message.length <= 256) ack = JSON.parse(message); } catch { /* Invalid acknowledgements close below. */ }
    const value = ack as { type?: unknown; revision?: unknown } | undefined;
    if (state?.pending && state.sentAt !== undefined && Date.now() - state.sentAt >= VIEWER_ACK_MS) {
      this.closeViewer(socket, 1013, 'Viewer acknowledgement timed out');
    } else if (!state || state.closed || !state.pending || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || value.type !== 'ack' || !Number.isSafeInteger(value.revision) || value.revision !== state.pendingRevision) {
      this.closeViewer(socket, 1008, 'Expected acknowledgement for the pending revision');
    } else {
      socket.serializeAttachment({ ...state, revision: state.pendingRevision!, pending: false, pendingRevision: undefined, sentAt: undefined } satisfies ViewerState);
    }
    await this.mutate(run => {
      const viewer = this.viewerState(socket);
      if (viewer && !viewer.closed && viewer.runId === run.runId && viewer.revision < run.revision) run.flushAt = Math.min(run.flushAt ?? Infinity, Date.now() + 250);
    });
  }
  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    this.closeViewer(socket, code === 1005 ? 1000 : code, reason);
    await this.mutate(() => undefined);
  }
  async webSocketError(socket: WebSocket): Promise<void> {
    this.closeViewer(socket, 1011, 'Viewer connection failed');
    await this.mutate(() => undefined);
  }
  async alarm(): Promise<void> {
    const startedAt = Date.now();
    this.expireViewers(startedAt);
    const work = await this.mutate(run => {
      if (run.mode === 'running') this.finishDue(run, startedAt);
      this.admit(run, startedAt);
      this.sweepNotices(run, startedAt);
      return { deliveries: this.selectDeliveries(run, startedAt), viewers: this.selectViewerSends(run, startedAt) };
    });
    for (const viewer of work.viewers) this.sendViewer(viewer);
    const outcomes = await this.dispatchDeliveries(work.deliveries);
    // Re-read all deadlines after RPC interleaving; never rearm from the selection snapshot.
    await this.mutate(run => {
      this.acknowledgeDeliveries(run, work.deliveries, outcomes, Date.now());
      if (work.deliveries.length) {
        const duration = Math.max(0, Date.now() - startedAt);
        this.metrics.histogram('deliverySweep', duration);
        this.metrics.sample({ deliveryMs: duration });
      }
    });
  }
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}

export function validateToolArguments(tool: string, input: unknown): ToolArguments | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const hasOnly = (keys: string[]): boolean => Object.keys(value).every(key => keys.includes(key));
  const coordinate = (v: unknown): v is { x: number; y: number } => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const p = v as Record<string, unknown>;
    return Object.keys(p).every(k => k === 'x' || k === 'y') && Number.isInteger(p.x) && Number.isInteger(p.y) && Number(p.x) >= 0 && Number(p.x) < WORLD_WIDTH && Number(p.y) >= 0 && Number(p.y) < WORLD_HEIGHT;
  };
  if (tool === 'discover' || tool === 'deposit') return hasOnly([]) ? {} : undefined;
  if (tool === 'walk_to' || tool === 'mine') {
    if (!hasOnly(['x', 'y']) || !coordinate({ x: value.x, y: value.y })) return undefined;
    return { x: Number(value.x), y: Number(value.y) };
  }
  if (tool !== 'talk' || !hasOnly(['audience', 'agentId', 'message', 'at']) || (value.audience !== 'mine' && value.audience !== 'agent') || typeof value.message !== 'string' || !value.message.trim() || new TextEncoder().encode(value.message.trim()).length > 280 || (value.at !== undefined && !coordinate(value.at))) return undefined;
  if (value.audience === 'agent' ? typeof value.agentId !== 'string' || !/^[1-9][0-9]{0,3}$/.test(value.agentId) : value.agentId !== undefined) return undefined;
  return { audience: value.audience, message: value.message.trim(), ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}), ...(value.at ? { at: value.at as { x: number; y: number } } : {}) };
}

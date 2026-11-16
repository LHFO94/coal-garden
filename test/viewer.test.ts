import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import type { Mine } from '../src/worker/mine';
import type { DeltaFrame, RunRecord, ServerFrame, SnapshotRecord, ToolEnvelope } from '../src/shared/protocol';

type MineStub = DurableObjectStub<Mine>;
const sockets: WebSocket[] = [];

class Viewer {
  readonly frames: ServerFrame[] = [];
  readonly raw: string[] = [];
  private readonly waiting: ((frame: ServerFrame) => void)[] = [];
  readonly closed: Promise<CloseEvent>;
  constructor(readonly socket: WebSocket) {
    sockets.push(socket);
    const closed = Promise.withResolvers<CloseEvent>();
    this.closed = closed.promise;
    socket.addEventListener('close', closed.resolve, { once: true });
    socket.addEventListener('message', event => {
      const text = String(event.data);
      const frame = JSON.parse(text) as ServerFrame;
      this.raw.push(text);
      const waiter = this.waiting.shift();
      if (waiter) waiter(frame); else this.frames.push(frame);
    });
    socket.accept();
  }
  async next(): Promise<ServerFrame> {
    const frame = this.frames.shift();
    if (frame) return frame;
    const waiting = Promise.withResolvers<ServerFrame>();
    this.waiting.push(waiting.resolve);
    return waiting.promise;
  }
  async snapshot(): Promise<{ revision: number; records: SnapshotRecord[] }> {
    const begin = await this.next();
    expect(begin.type).toBe('snapshot_begin');
    if (begin.type !== 'snapshot_begin') throw new Error('Expected snapshot beginning');
    const records: SnapshotRecord[] = [];
    for (let index = 0; index < begin.partCount; index++) {
      const frame = await this.next();
      expect(frame.type).toBe('snapshot_part');
      if (frame.type !== 'snapshot_part') throw new Error('Expected snapshot part');
      expect(frame.snapshotId).toBe(begin.snapshotId);
      expect(frame.index).toBe(index);
      records.push(...frame.payload);
    }
    expect(await this.next()).toEqual({ type: 'snapshot_end', snapshotId: begin.snapshotId });
    return { revision: begin.revision, records };
  }
}

function clock() {
  let now = Date.now() + 86_400_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return { now: () => now, advance: (milliseconds: number) => { now += milliseconds; } };
}

async function fixture() {
  const runId = crypto.randomUUID();
  const mine = env.MINES.getByName(`mine:${runId}`);
  await mine.initialize({ runId, seed: 42 });
  return { mine, runId };
}

async function upgrade(mine: MineStub, runId: string, after?: number, origin = 'https://mine.test') {
  return mine.fetch(new Request(`https://mine.test/api/runs/${runId}/socket${after === undefined ? '' : `?after=${after}`}`, { headers: { Upgrade: 'websocket', Origin: origin } }));
}

async function connect(mine: MineStub, runId: string, after?: number) {
  const response = await upgrade(mine, runId, after);
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error('Missing runtime WebSocketPair client');
  return new Viewer(response.webSocket);
}

async function acknowledge(mine: MineStub, viewer: Viewer, revision: number) {
  viewer.socket.send(JSON.stringify({ type: 'ack', revision }));
  let acknowledged = false;
  for (let attempt = 0; attempt < 20 && !acknowledged; attempt++) {
    acknowledged = await runInDurableObject(mine, (_instance, state) => state.getWebSockets().some(socket => {
      const attachment = socket.deserializeAttachment() as { revision: number; pending: boolean; closed?: boolean };
      return !attachment.closed && !attachment.pending && attachment.revision === revision;
    }));
  }
  expect(acknowledged).toBe(true);
}

async function deferDeliveries(mine: MineStub) {
  await runInDurableObject(mine, (_instance, state) => {
    state.storage.sql.exec('UPDATE cg_deliveries SET next_attempt_at=?', Date.now() + 86_400_000).toArray();
  });
}

async function alarm(mine: MineStub) {
  await runInDurableObject(mine, (instance: Mine) => instance.alarm());
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) { try { socket.close(1000, 'Test finished'); } catch { /* Already closed. */ } }
  vi.restoreAllMocks();
  await reset();
});

describe('hibernatable viewer transport', () => {
  it('projects one atomic bounded snapshot and persists its acknowledgement deadline', async () => {
    const time = clock();
    const { mine, runId } = await fixture();
    const viewer = await connect(mine, runId);
    const snapshot = await viewer.snapshot();
    expect(snapshot.revision).toBe(0);
    expect(snapshot.records.filter(record => record.kind === 'run')).toHaveLength(1);
    expect(snapshot.records.filter(record => record.kind === 'tile')).toHaveLength(96 * 64);
    expect(snapshot.records.filter(record => record.kind === 'miner')).toEqual([]);
    for (const raw of viewer.raw) expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(65_536);
    expect(new TextEncoder().encode(JSON.stringify(snapshot.records)).length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(await runInDurableObject(mine, (_instance, state) => state.storage.getAlarm())).toBeLessThanOrEqual(time.now() + 5_000);
    await acknowledge(mine, viewer, snapshot.revision);
    time.advance(5_001);
    await alarm(mine);
    expect(await runInDurableObject(mine, (_instance, state) => state.storage.getAlarm())).toBeNull();
  });

  it('handshakes an unchanged cursor and merges complete run and miner records in deltas', async () => {
    const time = clock();
    const { mine, runId } = await fixture();
    const viewer = await connect(mine, runId, 0);
    expect(await viewer.next()).toMatchObject({ type: 'delta', fromRevision: 0, toRevision: 0, runId });
    await acknowledge(mine, viewer, 0);
    const receipt = await mine.command({ type: 'spawn', count: 1, operationId: crypto.randomUUID() });
    await deferDeliveries(mine);
    time.advance(250);
    await alarm(mine);
    const delta = await viewer.next() as DeltaFrame;
    expect(delta).toMatchObject({ type: 'delta', fromRevision: 0, toRevision: receipt.revision });
    expect(delta.changes.find(change => change.kind === 'miner_upsert')).toMatchObject({ kind: 'miner_upsert', miner: { agentId: '1', state: 'provisioning', lastTools: [] } });
    expect(delta.changes.at(-1)).toMatchObject({ kind: 'run_update', run: { revision: receipt.revision, nextAgentOrdinal: 2, minedCoal: 0, reservedCoal: 0 } });
    await acknowledge(mine, viewer, delta.toRevision);
    expect((await mine.getMetrics()).viewerLag).toBe(0);
  });

  it('recovers retained cursors by delta and missing, expired, or ahead cursors by snapshot', async () => {
    clock();
    const { mine, runId } = await fixture();
    for (const verifiedModelRPM of [20, 30, 40]) await mine.command({ type: 'set_quota', verifiedModelRPM, maxInFlight: 4, operationId: crypto.randomUUID() });
    const retained = await connect(mine, runId, 1);
    const delta = await retained.next() as DeltaFrame;
    expect(delta).toMatchObject({ type: 'delta', fromRevision: 1, toRevision: 3 });
    expect(delta.changes.at(-1)).toMatchObject({ kind: 'run_update', run: { verifiedModelRPM: 40, effectiveRPM: 32 } });
    await acknowledge(mine, retained, 3);
    await runInDurableObject(mine, (_instance, state) => state.storage.sql.exec('DELETE FROM cg_events WHERE revision=2').toArray());
    expect((await (await connect(mine, runId, 1)).snapshot()).revision).toBe(3);
    expect((await (await connect(mine, runId, 100)).snapshot()).revision).toBe(3);
    await runInDurableObject(mine, (_instance, state) => state.storage.sql.exec('DELETE FROM cg_events WHERE revision<=2').toArray());
    expect((await (await connect(mine, runId, 0)).snapshot()).revision).toBe(3);
  });

  it('uses snapshot recovery for a large transaction rather than partial miner deltas', async () => {
    const time = clock();
    const { mine, runId } = await fixture();
    const live = await connect(mine, runId, 0);
    await live.next();
    await acknowledge(mine, live, 0);
    const receipt = await mine.command({ type: 'spawn', count: 150, operationId: crypto.randomUUID() });
    await deferDeliveries(mine);
    time.advance(250);
    await alarm(mine);
    expect(await live.next()).toEqual({ type: 'invalidate', runId, revision: receipt.revision });
    const viewer = await connect(mine, runId, 0);
    const snapshot = await viewer.snapshot();
    expect(snapshot.revision).toBe(receipt.revision);
    expect(snapshot.records.filter(record => record.kind === 'miner')).toHaveLength(150);
    for (const raw of viewer.raw) expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(65_536);
  });

  it('restores attachments across hibernation and streams the next authoritative change', async () => {
    const time = clock();
    const { mine, runId } = await fixture();
    const viewer = await connect(mine, runId);
    await acknowledge(mine, viewer, (await viewer.snapshot()).revision);
    await evictDurableObject(mine, { webSockets: 'hibernate' });
    const receipt = await mine.command({ type: 'resume', operationId: crypto.randomUUID() });
    time.advance(250);
    await alarm(mine);
    const delta = await viewer.next() as DeltaFrame;
    expect(delta).toMatchObject({ type: 'delta', runId, fromRevision: 0, toRevision: receipt.revision });
    expect(delta.changes.at(-1)).toMatchObject({ kind: 'run_update', run: { mode: 'running', generation: 1 } });
    await acknowledge(mine, viewer, receipt.revision);
  });

  it('keeps one pending batch and closes a slow viewer with 1013 without an alarm spin', async () => {
    const time = clock();
    const { mine, runId } = await fixture();
    const viewer = await connect(mine, runId);
    await viewer.snapshot();
    await mine.command({ type: 'set_quota', verifiedModelRPM: 20, maxInFlight: 4, operationId: crypto.randomUUID() });
    time.advance(250);
    await alarm(mine);
    expect(viewer.frames).toEqual([]);
    const pending = await runInDurableObject(mine, (_instance, state) => state.getWebSockets().map(socket => socket.deserializeAttachment()));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ revision: 0, pending: true, pendingRevision: 0 });
    time.advance(4_750);
    await alarm(mine);
    expect((await viewer.closed).code).toBe(1013);
    time.advance(5_001);
    await alarm(mine);
    expect(await runInDurableObject(mine, (_instance, state) => state.storage.getAlarm())).toBeNull();
  });

  it('rejects malformed acknowledgements and enforces origin and twenty-viewer limits', async () => {
    clock();
    const { mine, runId } = await fixture();
    expect((await upgrade(mine, runId, 0, 'https://other.test')).status).toBe(403);
    const malformed = await connect(mine, runId, 0);
    await malformed.next();
    malformed.socket.send(JSON.stringify({ type: 'ack', revision: 1 }));
    expect((await malformed.closed).code).toBe(1008);
    for (let index = 0; index < 20; index++) {
      const viewer = await connect(mine, runId, 0);
      await viewer.next();
    }
    const rejected = await upgrade(mine, runId, 0);
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({ error: { code: 'VIEWER_LIMIT' } });
  });

  it('streams diamond reservations, clears claims on cancellation/completion, and projects separate resource totals', async () => {
    const time = clock();
    const { mine, runId } = await fixture();
    await mine.command({ type: 'spawn', count: 2, operationId: crypto.randomUUID() });
    await mine.command({ type: 'resume', operationId: crypto.randomUUID() });
    await runInDurableObject(mine, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE cg_tiles SET terrain='rock',visible=1,available=0,reserved=0").toArray();
      sql.exec("UPDATE cg_tiles SET terrain='floor' WHERE x=4 AND y=4").toArray();
      sql.exec("UPDATE cg_tiles SET terrain='diamond',available=7 WHERE x=5 AND y=4").toArray();
      const run = JSON.parse(sql.exec<{ data: string }>('SELECT data FROM cg_run WHERE id=1').toArray()[0]!.data) as RunRecord;
      Object.assign(run, { initialCoal: 0, availableCoal: 0, reservedCoal: 0, minedCoal: 0, initialDiamonds: 7, availableDiamonds: 7, reservedDiamonds: 0, minedDiamonds: 0 });
      sql.exec('UPDATE cg_run SET data=? WHERE id=1', JSON.stringify(run)).toArray();
      sql.exec("UPDATE cg_miners SET data=json_set(data,'$.x',4,'$.y',4)").toArray();
    });
    const before = await mine.getSnapshot();
    const tool = (agentId: string): ToolEnvelope => ({ runId, agentId, generation: before.run.generation, operationId: crypto.randomUUID(), observedRevision: before.revision, tool: 'mine', args: { x: 5, y: 4 } });
    const accepted = await mine.applyTool(tool('1'));
    expect(accepted.ok).toBe(true);
    expect((await mine.getSnapshot()).miners[0]!.lastTools).toEqual([]);
    expect(await runInDurableObject(mine, (_instance, state) => {
      const row = state.storage.sql.exec<{ data: string }>('SELECT data FROM cg_miners WHERE agent_id=?', '1').toArray()[0]!;
      const miner: unknown = JSON.parse(row.data);
      if (!miner || typeof miner !== 'object' || !('lastTools' in miner) || !Array.isArray(miner.lastTools)) throw new Error('Missing persisted miner tools');
      return miner.lastTools.length;
    })).toBe(1);
    const acceptedViewer = await connect(mine, runId, before.revision);
    const acceptedDelta = await acceptedViewer.next() as DeltaFrame;
    expect(acceptedDelta.changes.find(change => change.kind === 'tile_upsert')).toMatchObject({ tile: { terrain: 'diamond', claimant: '1', available: 4, reserved: 3 } });
    expect(acceptedDelta.changes.find(change => change.kind === 'action_upsert')).toMatchObject({ action: { resource: 'diamond', quantity: 3 } });
    expect(acceptedDelta.changes.at(-1)).toMatchObject({ run: { availableCoal: 0, reservedCoal: 0, minedCoal: 0, availableDiamonds: 4, reservedDiamonds: 3, minedDiamonds: 0 } });
    const retired = await mine.command({ type: 'retire', agentId: '1', operationId: crypto.randomUUID() });
    const cancelledViewer = await connect(mine, runId, accepted.revision);
    const cancelledDelta = await cancelledViewer.next() as DeltaFrame;
    const cancelledTile = cancelledDelta.changes.find(change => change.kind === 'tile_upsert');
    expect(cancelledTile).toMatchObject({ tile: { available: 7, reserved: 0 } });
    if (cancelledTile?.kind === 'tile_upsert') expect(cancelledTile.tile.claimant).toBeUndefined();
    expect(cancelledDelta.changes.at(-1)).toMatchObject({ run: { availableCoal: 0, reservedCoal: 0, minedCoal: 0, availableDiamonds: 7, reservedDiamonds: 0, minedDiamonds: 0 } });
    await acknowledge(mine, acceptedViewer, accepted.revision);
    await acknowledge(mine, cancelledViewer, retired.revision);
    acceptedViewer.socket.close(1000, 'Projection checked');
    cancelledViewer.socket.close(1000, 'Projection checked');
    const next = await mine.applyTool(tool('2'));
    expect(next.ok).toBe(true);
    await deferDeliveries(mine);
    time.advance(1_500);
    await alarm(mine);
    const completedViewer = await connect(mine, runId, next.revision);
    const completedDelta = await completedViewer.next() as DeltaFrame;
    const completedTile = completedDelta.changes.find(change => change.kind === 'tile_upsert');
    expect(completedTile).toMatchObject({ tile: { terrain: 'diamond', available: 4, reserved: 0 } });
    if (completedTile?.kind === 'tile_upsert') expect(completedTile.tile.claimant).toBeUndefined();
    expect(completedDelta.changes.at(-1)).toMatchObject({ run: { availableCoal: 0, reservedCoal: 0, minedCoal: 0, availableDiamonds: 4, reservedDiamonds: 0, minedDiamonds: 3 } });
    expect(completedDelta.changes.find(change => change.kind === 'miner_upsert')).toMatchObject({ miner: { agentId: '2', coal: 0, diamonds: 3, inventory: { coal: 0, diamonds: 3 } } });
    expect(completedDelta.changes.find(change => change.kind === 'action_upsert')).toMatchObject({ action: { resource: 'diamond', result: { resource: 'diamond', mined: 3 } } });
  });
});

describe('persisted miner delivery scheduling', () => {
  it('dispatches at most twenty-five recipients and durably retries failed stubs', async () => {
    const time = clock();
    const { mine } = await fixture();
    await mine.command({ type: 'spawn', count: 30, operationId: crypto.randomUUID() });
    // The existing Workers test binding intentionally maps MINERS to Mine, so synchronize
    // is unavailable. This exercises real RPC rejection and persistence, never a provider mock.
    await alarm(mine);
    const rows = await runInDurableObject(mine, (_instance, state) => state.storage.sql.exec<{ attempt_count: number; next_attempt_at: number }>('SELECT attempt_count,next_attempt_at FROM cg_deliveries').toArray());
    expect(rows.filter(row => row.attempt_count === 1)).toHaveLength(25);
    expect(rows.filter(row => row.attempt_count === 0)).toHaveLength(5);
    expect(rows.filter(row => row.attempt_count === 1).every(row => row.next_attempt_at === time.now() + 1_000)).toBe(true);
    expect((await mine.getMetrics()).deliveryBacklog).toBe(30);
  });

  it('reconstructs capped exponential retry deadlines after eviction and repairs missing alarms', async () => {
    const time = clock();
    const { mine } = await fixture();
    await mine.command({ type: 'spawn', count: 1, operationId: crypto.randomUUID() });
    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000].entries()) {
      await alarm(mine);
      const row = await runInDurableObject(mine, (_instance, state) => state.storage.sql.exec<{ attempt_count: number; next_attempt_at: number }>('SELECT attempt_count,next_attempt_at FROM cg_deliveries').toArray()[0]!);
      expect(row).toMatchObject({ attempt_count: index + 1, next_attempt_at: time.now() + delay });
      await evictDurableObject(mine);
      time.advance(delay);
    }
    await runInDurableObject(mine, (_instance, state) => state.storage.deleteAlarm());
    await mine.getSnapshot();
    const repaired = await runInDurableObject(mine, (_instance, state) => state.storage.getAlarm());
    expect(repaired).not.toBeNull();
    expect(repaired).toBeGreaterThanOrEqual(time.now());
  });
});

describe('creation receipts and allowance controls', () => {
  it('returns the original creation projection after commands and repairs scheduling on replay', async () => {
    clock();
    const runId = crypto.randomUUID();
    const mine = env.MINES.getByName(`mine:${runId}`);
    const original = await mine.initialize({ runId, seed: 42 });
    await mine.command({ type: 'spawn', count: 1, operationId: crypto.randomUUID() });
    await mine.command({ type: 'resume', operationId: crypto.randomUUID() });
    await runInDurableObject(mine, (_instance, state) => state.storage.deleteAlarm());
    expect(await mine.initialize({ runId, seed: 42 })).toEqual(original);
    expect((await mine.getSnapshot()).miners).toHaveLength(1);
    expect(await runInDurableObject(mine, (_instance, state) => state.storage.getAlarm())).not.toBeNull();
  });

  it('cannot clear an exhausted inference allowance through pause and resume', async () => {
    clock();
    const { mine } = await fixture();
    await mine.command({ type: 'spawn', count: 1, operationId: crypto.randomUUID() });
    await mine.command({ type: 'resume', operationId: crypto.randomUUID() });
    const generation = await runInDurableObject(mine, (_instance, state) => {
      const run = JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM cg_run WHERE id=1').toArray()[0]!.data) as RunRecord;
      run.allowanceMicroUSD = 0;
      state.storage.sql.exec('UPDATE cg_run SET data=? WHERE id=1', JSON.stringify(run)).toArray();
      return run.generation;
    });
    await mine.enqueueDecision({ agentId: '1', generation, burstId: 'allowance-boundary' });
    expect((await mine.getSnapshot()).run).toMatchObject({ mode: 'budget_paused', cause: 'INFERENCE_ALLOWANCE_REACHED' });
    expect(await mine.command({ type: 'pause', operationId: crypto.randomUUID() })).toMatchObject({ mode: 'budget_paused' });
    await expect(Promise.resolve(mine.command({ type: 'resume', operationId: crypto.randomUUID() }))).rejects.toMatchObject({ code: 'ALLOWANCE_REACHED' });
    expect((await mine.getSnapshot()).run).toMatchObject({ mode: 'budget_paused', cause: 'INFERENCE_ALLOWANCE_REACHED' });
    expect(await mine.command({ type: 'stop', operationId: crypto.randomUUID() })).toMatchObject({ mode: 'stopped' });
  });

  it('counts known live terminal usage once, never tokenless authentication failures', async () => {
    const time = clock();
    const { mine, runId } = await fixture();
    await mine.command({ type: 'spawn', count: 1, operationId: crypto.randomUUID() });
    await mine.command({ type: 'resume', operationId: crypto.randomUUID() });
    const generation = (await mine.getSnapshot()).run.generation;
    await mine.enqueueDecision({ agentId: '1', generation, burstId: 'terminal-accounting' });
    const call = await runInDurableObject(mine, (_instance, state) => state.storage.sql.exec<{ grant_id: string; burst_id: string; generation: number }>("SELECT grant_id,burst_id,generation FROM cg_model_calls WHERE state='granted'").toArray()[0]!);
    const invocationId = crypto.randomUUID();
    expect(await mine.claimInference({ runId, agentId: '1', generation: call.generation, burstId: call.burst_id, grantId: call.grant_id, invocationId })).toMatchObject({ ok: true });
    await mine.settleInference({ invocationId, agentId: '1', error: 'Forbidden', status: 403, completedAt: time.now() });
    expect((await mine.getMetrics()).agentsWithRealInference).toBe(0);
    const known = { invocationId, agentId: '1', inputTokens: 10, outputTokens: 5, completedAt: time.now() };
    await mine.settleInference(known);
    await mine.settleInference(known);
    expect((await mine.getMetrics()).agentsWithRealInference).toBe(1);
    expect((await mine.getSnapshot()).miners[0]!.realResponses).toBe(1);
  });

  it.each(['coal', 'diamond'] as const)('records a %s invariant failure after rolling back its attempted mutation', async resource => {
    clock();
    const { mine } = await fixture();
    await runInDurableObject(mine, (_instance, state) => {
      const run = JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM cg_run WHERE id=1').toArray()[0]!.data) as RunRecord;
      if (resource === 'coal') run.availableCoal++; else run.availableDiamonds++;
      state.storage.sql.exec('UPDATE cg_run SET data=? WHERE id=1', JSON.stringify(run)).toArray();
    });
    await expect(Promise.resolve(mine.command({ type: 'spawn', count: 1, operationId: crypto.randomUUID() }))).rejects.toThrow(resource === 'coal' ? 'COAL_RESOURCE_INVARIANT' : 'DIAMOND_RESOURCE_INVARIANT');
    expect((await mine.getSnapshot()).miners).toEqual([]);
    expect((await mine.getMetrics()).invariantFailures).toBe(1);
  });

  it('ends exact-size history pages cleanly but distinguishes pruned cursors', async () => {
    clock();
    const { mine } = await fixture();
    for (const verifiedModelRPM of [20, 30]) await mine.command({ type: 'set_quota', verifiedModelRPM, maxInFlight: 4, operationId: crypto.randomUUID() });
    const full = await mine.getEvents({ limit: 2 });
    expect(full.events).toHaveLength(2);
    expect(full.nextBefore).toBeUndefined();
    expect((await mine.getEvents({ before: 1, limit: 2 })).events).toEqual([]);
    const first = await mine.getEvents({ limit: 1 });
    expect(first.nextBefore).toBe(2);
    expect((await mine.getEvents({ before: first.nextBefore, limit: 1 })).nextBefore).toBeUndefined();
    await runInDurableObject(mine, (_instance, state) => state.storage.sql.exec('DELETE FROM cg_events WHERE revision=1').toArray());
    await expect(Promise.resolve(mine.getEvents({ before: 2, limit: 1 }))).rejects.toMatchObject({ code: 'HISTORY_EXPIRED', status: 410 });
  });
});

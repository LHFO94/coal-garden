import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { Coordinate, PhysicalAction, PublicMiner, RunRecord, RunSnapshot, TileKind, ToolEnvelope, ToolName, ToolResult } from '../src/shared/protocol';
import { HOPPER, INVENTORY_CAPACITY } from '../src/shared/protocol';
import type { Mine } from '../src/worker/mine';

type MineStub = DurableObjectStub<Mine>;
type FixtureTile = Coordinate & { terrain: TileKind; visible?: boolean; available?: number };

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function clock() {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return { advance: (milliseconds: number) => { now += milliseconds; }, now: () => now };
}

async function fixture(options: { tiles?: FixtureTile[]; visible?: boolean; positions?: Record<string, Coordinate> } = {}) {
  const runId = crypto.randomUUID();
  const mine = env.MINES.getByName(`mine:${runId}`);
  await mine.initialize({ runId, seed: 42 });
  await mine.command({ type: 'spawn', count: 2, operationId: crypto.randomUUID() });
  await mine.command({ type: 'resume', operationId: crypto.randomUUID() });
  await runInDurableObject(mine, (_instance, state) => {
    state.storage.transactionSync(() => {
      const sql = state.storage.sql;
      sql.exec('UPDATE cg_tiles SET terrain=\'rock\',visible=?,available=0,reserved=0', Number(options.visible ?? true)).toArray();
      const tiles = options.tiles ?? [
        { x: 4, y: 4, terrain: 'floor' },
        { x: 5, y: 4, terrain: 'coal', available: 7 },
      ];
      for (const tile of tiles) {
        sql.exec('UPDATE cg_tiles SET terrain=?,visible=?,available=? WHERE x=? AND y=?', tile.terrain, Number(tile.visible ?? options.visible ?? true), tile.available ?? 0, tile.x, tile.y).toArray();
      }
      const row = sql.exec<{ data: string }>('SELECT data FROM cg_run WHERE id=1').toArray()[0]!;
      const run = JSON.parse(row.data) as RunRecord;
      const totals = sql.exec<{ terrain: string; total: number }>('SELECT terrain,SUM(available) AS total FROM cg_tiles GROUP BY terrain').toArray();
      const coal = totals.find(row => row.terrain === 'coal')?.total ?? 0;
      const diamonds = totals.find(row => row.terrain === 'diamond')?.total ?? 0;
      Object.assign(run, { initialCoal: coal, availableCoal: coal, reservedCoal: 0, minedCoal: 0, initialDiamonds: diamonds, availableDiamonds: diamonds, reservedDiamonds: 0, minedDiamonds: 0, exhausted: false });
      sql.exec('UPDATE cg_run SET data=? WHERE id=1', JSON.stringify(run)).toArray();
      for (const row of sql.exec<{ agent_id: string; data: string }>('SELECT agent_id,data FROM cg_miners').toArray()) {
        const miner = JSON.parse(row.data) as PublicMiner;
        Object.assign(miner, { x: 4, y: 4, ...options.positions?.[row.agent_id], generation: run.generation, state: 'idle', provisioned: true, coal: 0, diamonds: 0 });
        delete miner.activeAction;
        sql.exec('UPDATE cg_miners SET data=? WHERE agent_id=?', JSON.stringify(miner), row.agent_id).toArray();
      }
    });
  });
  const snapshot = await mine.getSnapshot();
  const envelope = (agentId: string, tool: ToolName, args: unknown): ToolEnvelope => ({
    runId, agentId, generation: snapshot.run.generation,
    operationId: `${runId}/${agentId}/${snapshot.run.generation}/${crypto.randomUUID()}/${tool}`,
    observedRevision: snapshot.revision, tool, args,
  });
  return { mine, envelope, generation: snapshot.run.generation };
}

function accepted(result: ToolResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected accepted effect, received ${result.code}`);
  return result;
}

function action(result: ToolResult): PhysicalAction {
  const value = accepted(result).action;
  expect(value).toBeDefined();
  if (!value) throw new Error('Expected a physical action');
  return value;
}

function conservation(snapshot: RunSnapshot, coal = 7, diamonds = 0) {
  expect(snapshot.run.initialCoal).toBe(coal);
  expect(snapshot.run.availableCoal + snapshot.run.reservedCoal + snapshot.run.minedCoal).toBe(coal);
  expect(snapshot.run.initialDiamonds).toBe(diamonds);
  expect(snapshot.run.availableDiamonds + snapshot.run.reservedDiamonds + snapshot.run.minedDiamonds).toBe(diamonds);
  expect(snapshot.miners.reduce((total, miner) => total + miner.inventory.coal, snapshot.run.hopper.coal)).toBe(snapshot.run.minedCoal);
  expect(snapshot.miners.reduce((total, miner) => total + miner.inventory.diamonds, snapshot.run.hopper.diamonds)).toBe(snapshot.run.minedDiamonds);
  expect(snapshot.miners.every(miner => miner.inventory.coal + miner.inventory.diamonds <= INVENTORY_CAPACITY)).toBe(true);
  for (const value of [snapshot.run.availableCoal, snapshot.run.reservedCoal, snapshot.run.availableDiamonds, snapshot.run.reservedDiamonds]) expect(value).toBeGreaterThanOrEqual(0);
  expect(snapshot.tiles.every(tile => tile.available >= 0 && tile.reserved >= 0)).toBe(true);
}

async function savedActions(mine: MineStub): Promise<PhysicalAction[]> {
  return runInDurableObject(mine, (_instance, state) => state.storage.sql.exec<{ data: string }>('SELECT data FROM cg_actions ORDER BY action_id').toArray().map(row => JSON.parse(row.data) as PhysicalAction));
}

describe('authoritative Mine tools', () => {
  it.each(['coal', 'diamond'] as const)('reserves at most three %s from a legacy seam despite contention, replay, and restart', async resource => {
    const time = clock();
    const { mine, envelope } = await fixture({ tiles: [{ x: 4, y: 4, terrain: 'floor' }, { x: 5, y: 4, terrain: resource, available: 7 }] });
    const requests = ['1', '2'].map(id => envelope(id, 'mine', { x: 5, y: 4 }));
    const results = await Promise.all(requests.map(request => mine.applyTool(request)));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    const winningIndex = results.findIndex(result => result.ok);
    const winner = String(winningIndex + 1);
    expect(results[1 - winningIndex]).toMatchObject({ ok: false, code: 'CLAIMED', claimant: winner });
    expect(accepted(results[winningIndex]!).acceptedAmount).toBe(3);
    const extraction = action(results[winningIndex]!);
    expect(extraction.resource).toBe(resource);
    expect(extraction.endsAt - extraction.startedAt).toBe(1_500);
    let snapshot = await mine.getSnapshot();
    expect(snapshot.run).toMatchObject(resource === 'coal' ? { availableCoal: 4, reservedCoal: 3, minedCoal: 0 } : { availableDiamonds: 4, reservedDiamonds: 3, minedDiamonds: 0 });
    conservation(snapshot, resource === 'coal' ? 7 : 0, resource === 'diamond' ? 7 : 0);
    await evictDurableObject(mine);
    expect(await mine.applyTool(requests[winningIndex]!)).toEqual(results[winningIndex]);
    time.advance(1_499);
    await runDurableObjectAlarm(mine);
    expect((await savedActions(mine))[0]?.status).toBe('accepted');
    time.advance(1);
    await runDurableObjectAlarm(mine);
    await runDurableObjectAlarm(mine);
    snapshot = await mine.getSnapshot();
    expect(snapshot.run).toMatchObject({ availableCoal: resource === 'coal' ? 4 : 0, reservedCoal: 0, minedCoal: resource === 'coal' ? 3 : 0, availableDiamonds: resource === 'diamond' ? 4 : 0, reservedDiamonds: 0, minedDiamonds: resource === 'diamond' ? 3 : 0 });
    expect(snapshot.miners.find(miner => miner.agentId === winner)).toMatchObject({ coal: resource === 'coal' ? 3 : 0, diamonds: resource === 'diamond' ? 3 : 0, inventory: { coal: resource === 'coal' ? 3 : 0, diamonds: resource === 'diamond' ? 3 : 0 } });
    expect(snapshot.tiles.find(tile => tile.x === 5 && tile.y === 4)).toMatchObject({ terrain: resource, available: 4, reserved: 0 });
    expect(await savedActions(mine)).toMatchObject([{ status: 'completed', resource, result: { mined: 3, resource } }]);
    expect(await mine.applyTool(requests[winningIndex]!)).toEqual(results[winningIndex]);
    expect(await mine.applyTool(envelope(winner, 'mine', { x: 5, y: 4 }))).toMatchObject({ ok: false, code: 'INVENTORY_FULL', nearestFloor: HOPPER });
    const value = resource === 'coal' ? 3 : 30;
    const metrics = await mine.getMetrics();
    expect(metrics).toMatchObject({ coal: resource === 'coal' ? 3 : 0, diamonds: resource === 'diamond' ? 3 : 0, value, reservedMicroUSD: 0, observedMicroUSD: 0 });
    expect(metrics.valuePerMinute).toBe(value * 60_000 / 1_500);
    expect(metrics.buckets.reduce((total, bucket) => total + bucket.value, 0)).toBe(value);
    expect(metrics.buckets.reduce((total, bucket) => total + bucket.diamonds, 0)).toBe(resource === 'diamond' ? 3 : 0);
    expect((await mine.getEvents({ limit: 100 })).events.find(event => event.detail?.completed === true)?.detail).toMatchObject({ resource, mined: 3, value });
    conservation(snapshot, resource === 'coal' ? 7 : 0, resource === 'diamond' ? 7 : 0);
  });

  it('opens a depleted one-unit tile for movement, exposes the next diamond legally, and never respawns either resource', async () => {
    const time = clock();
    const { mine, envelope } = await fixture({ tiles: [
      { x: 4, y: 4, terrain: 'floor' },
      { x: 5, y: 4, terrain: 'coal', available: 1 },
      { x: 6, y: 4, terrain: 'diamond', available: 1 },
    ] });
    expect((await mine.observe('1')).resourceTargets.map(target => target.resource)).toEqual(['coal']);
    expect(accepted(await mine.applyTool(envelope('1', 'mine', { x: 5, y: 4 }))).acceptedAmount).toBe(1);
    time.advance(1_500);
    await runDurableObjectAlarm(mine);
    expect((await mine.observe('1')).resourceTargets).toMatchObject([{ resource: 'diamond', unitValue: 10, destination: { x: 5, y: 4 }, distance: 1 }]);
    expect(await mine.applyTool(envelope('1', 'mine', { x: 6, y: 4 }))).toMatchObject({ ok: false, code: 'TOO_FAR' });
    accepted(await mine.applyTool(envelope('1', 'walk_to', { x: 5, y: 4 })));
    time.advance(250);
    await runDurableObjectAlarm(mine);
    expect(accepted(await mine.applyTool(envelope('1', 'mine', { x: 6, y: 4 }))).acceptedAmount).toBe(1);
    time.advance(1_500);
    await runDurableObjectAlarm(mine);
    const snapshot = await mine.getSnapshot();
    expect(snapshot.miners[0]).toMatchObject({ x: 5, y: 4, coal: 1, diamonds: 1 });
    conservation(snapshot, 1, 1);
    expect(await mine.getMetrics()).toMatchObject({ coal: 1, diamonds: 1, value: 11 });
    expect(await mine.observe('1')).toMatchObject({ exhausted: false, resourceTargets: [], frontiers: [], self: { inventory: { coal: 1, diamonds: 1 } } });
    await evictDurableObject(mine);
    time.advance(60_000);
    await runDurableObjectAlarm(mine);
    const later = await mine.getSnapshot();
    expect(later.tiles.filter(tile => tile.x >= 5 && tile.x <= 6 && tile.y === 4).every(tile => tile.terrain === 'floor' && tile.available === 0 && tile.reserved === 0)).toBe(true);
    conservation(later, 1, 1);
    expect(await mine.getMetrics()).toMatchObject({ coal: 1, diamonds: 1, value: 11 });
  });

  it('replays committed effects before the pause fence, but rejects new stale effects and changed operation arguments', async () => {
    clock();
    const { mine, envelope } = await fixture();
    const request = envelope('1', 'mine', { x: 5, y: 4 });
    const result = await mine.applyTool(request);
    accepted(result);
    await mine.command({ type: 'pause', operationId: crypto.randomUUID() });
    expect(await mine.applyTool(request)).toEqual(result);
    expect(await mine.applyTool(envelope('2', 'mine', { x: 5, y: 4 }))).toMatchObject({ ok: false, code: 'STALE_GENERATION' });
    expect(await mine.applyTool({ ...request, args: { x: 4, y: 5 } })).toMatchObject({ ok: false, code: 'OPERATION_CONFLICT' });
    expect(await savedActions(mine)).toHaveLength(1);
    conservation(await mine.getSnapshot());
  });

  it('validates the actual RPC values, including fractions, bounds, extra fields, and nested coordinates', async () => {
    clock();
    const { mine, envelope } = await fixture();
    const invalid: [ToolName, unknown][] = [
      ['walk_to', { x: -1, y: 4 }], ['walk_to', { x: 96, y: 4 }],
      ['walk_to', { x: 4, y: 64 }], ['walk_to', { x: 4.5, y: 4 }],
      ['walk_to', { x: '4', y: 4 }], ['walk_to', { x: 4, y: 4, path: [] }],
      ['mine', { x: 5, y: 4, amount: 1 }], ['mine', { x: 5, y: 4, amount: 5 }],
      ['mine', { x: 5.5, y: 4 }], ['mine', { x: 5, y: 4, agentId: '2' }],
      ['discover', { radius: 20 }],
      ['talk', { audience: 'mine', message: 'seam', at: { x: 5.5, y: 4 } }],
      ['talk', { audience: 'mine', message: 'seam', at: { x: 5, y: 4, hidden: true } }],
      ['talk', { audience: 'mine', message: 'seam', permission: 'admin' }],
    ];
    for (const [tool, args] of invalid) {
      expect(await mine.applyTool(envelope('1', tool, args)), JSON.stringify({ tool, args })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    }
    expect(await savedActions(mine)).toEqual([]);
    expect((await mine.getSnapshot()).messages).toEqual([]);
    conservation(await mine.getSnapshot());
  });

  it('walks only legal visible paths, bounds an action to 32 steps, and never teleports or overlaps actions', async () => {
    const time = clock();
    const tiles: FixtureTile[] = Array.from({ length: 41 }, (_, index) => ({ x: index + 4, y: 4, terrain: 'floor' }));
    tiles.push({ x: 45, y: 4, terrain: 'floor', visible: false }, { x: 46, y: 4, terrain: 'floor' });
    const { mine, envelope } = await fixture({ tiles });
    expect(await mine.applyTool(envelope('1', 'walk_to', { x: 4, y: 4 }))).toMatchObject({ ok: false, code: 'NO_CHANGE' });
    expect(await mine.applyTool(envelope('1', 'walk_to', { x: 45, y: 4 }))).toMatchObject({ ok: false, code: 'UNKNOWN_TILE' });
    expect(await mine.applyTool(envelope('1', 'walk_to', { x: 4, y: 3 }))).toMatchObject({ ok: false, code: 'BLOCKED' });
    expect(await mine.applyTool(envelope('1', 'walk_to', { x: 46, y: 4 }))).toMatchObject({ ok: false, code: 'UNREACHABLE' });
    const result = accepted(await mine.applyTool(envelope('1', 'walk_to', { x: 44, y: 4 })));
    const walk = action(result);
    expect(result.endpoint).toEqual({ x: 36, y: 4 });
    expect(walk.path).toHaveLength(32);
    expect(walk.endsAt - walk.startedAt).toBe(8_000);
    let previous = { x: 4, y: 4 };
    for (const step of walk.path) {
      expect(Math.abs(step.x - previous.x) + Math.abs(step.y - previous.y)).toBe(1);
      expect(tiles.find(tile => tile.x === step.x && tile.y === step.y)).toMatchObject({ terrain: 'floor' });
      previous = step;
    }
    expect((await mine.getSnapshot()).miners[0]).toMatchObject({ x: 4, y: 4, state: 'walking' });
    expect(await mine.applyTool(envelope('1', 'discover', {}))).toMatchObject({ ok: false, code: 'BUSY' });
    expect(await mine.applyTool(envelope('1', 'walk_to', { x: 8, y: 4 }))).toMatchObject({ ok: false, code: 'BUSY' });
    time.advance(8_000);
    await runDurableObjectAlarm(mine);
    await runDurableObjectAlarm(mine);
    expect((await mine.getSnapshot()).miners[0]).toMatchObject({ x: 36, y: 4, state: 'idle' });
    expect(await savedActions(mine)).toHaveLength(1);
  });

  it.each(['coal', 'diamond'] as const)('freezes %s extraction and walking during pause and resumes with precisely their remaining duration', async resource => {
    const time = clock();
    const tiles: FixtureTile[] = [
      { x: 5, y: 4, terrain: resource, available: 7 },
      ...Array.from({ length: 8 }, (_, i): FixtureTile => ({ x: 4, y: 4 + i, terrain: 'floor' })),
    ];
    const { mine, envelope } = await fixture({ tiles, positions: { '2': { x: 4, y: 5 } } });
    const extraction = action(await mine.applyTool(envelope('1', 'mine', { x: 5, y: 4 })));
    const walk = action(await mine.applyTool(envelope('2', 'walk_to', { x: 4, y: 11 })));
    expect(walk.endsAt - walk.startedAt).toBe(extraction.endsAt - extraction.startedAt);
    time.advance(750);
    await mine.command({ type: 'pause', operationId: crypto.randomUUID() });
    const paused = await mine.getSnapshot();
    expect(paused.run.pausedAt).toBe(time.now());
    time.advance(60_000);
    await runDurableObjectAlarm(mine);
    expect((await mine.getSnapshot()).run.minedCoal).toBe(0);
    expect((await mine.getSnapshot()).run.minedDiamonds).toBe(0);
    expect((await mine.getSnapshot()).miners[1]).toMatchObject({ x: 4, y: 5 });
    expect((await savedActions(mine)).every(value => value.status === 'accepted')).toBe(true);
    await mine.command({ type: 'resume', operationId: crypto.randomUUID() });
    const resumed = await savedActions(mine);
    for (const original of [extraction, walk]) {
      expect(resumed.find(value => value.actionId === original.actionId)).toMatchObject({ startedAt: original.startedAt + 60_000, endsAt: original.endsAt + 60_000 });
    }
    time.advance(749);
    await runDurableObjectAlarm(mine);
    expect((await mine.getSnapshot()).miners[1]).toMatchObject({ x: 4, y: 5 });
    expect((await mine.getSnapshot()).run.minedCoal).toBe(0);
    expect((await mine.getSnapshot()).run.minedDiamonds).toBe(0);
    time.advance(1);
    await runDurableObjectAlarm(mine);
    expect((await mine.getSnapshot()).miners[1]).toMatchObject({ x: 4, y: 11 });
    await runDurableObjectAlarm(mine);
    expect((await mine.getSnapshot()).run).toMatchObject({ minedCoal: resource === 'coal' ? 3 : 0, minedDiamonds: resource === 'diamond' ? 3 : 0 });
    conservation(await mine.getSnapshot(), resource === 'coal' ? 7 : 0, resource === 'diamond' ? 7 : 0);
  });

  it.each(['coal', 'diamond'] as const)('returns %s reservations once on retirement and stop without fencing another miner on retirement', async resource => {
    const time = clock();
    const { mine, envelope, generation } = await fixture({ tiles: [{ x: 4, y: 4, terrain: 'floor' }, { x: 5, y: 4, terrain: resource, available: 7 }] });
    await mine.applyTool(envelope('1', 'mine', { x: 5, y: 4 }));
    const retire = { type: 'retire' as const, agentId: '1', operationId: crypto.randomUUID() };
    await mine.command(retire);
    await mine.command(retire);
    let snapshot = await mine.getSnapshot();
    expect(snapshot.run).toMatchObject({ generation, availableCoal: resource === 'coal' ? 7 : 0, reservedCoal: 0, minedCoal: 0, availableDiamonds: resource === 'diamond' ? 7 : 0, reservedDiamonds: 0, minedDiamonds: 0 });
    expect(snapshot.miners[0]).toMatchObject({ retired: true, state: 'retired' });
    expect(await mine.applyTool(envelope('1', 'mine', { x: 5, y: 4 }))).toMatchObject({ ok: false, code: 'RETIRED' });
    accepted(await mine.applyTool(envelope('2', 'mine', { x: 5, y: 4 })));
    const stop = { type: 'stop' as const, operationId: crypto.randomUUID() };
    await mine.command(stop);
    await mine.command(stop);
    time.advance(20_000);
    await runDurableObjectAlarm(mine);
    snapshot = await mine.getSnapshot();
    expect(snapshot.run).toMatchObject({ mode: 'stopped', availableCoal: resource === 'coal' ? 7 : 0, reservedCoal: 0, minedCoal: 0, availableDiamonds: resource === 'diamond' ? 7 : 0, reservedDiamonds: 0, minedDiamonds: 0 });
    expect(snapshot.miners.every(miner => !miner.activeAction && miner.coal === 0 && miner.diamonds === 0)).toBe(true);
    expect((await savedActions(mine)).map(value => ({ status: value.status, result: value.result }))).toEqual([{ status: 'cancelled', result: { cancelled: true, resource } }, { status: 'cancelled', result: { cancelled: true, resource } }]);
    conservation(snapshot, resource === 'coal' ? 7 : 0, resource === 'diamond' ? 7 : 0);
  });

  it('discovers precisely radius six and returns accessible frontiers even when there is nothing new', async () => {
    clock();
    const tiles: FixtureTile[] = Array.from({ length: 10 }, (_, i) => ({ x: 4, y: 4 + i, terrain: 'floor', visible: i === 0 }));
    tiles.push({ x: 5, y: 5, terrain: 'diamond', available: 1, visible: false }, { x: 5, y: 6, terrain: 'coal', available: 1, visible: false });
    const { mine, envelope } = await fixture({ tiles, visible: false });
    const discovered = accepted(await mine.applyTool(envelope('1', 'discover', {})));
    const expected: string[] = [];
    for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) {
      if (Math.abs(x - 4) + Math.abs(y - 4) <= 6 && !(x === 4 && y === 4)) expected.push(`${x},${y}`);
    }
    expect(discovered.cells?.map(cell => `${cell.x},${cell.y}`).sort()).toEqual(expected.sort());
    expect(discovered.resourceTargets).toMatchObject([{ x: 5, y: 5, resource: 'diamond', unitValue: 10, destination: { x: 4, y: 5 } }, { x: 5, y: 6, resource: 'coal', unitValue: 1, destination: { x: 4, y: 6 } }]);
    const snapshot = await mine.getSnapshot();
    expect(snapshot.tiles.filter(tile => tile.visible)).toHaveLength(expected.length + 1);
    expect(snapshot.tiles.find(tile => tile.x === 4 && tile.y === 11)?.visible).toBe(false);
    const repeated = await mine.applyTool(envelope('1', 'discover', {}));
    expect(repeated).toMatchObject({ ok: false, code: 'NO_CHANGE' });
    expect(repeated.frontiers).toContainEqual({ x: 4, y: 10, distance: 6 });
    expect((await mine.observe('1')).exhausted).toBe(false);
  });

  it('persists plain coordination once, enforces cooldown and UTF-8 bytes, and restricts direct-message observations', async () => {
    const time = clock();
    const { mine, envelope } = await fixture({ tiles: [
      { x: 4, y: 4, terrain: 'floor' }, { x: 5, y: 4, terrain: 'coal', available: 7 },
      { x: 20, y: 20, terrain: 'rock', visible: false },
    ] });
    const request = envelope('1', 'talk', { audience: 'mine', message: '<seam & useful>', at: { x: 5, y: 4 } });
    const first = accepted(await mine.applyTool(request));
    expect(first.sequence).toBeTypeOf('number');
    expect(await mine.applyTool(request)).toEqual(first);
    expect(await mine.applyTool(envelope('1', 'talk', { audience: 'mine', message: 'too soon' }))).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect((await mine.getSnapshot()).messages).toHaveLength(1);
    time.advance(5_000);
    const direct = accepted(await mine.applyTool(envelope('1', 'talk', { audience: 'agent', agentId: '2', message: 'private seam', at: { x: 5, y: 4 } })));
    expect(direct.sequence).toBe(first.sequence! + 1);
    const recipient = await mine.observe('2');
    expect(recipient.messages.map(message => message.sequence)).toEqual([first.sequence, direct.sequence]);
    expect(recipient.messages[0]?.body).toBe('<seam & useful>');
    expect(recipient.messageCursor).toBeGreaterThanOrEqual(direct.sequence!);
    expect((await mine.observe('1')).messages.map(message => message.sequence)).not.toContain(direct.sequence);
    expect(await mine.applyTool(envelope('2', 'talk', { audience: 'mine', message: 'é'.repeat(141) }))).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await mine.applyTool(envelope('2', 'talk', { audience: 'mine', message: '   ' }))).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await mine.applyTool(envelope('2', 'talk', { audience: 'mine', message: 'hidden', at: { x: 20, y: 20 } }))).toMatchObject({ ok: false, code: 'UNKNOWN_TILE' });
    expect(await mine.applyTool(envelope('2', 'talk', { audience: 'agent', agentId: '999', message: 'unknown' }))).toMatchObject({ ok: false, code: 'NO_SUCH_AGENT' });
    accepted(await mine.applyTool(envelope('2', 'talk', { audience: 'mine', message: 'é'.repeat(140) })));
    expect((await mine.getSnapshot()).messages).toHaveLength(3);
    time.advance(5_000);
    await mine.applyTool(envelope('1', 'mine', { x: 5, y: 4 }));
    accepted(await mine.applyTool(envelope('1', 'talk', { audience: 'mine', message: 'working' })));
  });

  it('observes both revealed resources with diamond preference, legal approaches, and claims, then persists explicit exhaustion', async () => {
    const time = clock();
    const { mine, envelope } = await fixture({ tiles: [
      { x: 4, y: 4, terrain: 'floor' }, { x: 5, y: 4, terrain: 'coal', available: 7 },
      { x: 4, y: 3, terrain: 'diamond', available: 1 },
      { x: 4, y: 5, terrain: 'diamond', available: 3, visible: false },
    ] });
    let observation = await mine.observe('2');
    expect(observation.resourceTargets).toEqual([{ x: 4, y: 3, resource: 'diamond', unitValue: 10, available: 1, reserved: 0, destination: { x: 4, y: 4 }, distance: 0 }, { x: 5, y: 4, resource: 'coal', unitValue: 1, available: 7, reserved: 0, destination: { x: 4, y: 4 }, distance: 0 }]);
    expect(observation.localTiles.every(tile => tile.visible)).toBe(true);
    expect(observation.localTiles.some(tile => tile.x === 4 && tile.y === 5)).toBe(false);
    await mine.applyTool(envelope('1', 'mine', { x: 5, y: 4 }));
    observation = await mine.observe('2');
    expect(observation.resourceTargets[1]).toMatchObject({ resource: 'coal', claimant: '1', reserved: 3, available: 4, destination: { x: 4, y: 4 } });
    expect(observation.exhausted).toBe(false);
    conservation(await mine.getSnapshot(), 7, 4);

    // A separate fully known world avoids treating hidden accessible resources as exhausted.
    const empty = await fixture({ tiles: [{ x: 4, y: 4, terrain: 'floor' }] });
    const exhausted = await empty.mine.observe('1');
    expect(exhausted).toMatchObject({ exhausted: true, resourceTargets: [], frontiers: [], self: { state: 'idle' } });
    expect((await empty.mine.getSnapshot()).run.exhausted).toBe(true);
    time.advance(1_000);
    expect((await empty.mine.observe('2')).exhausted).toBe(true);
  });

  it('shares three slots across ore types and transfers only carried ore once at the hopper across replay and restart', async () => {
    const time = clock();
    const { mine, envelope } = await fixture({ positions: { '1': { x: 44, y: 30 }, '2': HOPPER }, tiles: [
      { x: 44, y: 30, terrain: 'floor' }, { x: 44, y: 29, terrain: 'floor' }, { ...HOPPER, terrain: 'floor' },
      { x: 45, y: 30, terrain: 'coal', available: 2 }, { x: 43, y: 30, terrain: 'diamond', available: 2 },
    ] });
    accepted(await mine.applyTool(envelope('1', 'mine', { x: 45, y: 30 })));
    expect(await mine.applyTool(envelope('1', 'deposit', {}))).toMatchObject({ ok: false, code: 'BUSY' });
    time.advance(1_500); await runDurableObjectAlarm(mine);
    expect(accepted(await mine.applyTool(envelope('1', 'mine', { x: 43, y: 30 }))).acceptedAmount).toBe(1);
    time.advance(1_500); await runDurableObjectAlarm(mine);
    expect((await mine.observe('1')).self.inventory).toEqual({ coal: 2, diamonds: 1 });
    expect(await mine.applyTool(envelope('1', 'mine', { x: 43, y: 30 }))).toMatchObject({ ok: false, code: 'INVENTORY_FULL' });
    expect(await mine.applyTool(envelope('1', 'deposit', {}))).toMatchObject({ ok: false, code: 'TOO_FAR', nearestFloor: HOPPER });
    accepted(await mine.applyTool(envelope('1', 'walk_to', HOPPER)));
    time.advance(500); await runDurableObjectAlarm(mine);
    const deposit = envelope('1', 'deposit', {});
    const results = await Promise.all([mine.applyTool(deposit), mine.applyTool(deposit)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ ok: true, deposited: { coal: 2, diamonds: 1 }, inventory: { coal: 0, diamonds: 0 }, hopper: { ...HOPPER, coal: 2, diamonds: 1 } });
    expect(await mine.applyTool(envelope('1', 'deposit', {}))).toMatchObject({ ok: false, code: 'EMPTY_INVENTORY' });
    expect(await mine.applyTool(envelope('2', 'deposit', {}))).toMatchObject({ ok: false, code: 'EMPTY_INVENTORY' });
    accepted(await mine.applyTool(envelope('1', 'walk_to', { x: 44, y: 30 })));
    time.advance(500); await runDurableObjectAlarm(mine);
    accepted(await mine.applyTool(envelope('1', 'mine', { x: 43, y: 30 })));
    time.advance(1_500); await runDurableObjectAlarm(mine);
    await evictDurableObject(mine);
    expect(await mine.applyTool(deposit)).toEqual(results[0]);
    const snapshot = await mine.getSnapshot();
    expect(snapshot.run.hopper).toEqual({ ...HOPPER, coal: 2, diamonds: 1 });
    expect(snapshot.miners[0]).toMatchObject({ coal: 2, diamonds: 2, inventory: { coal: 0, diamonds: 1 } });
    conservation(snapshot, 2, 2);
    await mine.command({ type: 'pause', operationId: crypto.randomUUID() });
    expect(await mine.applyTool(deposit)).toEqual(results[0]);
  });

  it('keeps the last partial load eligible until an adjacent hopper deposit completes exhaustion', async () => {
    const time = clock();
    const { mine, envelope, generation } = await fixture({ positions: { '1': { x: 44, y: 29 }, '2': HOPPER }, tiles: [
      { ...HOPPER, terrain: 'floor' }, { x: 44, y: 29, terrain: 'floor' }, { x: 45, y: 29, terrain: 'coal', available: 1 },
    ] });
    accepted(await mine.applyTool(envelope('1', 'mine', { x: 45, y: 29 })));
    time.advance(1_500); await runDurableObjectAlarm(mine);
    expect(await mine.observe('1')).toMatchObject({ exhausted: false, hopper: { ...HOPPER, coal: 0, diamonds: 0 }, self: { inventory: { coal: 1, diamonds: 0 } } });
    expect(await mine.enqueueDecision({ agentId: '1', generation, burstId: crypto.randomUUID() })).toMatchObject({ status: 'queued' });
    accepted(await mine.applyTool(envelope('1', 'deposit', {})));
    expect((await mine.getSnapshot()).run).toMatchObject({ exhausted: true, hopper: { coal: 1, diamonds: 0 } });
    expect(await mine.enqueueDecision({ agentId: '1', generation, burstId: crypto.randomUUID() })).toMatchObject({ status: 'exhausted' });
    conservation(await mine.getSnapshot(), 1, 0);
  });

  it('knows the hopper outside local sight and walks unseen floor in bounded physical legs without revealing nearby ore', async () => {
    const time = clock();
    const { mine, envelope } = await fixture({ visible: false, positions: { '1': { x: 4, y: 28 }, '2': { x: 4, y: 28 } }, tiles: [
      ...Array.from({ length: 41 }, (_, i): FixtureTile => ({ x: i + 4, y: 28, terrain: 'floor', visible: i === 0 || i === 40 })),
      { x: 20, y: 27, terrain: 'diamond', available: 1, visible: false },
    ] });
    expect(await mine.observe('1')).toMatchObject({ hopper: { ...HOPPER, coal: 0, diamonds: 0 }, resourceTargets: [] });
    expect(await mine.applyTool(envelope('1', 'walk_to', { x: 5, y: 28 }))).toMatchObject({ ok: false, code: 'UNKNOWN_TILE' });
    const first = action(await mine.applyTool(envelope('1', 'walk_to', HOPPER)));
    expect(first.path).toHaveLength(32);
    expect(first.target).toEqual({ x: 36, y: 28 });
    expect((await mine.getSnapshot()).miners[0]).toMatchObject({ x: 4, y: 28 });
    expect(await mine.applyTool(envelope('1', 'deposit', {}))).toMatchObject({ ok: false, code: 'BUSY' });
    await evictDurableObject(mine);
    time.advance(8_000); await runDurableObjectAlarm(mine);
    expect((await mine.getSnapshot()).miners[0]).toMatchObject({ x: 36, y: 28 });
    const second = action(await mine.applyTool(envelope('1', 'walk_to', HOPPER)));
    expect(second.path).toHaveLength(8);
    expect(second.target).toEqual(HOPPER);
    time.advance(2_000); await runDurableObjectAlarm(mine);
    const snapshot = await mine.getSnapshot();
    expect(snapshot.miners[0]).toMatchObject(HOPPER);
    expect(snapshot.tiles.find(tile => tile.x === 20 && tile.y === 27)?.visible).toBe(false);
    expect(snapshot.tiles.filter(tile => tile.visible && tile.y === 28)).toHaveLength(41);
    conservation(snapshot, 0, 1);
  });
});

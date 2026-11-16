import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { canonical, type Mine } from '../src/worker/mine';
import { initializeSchema } from '../src/worker/storage';
import type { PhysicalAction, PublicMiner, RunRecord, RunSnapshot, ToolEnvelope, ToolResult } from '../src/shared/protocol';
import { HOPPER } from '../src/shared/protocol';
import { tileKey } from '../src/shared/world';

type MineStub = DurableObjectStub<Mine>;
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

function clock() {
  let now = Date.now() + 86_400_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return { now: () => now, advance: (milliseconds: number) => { now += milliseconds; } };
}

async function receipts(mine: MineStub) {
  return runInDurableObject(mine, (_instance, state) => state.storage.sql.exec<{ operation_id: string; fingerprint: string; result: string }>('SELECT * FROM cg_receipts ORDER BY operation_id').toArray());
}

async function actions(mine: MineStub) {
  return runInDurableObject(mine, (_instance, state) => state.storage.sql.exec<{ data: string }>('SELECT data FROM cg_actions ORDER BY action_id').toArray().map(row => JSON.parse(row.data) as PhysicalAction));
}

async function legacyFixture(quantity = 3) {
  const runId = crypto.randomUUID();
  const mine = env.MINES.getByName(`mine:${runId}`);
  await mine.initialize({ runId, seed: 42 });
  await mine.command({ type: 'spawn', count: 2, operationId: crypto.randomUUID() });
  await mine.command({ type: 'resume', operationId: crypto.randomUUID() });
  const before = await mine.getSnapshot();
  // An actually accepted pre-cutover request still includes amount and lacks resource.
  const request: ToolEnvelope = { runId, agentId: '1', generation: before.run.generation, operationId: `historic:${runId}`, observedRevision: before.revision, tool: 'mine', args: { x: 5, y: 4, amount: quantity } };
  const effectId = `tool:${request.operationId}`;
  const action: PhysicalAction = { actionId: effectId, effectId, agentId: '1', kind: 'mine', generation: before.run.generation, origin: { x: 4, y: 4 }, path: [], target: { x: 5, y: 4 }, quantity, startedAt: Date.now(), endsAt: Date.now() + 7_500, status: 'accepted' };
  const result: ToolResult = { ok: true, revision: before.revision, action, acceptedAmount: quantity };
  const legacy = await runInDurableObject(mine, (_instance, state) => state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    sql.exec("UPDATE cg_tiles SET terrain='rock',visible=1,available=0,reserved=0").toArray();
    sql.exec("UPDATE cg_tiles SET terrain='floor' WHERE x=4 AND y=4").toArray();
    sql.exec("UPDATE cg_tiles SET terrain='coal',available=?,reserved=? WHERE x=5 AND y=4", 7 - quantity, quantity).toArray();
    sql.exec("UPDATE cg_tiles SET terrain='coal',available=50 WHERE x=4 AND y=5").toArray();
    sql.exec(`
      ALTER TABLE cg_tiles RENAME TO cg_tiles_modern;
      CREATE TABLE cg_tiles (
        key INTEGER PRIMARY KEY,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        terrain TEXT NOT NULL CHECK (terrain IN ('floor','rock','coal')),
        visible INTEGER NOT NULL CHECK (visible IN (0,1)),
        available INTEGER NOT NULL CHECK (available>=0),
        reserved INTEGER NOT NULL CHECK (reserved>=0 AND reserved<=5),
        UNIQUE (x,y)
      );
      INSERT INTO cg_tiles SELECT key,x,y,terrain,visible,available,reserved FROM cg_tiles_modern;
      DROP TABLE cg_tiles_modern;
      CREATE INDEX cg_tiles_visible ON cg_tiles(visible);
      CREATE INDEX cg_tiles_stock ON cg_tiles(terrain,available);
      CREATE TABLE unrelated_records (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO unrelated_records VALUES ('preserve','other owner');
      DELETE FROM cg_schema_migrations;
    `).toArray();
    const run = JSON.parse(sql.exec<{ data: string }>('SELECT data FROM cg_run WHERE id=1').toArray()[0]!.data) as RunRecord;
    Object.assign(run, { initialCoal: 60, availableCoal: 57 - quantity, reservedCoal: quantity, minedCoal: 3 });
    for (const field of ['initialDiamonds', 'availableDiamonds', 'reservedDiamonds', 'minedDiamonds', 'hopper'] as const) delete (run as Partial<RunRecord>)[field];
    sql.exec('UPDATE cg_run SET data=? WHERE id=1', JSON.stringify(run)).toArray();
    for (const row of sql.exec<{ agent_id: string; data: string }>('SELECT agent_id,data FROM cg_miners').toArray()) {
      const miner = JSON.parse(row.data) as PublicMiner;
      Object.assign(miner, { x: 4, y: 4, provisioned: true, state: row.agent_id === '1' ? 'mining' : 'idle', coal: row.agent_id === '1' ? 3 : 0 });
      if (row.agent_id === '1') miner.activeAction = action.actionId;
      delete (miner as Partial<PublicMiner>).diamonds;
      delete (miner as Partial<PublicMiner>).inventory;
      sql.exec('UPDATE cg_miners SET data=? WHERE agent_id=?', JSON.stringify(miner), row.agent_id).toArray();
    }
    sql.exec("INSERT INTO cg_actions VALUES(?,?,?,'mine',?,?,?,'accepted',?)", action.actionId, action.effectId, action.agentId, action.generation, tileKey(5, 4), action.endsAt, JSON.stringify(action)).toArray();
    sql.exec('INSERT INTO cg_receipts VALUES(?,?,?)', effectId, canonical({ runId, agentId: request.agentId, generation: request.generation, tool: request.tool, args: request.args }), JSON.stringify(result)).toArray();
    const creationRow = sql.exec<{ result: string }>('SELECT result FROM cg_receipts WHERE operation_id=?', `create:${runId}`).toArray()[0]!;
    const creation = JSON.parse(creationRow.result) as RunSnapshot;
    creation.run.initialCoal = (creation.run.initialCoal + creation.run.initialDiamonds) * 50;
    creation.run.availableCoal = creation.run.initialCoal;
    for (const field of ['initialDiamonds', 'availableDiamonds', 'reservedDiamonds', 'minedDiamonds', 'hopper'] as const) delete (creation.run as Partial<RunRecord>)[field];
    for (const tile of creation.tiles) if (tile.terrain === 'coal' || tile.terrain === 'diamond') { tile.terrain = 'coal'; tile.available = 50; }
    sql.exec('UPDATE cg_receipts SET result=? WHERE operation_id=?', JSON.stringify(creation), `create:${runId}`).toArray();
    const second = Math.floor(Date.now() / 1000);
    const sample = { second, calls: 2, coal: 3, errors: 1, toolRPCs: 4, deliveryMs: 9 };
    sql.exec('INSERT INTO cg_samples VALUES(?,?)', second, JSON.stringify(sample)).toArray();
    sql.exec('UPDATE cg_deliveries SET next_attempt_at=?', Date.now() + 86_400_000).toArray();
    return { run, creation, sample, tiles: sql.exec('SELECT * FROM cg_tiles ORDER BY key').toArray(), indexes: sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='cg_tiles' AND sql IS NOT NULL ORDER BY name").toArray() };
  }));
  const originalReceipts = await receipts(mine);
  await evictDurableObject(mine);
  return { mine, runId, request, action, result, legacy, originalReceipts };
}

describe('persisted resource schema migration', () => {
  it('preserves old terrain, coal, indexes, actions, exact receipts, and other tables; backfills once across restarts', async () => {
    clock();
    const { mine, runId, action, request, result, legacy, originalReceipts } = await legacyFixture();
    const snapshot = await mine.getSnapshot();
    expect(snapshot.run).toMatchObject({ runId, mode: 'running', initialCoal: 60, availableCoal: 54, reservedCoal: 3, minedCoal: 3, initialDiamonds: 0, availableDiamonds: 0, reservedDiamonds: 0, minedDiamonds: 0, hopper: { ...HOPPER, coal: 3, diamonds: 0 } });
    expect(snapshot.miners.map(miner => ({ agentId: miner.agentId, coal: miner.coal, diamonds: miner.diamonds }))).toEqual([{ agentId: '1', coal: 3, diamonds: 0 }, { agentId: '2', coal: 0, diamonds: 0 }]);
    expect(snapshot.miners.every(miner => miner.inventory.coal === 0 && miner.inventory.diamonds === 0)).toBe(true);
    expect(await actions(mine)).toEqual([action]);
    expect(await mine.applyTool(request)).toEqual(result);
    expect(await mine.initialize({ runId, seed: 42 })).toEqual(legacy.creation);
    expect(await receipts(mine)).toEqual(originalReceipts);
    expect((await mine.getMetrics()).buckets).toEqual([{ ...legacy.sample, diamonds: 0, value: 3 }]);
    await runInDurableObject(mine, (_instance, state) => {
      const sql = state.storage.sql;
      expect(sql.exec('SELECT * FROM cg_tiles ORDER BY key').toArray()).toEqual(legacy.tiles);
      expect(sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='cg_tiles' AND sql IS NOT NULL ORDER BY name").toArray()).toEqual(legacy.indexes);
      expect(sql.exec('SELECT * FROM unrelated_records').toArray()).toEqual([{ id: 'preserve', value: 'other owner' }]);
      sql.exec("CREATE TRIGGER no_repeated_sample_backfill BEFORE UPDATE ON cg_samples BEGIN SELECT RAISE(ABORT,'repeated migration'); END").toArray();
      state.storage.transactionSync(() => initializeSchema(sql));
    });
    await evictDurableObject(mine);
    expect((await mine.getSnapshot()).run).toMatchObject({ initialCoal: 60, minedCoal: 3, availableCoal: 54, reservedCoal: 3, initialDiamonds: 0, hopper: { coal: 3, diamonds: 0 } });
    expect(await mine.initialize({ runId, seed: 42 })).toEqual(legacy.creation);
    expect(await receipts(mine)).toEqual(originalReceipts);
  });

  it('finishes a capacity-safe historic action at its deadline and restricts new legacy-seam extraction to three rocks', async () => {
    const time = clock();
    const { mine, runId, action, request, result } = await legacyFixture();
    expect((await mine.getSnapshot()).actions).toEqual([action]);
    await mine.command({ type: 'pause', operationId: crypto.randomUUID() });
    expect(await mine.applyTool(request)).toEqual(result);
    await mine.command({ type: 'resume', operationId: crypto.randomUUID() });
    time.advance(7_499);
    await runDurableObjectAlarm(mine);
    expect((await mine.getSnapshot()).run.minedCoal).toBe(3);
    time.advance(1);
    await runDurableObjectAlarm(mine);
    await runDurableObjectAlarm(mine);
    let snapshot = await mine.getSnapshot();
    expect(snapshot.run).toMatchObject({ initialCoal: 60, availableCoal: 54, reservedCoal: 0, minedCoal: 6, minedDiamonds: 0, hopper: { coal: 3, diamonds: 0 } });
    expect(snapshot.miners[0]).toMatchObject({ coal: 6, diamonds: 0, inventory: { coal: 3, diamonds: 0 } });
    expect((await actions(mine))[0]).toMatchObject({ quantity: 3, startedAt: action.startedAt, endsAt: action.endsAt, resource: 'coal', result: { resource: 'coal', mined: 3 } });
    expect(snapshot.tiles[tileKey(5, 4)]).toMatchObject({ terrain: 'coal', available: 4, reserved: 0 });
    const next = await mine.applyTool({ runId, agentId: '2', generation: snapshot.run.generation, operationId: crypto.randomUUID(), observedRevision: snapshot.revision, tool: 'mine', args: { x: 4, y: 5 } });
    expect(next).toMatchObject({ ok: true, acceptedAmount: 3, action: { quantity: 3, resource: 'coal' } });
    if (!next.ok || !next.action) throw new Error('Expected full legacy deposit reservation');
    expect(next.action.endsAt - next.action.startedAt).toBe(1_500);
    time.advance(1_500);
    await runDurableObjectAlarm(mine);
    await runDurableObjectAlarm(mine);
    snapshot = await mine.getSnapshot();
    expect(snapshot.run).toMatchObject({ initialCoal: 60, availableCoal: 51, reservedCoal: 0, minedCoal: 9, initialDiamonds: 0, minedDiamonds: 0 });
    expect(snapshot.miners[1]).toMatchObject({ coal: 3, diamonds: 0, inventory: { coal: 3, diamonds: 0 } });
    expect(snapshot.tiles[tileKey(4, 5)]).toMatchObject({ terrain: 'coal', available: 47, reserved: 0 });
    expect(await mine.applyTool(request)).toEqual(result);
    expect(await mine.getMetrics()).toMatchObject({ coal: 9, diamonds: 0, value: 9 });
  });

  it('refunds oversized historic claims once on upgrade, then retirement and restart never duplicate the refund', async () => {
    const time = clock();
    const { mine, action } = await legacyFixture(5);
    const retire = { type: 'retire' as const, agentId: '1', operationId: crypto.randomUUID() };
    await mine.command(retire);
    await mine.command(retire);
    await evictDurableObject(mine);
    time.advance(10_000);
    await runDurableObjectAlarm(mine);
    const snapshot = await mine.getSnapshot();
    expect(snapshot.run).toMatchObject({ initialCoal: 60, minedCoal: 3, availableCoal: 57, reservedCoal: 0, initialDiamonds: 0, minedDiamonds: 0, availableDiamonds: 0, reservedDiamonds: 0 });
    expect(snapshot.miners[0]).toMatchObject({ coal: 3, diamonds: 0, retired: true });
    expect((await actions(mine))[0]).toMatchObject({ actionId: action.actionId, quantity: 5, startedAt: action.startedAt, endsAt: action.endsAt, status: 'cancelled', resource: 'coal', result: { cancelled: true, resource: 'coal' } });
    expect((await mine.getMetrics()).actionCancellations).toBe(1);
  });

  it('backfills from existing diamond stock and miner credit without replacing existing counters or terrain', async () => {
    clock();
    const runId = crypto.randomUUID();
    const mine = env.MINES.getByName(`mine:${runId}`);
    await mine.initialize({ runId, seed: 42 });
    await mine.command({ type: 'spawn', count: 1, operationId: crypto.randomUUID() });
    await runInDurableObject(mine, (_instance, state) => state.storage.transactionSync(() => {
      const sql = state.storage.sql;
      sql.exec("UPDATE cg_tiles SET terrain='rock',available=0,reserved=0,visible=1").toArray();
      sql.exec("UPDATE cg_tiles SET terrain='floor' WHERE x=4 AND y=4").toArray();
      sql.exec("UPDATE cg_tiles SET terrain='coal',available=9 WHERE x=5 AND y=4").toArray();
      sql.exec("UPDATE cg_tiles SET terrain='diamond',available=3 WHERE x=4 AND y=5").toArray();
      sql.exec("UPDATE cg_run SET data=json_remove(json_set(data,'$.initialCoal',13,'$.minedCoal',4,'$.availableCoal',9,'$.reservedCoal',0),'$.initialDiamonds','$.availableDiamonds','$.reservedDiamonds','$.minedDiamonds','$.hopper')").toArray();
      sql.exec("UPDATE cg_miners SET data=json_remove(json_set(data,'$.coal',4,'$.diamonds',2,'$.x',4,'$.y',4),'$.inventory')").toArray();
      sql.exec('DELETE FROM cg_schema_migrations').toArray();
    }));
    await evictDurableObject(mine);
    const migrated = await mine.getSnapshot();
    expect(migrated.run).toMatchObject({ initialCoal: 13, minedCoal: 4, availableCoal: 9, reservedCoal: 0, initialDiamonds: 5, minedDiamonds: 2, availableDiamonds: 3, reservedDiamonds: 0 });
    expect(migrated.miners[0]).toMatchObject({ coal: 4, diamonds: 2 });
    expect(migrated.run.hopper).toEqual({ ...HOPPER, coal: 4, diamonds: 2 });
    expect(migrated.miners[0]!.inventory).toEqual({ coal: 0, diamonds: 0 });
    expect(migrated.tiles[tileKey(4, 5)]).toMatchObject({ terrain: 'diamond', available: 3, reserved: 0 });
    expect(await mine.getMetrics()).toMatchObject({ coal: 4, diamonds: 2, value: 24 });
    await evictDurableObject(mine);
    expect((await mine.getSnapshot()).run).toEqual(migrated.run);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { RecoveryMine, RecoveryMiner } from '../src/testing/test-worker';

type Runtime = { phase: string; burstId?: string; operationId?: string; memory: { lastTools: { tool: string }[] } };
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

describe('durable Pi burst recovery', () => {
  for (const boundary of ['preparing', 'prepared', 'submitted']) {
    it(`resumes ${boundary} with one admitted decision and one committed discovery`, async () => {
      let now = Date.now() + 86_400_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const runId = crypto.randomUUID();
      const mine = env.RECOVERY_MINES.getByName(`mine:${runId}`);
      const miner = env.RECOVERY_MINERS.getByName(`miner:${runId}:1`);
      const runtime = () => runInDurableObject(miner, (_instance, state) => {
        const row = state.storage.sql.exec<{ data: string }>('SELECT data FROM cg_miner_runtime WHERE id=1').toArray()[0];
        return row ? JSON.parse(row.data) as Runtime : undefined;
      });
      const advance = async () => {
        const deadline = async (stub: DurableObjectStub<RecoveryMine> | DurableObjectStub<RecoveryMiner>) => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
        const [mineAt, minerAt] = await Promise.all([deadline(mine), deadline(miner)]);
        const due = Math.min(mineAt ?? Infinity, minerAt ?? Infinity);
        now = Number.isFinite(due) ? Math.max(now, due) : now + 1;
        if (mineAt !== null && mineAt <= now) await runDurableObjectAlarm(mine);
        if (minerAt !== null && minerAt <= now) await runDurableObjectAlarm(miner);
      };
      await mine.initialize({ runId, seed: 42 });
      await mine.command({ type: 'spawn', count: 1, operationId: crypto.randomUUID() });
      await mine.command({ type: 'resume', operationId: crypto.randomUUID() });
      let before: Runtime | undefined;
      for (let step = 0; step < 160; step++) { await advance(); before = await runtime(); if (before?.phase === boundary) break; }
      expect(before?.phase).toBe(boundary);
      const operationId = before!.operationId;
      expect(operationId).toBe(before!.burstId);
      await evictDurableObject(miner);
      await miner.inspect({ limit: 50 });
      let after: Runtime | undefined;
      for (let step = 0; step < 160; step++) { await advance(); after = await runtime(); if (after?.phase === 'settled' && after.memory.lastTools.some(tool => tool.tool === 'discover')) break; }
      expect(after?.operationId).toBe(operationId);
      expect(after?.phase).toBe('settled');
      const metrics = await mine.getMetrics();
      expect(metrics.modelCallsTotal).toBe(1);
      expect(metrics.agentsWithValidatedTools).toBe(1);
      expect(metrics.agentsWithRealInference).toBe(0);
      const snapshot = await mine.getSnapshot();
      expect(snapshot.miners[0].validatedTools).toBe(1);
      const trace = await miner.inspect({ limit: 50 });
      expect(trace.entries.filter(entry => entry.kind === 'input')).toHaveLength(1);
      expect(trace.entries.filter(entry => entry.kind === 'tool_result' && entry.tool === 'discover')).toHaveLength(1);
      await mine.command({ type: 'stop', operationId: crypto.randomUUID() });
    });
  }
  it('runs synthetic Pi extraction, physical return and deposit with public bank receipts', async () => {
    let now = Date.now() + 86_400_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const runId = crypto.randomUUID();
    const mine = env.RECOVERY_MINES.getByName(`mine:${runId}`);
    const miner = env.RECOVERY_MINERS.getByName(`miner:${runId}:1`);
    await mine.initialize({ runId, seed: 42 });
    await mine.command({ type: 'spawn', count: 1, operationId: crypto.randomUUID() });
    await mine.command({ type: 'resume', operationId: crypto.randomUUID() });
    let snapshot = await mine.getSnapshot();
    try {
      for (let step = 0; step < 1_200; step++) {
        const [mineAt, minerAt] = await Promise.all([
          runInDurableObject(mine, (_instance, state) => state.storage.getAlarm()),
          runInDurableObject(miner, (_instance, state) => state.storage.getAlarm()),
        ]);
        const due = Math.min(mineAt ?? Infinity, minerAt ?? Infinity);
        if (!Number.isFinite(due)) break;
        now = Math.max(now, due);
        if (mineAt !== null && mineAt <= now) await runDurableObjectAlarm(mine);
        if (minerAt !== null && minerAt <= now) await runDurableObjectAlarm(miner);
        snapshot = await mine.getSnapshot();
        expect(snapshot.miners[0]!.inventory.coal + snapshot.miners[0]!.inventory.diamonds).toBeLessThanOrEqual(3);
        if (snapshot.run.hopper.coal + snapshot.run.hopper.diamonds > 0) {
          const trace = await miner.inspect({ limit: 50 });
          if (!trace.busy && trace.entries.some(entry => entry.kind === 'tool_result' && entry.tool === 'deposit')) break;
        }
      }
      const self = snapshot.miners[0]!;
      expect(snapshot.run.hopper.coal + snapshot.run.hopper.diamonds).toBeGreaterThan(0);
      expect(self.inventory).toEqual({ coal: 0, diamonds: 0 });
      expect(self.coal + self.diamonds).toBe(snapshot.run.hopper.coal + snapshot.run.hopper.diamonds);
      expect(Math.abs(self.x - snapshot.run.hopper.x) + Math.abs(self.y - snapshot.run.hopper.y)).toBeLessThanOrEqual(1);
      const trace = await miner.inspect({ limit: 50 });
      const deposit = trace.entries.find(entry => entry.kind === 'tool_result' && entry.tool === 'deposit');
      expect(deposit?.args).toEqual({});
      expect(JSON.parse(deposit!.result!)).toMatchObject({
        ok: true, inventory: { coal: 0, diamonds: 0 }, hopper: snapshot.run.hopper,
        deposited: { coal: self.coal, diamonds: self.diamonds },
      });
    } finally {
      await mine.command({ type: 'stop', operationId: crypto.randomUUID() });
    }
  });
  for (const mode of ['paused', 'stopped'] as const) {
    it(`lets ${mode} miners become dormant after control delivery`, async () => {
      let now = Date.now() + 86_400_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const runId = crypto.randomUUID();
      const mine = env.RECOVERY_MINES.getByName(`mine:${runId}`);
      const miner = env.RECOVERY_MINERS.getByName(`miner:${runId}:1`);
      const deadline = (stub: DurableObjectStub<RecoveryMine> | DurableObjectStub<RecoveryMiner>) => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
      await mine.initialize({ runId, seed: 42 });
      await mine.command({ type: 'spawn', count: 1, operationId: crypto.randomUUID() });
      if (mode === 'stopped') await mine.command({ type: 'stop', operationId: crypto.randomUUID() });
      for (let step = 0; step < 80; step++) {
        const [mineAt, minerAt] = await Promise.all([deadline(mine), deadline(miner)]);
        if (mineAt === null && minerAt === null) break;
        now = Math.max(now, Math.min(mineAt ?? Infinity, minerAt ?? Infinity));
        if (mineAt !== null && mineAt <= now) await runDurableObjectAlarm(mine);
        if (minerAt !== null && minerAt <= now) await runDurableObjectAlarm(miner);
      }
      expect((await mine.getSnapshot()).run.mode).toBe(mode);
      expect((await mine.getMetrics()).modelCallsTotal).toBe(0);
      expect(await deadline(mine)).toBeNull();
      expect(await deadline(miner)).toBeNull();
    });
  }
});

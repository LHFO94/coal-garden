import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { RESERVATION_MICRO_USD, type InferenceClaim, type InferenceGrant, type InferenceSettlement, type PublicMiner, type RunRecord } from '../src/shared/protocol';
import type { Mine } from '../src/worker/mine';

type MineStub = DurableObjectStub<Mine>;
type CallState = 'granted' | 'claimed' | 'unknown' | 'settled' | 'unused';
interface CallRow extends Record<string, SqlStorageValue> {
  grant_id: string;
  invocation_id: string | null;
  miner_id: string;
  generation: number;
  burst_id: string;
  created_at: number;
  claimed_at: number | null;
  expires_at: number;
  state: CallState;
  reservation: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  charged: number;
  settlement: string | null;
}
interface QueueRow extends Record<string, SqlStorageValue> { miner_id: string; generation: number; burst_id: string; ordinal: number; eligible_at: number }
interface SavedGrant { agentId: string; grant: InferenceGrant }
interface SavedAdmissionState { run: RunRecord; calls: CallRow[]; queue: QueueRow[]; grants: SavedGrant[] }
const RESERVE = RESERVATION_MICRO_USD;
const RPM = 240;
const PACE = Math.ceil(60_000 / RPM);

// Application time is ahead of wall time so only explicitly invoked alarms advance these runs.
function clock() {
  let now = Date.now() + 86_400_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return { now: () => now, advance: (milliseconds: number) => { now += milliseconds; } };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

async function fixture(count = 4, options: { allowance?: number; coal?: boolean; maxInFlight?: number } = {}) {
  const runId = crypto.randomUUID();
  const mine = env.MINES.getByName(`mine:${runId}`);
  await mine.initialize({ runId, seed: 42 });
  if (options.maxInFlight !== undefined) await mine.command({ type: 'set_quota', verifiedModelRPM: 300, maxInFlight: options.maxInFlight, operationId: crypto.randomUUID() });
  await mine.command({ type: 'spawn', count, operationId: crypto.randomUUID() });
  await mine.command({ type: 'resume', operationId: crypto.randomUUID() });
  const generation = await runInDurableObject(mine, (_instance, state) => state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    const run = JSON.parse(sql.exec<{ data: string }>('SELECT data FROM cg_run WHERE id=1').toArray()[0]!.data) as RunRecord;
    if (options.allowance !== undefined) run.allowanceMicroUSD = options.allowance;
    if (options.coal) {
      sql.exec("UPDATE cg_tiles SET terrain='rock',visible=1,available=0,reserved=0").toArray();
      sql.exec("UPDATE cg_tiles SET terrain='floor' WHERE x=4 AND y=4").toArray();
      sql.exec("UPDATE cg_tiles SET terrain='coal',available=7 WHERE x=5 AND y=4").toArray();
      Object.assign(run, { initialCoal: 7, availableCoal: 7, reservedCoal: 0, minedCoal: 0, initialDiamonds: 0, availableDiamonds: 0, reservedDiamonds: 0, minedDiamonds: 0 });
    }
    sql.exec('UPDATE cg_run SET data=? WHERE id=1', JSON.stringify(run)).toArray();
    for (const row of sql.exec<{ agent_id: string; data: string }>('SELECT agent_id,data FROM cg_miners').toArray()) {
      const miner = JSON.parse(row.data) as PublicMiner;
      Object.assign(miner, { provisioned: true, state: 'idle', generation: run.generation, lastContact: Date.now() });
      if (options.coal) Object.assign(miner, { x: 4, y: 4 });
      sql.exec('UPDATE cg_miners SET data=? WHERE agent_id=?', JSON.stringify(miner), row.agent_id).toArray();
    }
    sql.exec('UPDATE cg_deliveries SET next_attempt_at=?', Date.now() + 86_400_000).toArray();
    return run.generation;
  }));
  const request = (agentId: string, eligibleAt?: number) => ({ agentId, generation, burstId: `burst:${runId}:${agentId}:1`, ...(eligibleAt === undefined ? {} : { eligibleAt }) });
  return { mine, runId, generation, request };
}

async function saved(mine: MineStub): Promise<SavedAdmissionState> {
  return runInDurableObject(mine, (_instance, state) => {
    const sql = state.storage.sql;
    const run = JSON.parse(sql.exec<{ data: string }>('SELECT data FROM cg_run WHERE id=1').toArray()[0]!.data) as RunRecord;
    const calls = sql.exec<CallRow>('SELECT * FROM cg_model_calls ORDER BY created_at,grant_id').toArray();
    const queue = sql.exec<QueueRow>('SELECT miner_id,generation,burst_id,ordinal,eligible_at FROM cg_model_queue ORDER BY ordinal').toArray();
    const grants = sql.exec<{ miner_id: string; grantJSON: string }>('SELECT miner_id,grant AS grantJSON FROM cg_deliveries WHERE grant IS NOT NULL').toArray()
      .map(row => ({ agentId: row.miner_id, grant: JSON.parse(row.grantJSON) as InferenceGrant }))
      .filter(({ grant }) => calls.some(call => call.grant_id === grant.grantId && call.state === 'granted'));
    return { run, calls, queue, grants };
  });
}

async function alarm(mine: MineStub) {
  await runInDurableObject(mine, async (instance: Mine, state) => {
    // Admission is under test, not notice delivery or a Miner/Pi/provider execution.
    state.storage.sql.exec('UPDATE cg_deliveries SET next_attempt_at=?', Date.now() + 86_400_000).toArray();
    await instance.alarm();
  });
}

async function grantFor(mine: MineStub, agentId: string): Promise<InferenceGrant> {
  const state = await saved(mine);
  expect(state.grants.map(value => value.agentId)).toEqual([agentId]);
  expect(state.calls.filter(call => call.state === 'granted')).toHaveLength(1);
  const grant = state.grants[0]?.grant;
  if (!grant) throw new Error(`Expected a durable grant for miner ${agentId}`);
  return grant;
}

function claimInput(runId: string, agentId: string, grant: InferenceGrant): InferenceClaim {
  return { runId, agentId, generation: grant.generation, burstId: grant.burstId, grantId: grant.grantId, invocationId: crypto.randomUUID() };
}

async function claim(mine: MineStub, input: InferenceClaim) {
  const result = await mine.claimInference(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected an admitted inference claim');
  expect(result.claimedAt).toBe(Date.now());
  expect(result.expiresAt).toBe(Date.now() + 120_000);
  return result;
}

function occupied(calls: CallRow[], now: number) {
  return calls.filter(call => call.state === 'granted' || call.state === 'claimed' || (call.state === 'unknown' && call.expires_at > now));
}

function assertAccounting(state: SavedAdmissionState) {
  const reserved = state.calls.filter(call => call.state === 'granted' || call.state === 'claimed').reduce((sum, call) => sum + call.reservation, 0);
  const unknown = state.calls.filter(call => call.state === 'unknown').reduce((sum, call) => sum + call.reservation, 0);
  expect(state.run.reservedMicroUSD).toBe(reserved);
  expect(state.run.unknownMicroUSD).toBe(unknown);
  expect(state.run.observedMicroUSD).toBe(state.calls.reduce((sum, call) => sum + call.charged, 0));
  expect(reserved + unknown + state.run.observedMicroUSD).toBeLessThanOrEqual(state.run.allowanceMicroUSD);
  expect(state.calls.filter(call => call.state === 'granted').length).toBeLessThanOrEqual(1);
  expect(occupied(state.calls, Date.now()).length).toBeLessThanOrEqual(state.run.maxInFlight);
  expect(state.grants).toHaveLength(state.calls.filter(call => call.state === 'granted').length);
}

async function settle(mine: MineStub, input: InferenceClaim, tokens = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }) {
  const settlement: InferenceSettlement = { invocationId: input.invocationId, agentId: input.agentId, ...tokens, completedAt: Date.now() };
  await mine.settleInference(settlement);
  return settlement;
}

describe('Mine inference admission authority', () => {
  it('gives 100 miners FIFO turns, counts only claims, paces every start, and bounds 32 overlapping decisions', async () => {
    const time = clock();
    const { mine, runId, request } = await fixture(100);
    for (let ordinal = 1; ordinal <= 100; ordinal++) {
      expect(await mine.enqueueDecision(request(String(ordinal)))).toMatchObject({ status: 'queued', mode: 'running' });
    }
    let state = await saved(mine);
    expect(state.queue.map(row => row.miner_id)).toEqual(Array.from({ length: 99 }, (_, index) => String(index + 2)));
    expect(state.calls.filter(call => call.claimed_at !== null)).toEqual([]);
    expect(state.run.reservedMicroUSD).toBe(RESERVE);
    expect((await grantFor(mine, '1')).expiresAt).toBe(time.now() + 10_000);
    const pending: InferenceClaim[] = [];
    const starts: number[] = [];
    for (let ordinal = 1; ordinal <= 100; ordinal++) {
      if (ordinal > 1) {
        time.advance(PACE - 1);
        await alarm(mine);
        expect((await saved(mine)).grants).toEqual([]);
        time.advance(1);
        await alarm(mine);
        if (pending.length === 32) {
          state = await saved(mine);
          expect(state.grants).toEqual([]);
          expect(occupied(state.calls, time.now())).toHaveLength(32);
          await settle(mine, pending.shift()!);
          await alarm(mine);
        }
      }
      const grant = await grantFor(mine, String(ordinal));
      const input = claimInput(runId, String(ordinal), grant);
      await claim(mine, input);
      pending.push(input);
      starts.push(time.now());
      state = await saved(mine);
      expect(state.calls.filter(call => call.claimed_at !== null)).toHaveLength(ordinal);
      expect(state.grants).toEqual([]);
      assertAccounting(state);
      expect(starts.filter(start => start > time.now() - 60_000)).toHaveLength(Math.min(ordinal, RPM));
    }
    for (const input of pending) await settle(mine, input);
    state = await saved(mine);
    const ledger = state.calls.filter(call => call.claimed_at !== null).sort((left, right) => left.claimed_at! - right.claimed_at!);
    expect(ledger.map(call => call.miner_id)).toEqual(Array.from({ length: 100 }, (_, index) => String(index + 1)));
    for (let index = 1; index < ledger.length; index++) expect(ledger[index]!.claimed_at! - ledger[index - 1]!.claimed_at!).toBeGreaterThanOrEqual(PACE);
    expect(state.queue).toEqual([]);
    expect(occupied(state.calls, time.now())).toEqual([]);
    expect(state.run).toMatchObject({ observedMicroUSD: 400, reservedMicroUSD: 0, unknownMicroUSD: 0, mode: 'running' });
    assertAccounting(state);
  });

  it.each([32, RPM])('updates default limits from %i RPM without resetting the ledger or overriding explicit limits', async previousRPM => {
    clock();
    const { mine, runId, request } = await fixture(2);
    await mine.enqueueDecision(request('1'));
    const input = claimInput(runId, '1', await grantFor(mine, '1'));
    await claim(mine, input);
    const before = await saved(mine);
    await runInDurableObject(mine, (_instance, state) => {
      const sql = state.storage.sql;
      const run = JSON.parse(sql.exec<{ data: string }>('SELECT data FROM cg_run WHERE id=1').toArray()[0]!.data) as RunRecord;
      run.effectiveRPM = previousRPM;
      run.maxInFlight = 4;
      sql.exec('UPDATE cg_run SET data=? WHERE id=1', JSON.stringify(run)).toArray();
    });
    expect((await mine.getMetrics()).effectiveRPM).toBe(RPM);
    const after = await saved(mine);
    expect(after.calls).toEqual(before.calls);
    expect(after.run).toMatchObject({ nextStartAt: before.run.nextStartAt, reservedMicroUSD: before.run.reservedMicroUSD, observedMicroUSD: before.run.observedMicroUSD, unknownMicroUSD: before.run.unknownMicroUSD, allowanceMicroUSD: 5_000_000, maxInFlight: 32 });
    await mine.command({ type: 'set_quota', verifiedModelRPM: 25, maxInFlight: 2, operationId: crypto.randomUUID() });
    expect((await mine.getMetrics())).toMatchObject({ verifiedModelRPM: 25, effectiveRPM: 20, maxInFlight: 2 });
    expect((await mine.getSnapshot()).run).toMatchObject({ verifiedModelRPM: 25, effectiveRPM: 20 });
  });

  it('enforces the rolling-minute ledger even when the saved paced-start deadline is already due', async () => {
    const time = clock();
    const { mine, runId, generation, request } = await fixture(1);
    await runInDurableObject(mine, (_instance, state) => state.storage.transactionSync(() => {
      const sql = state.storage.sql;
      for (let index = 0; index < RPM; index++) {
        const at = time.now() - 59_999 + index * PACE;
        sql.exec("INSERT INTO cg_model_calls(grant_id,invocation_id,miner_id,generation,burst_id,created_at,claimed_at,expires_at,state,reservation,input_tokens,output_tokens,cache_read_tokens,charged,settlement) VALUES(?,?,?,?,?,?,?,?, 'settled',?,0,0,0,0,?)",
          crypto.randomUUID(), crypto.randomUUID(), '1', generation, `historical:${runId}:${index}`, at, at, at + 120_000, RESERVE, JSON.stringify({ agentId: '1', inputTokens: 0, outputTokens: 0, completedAt: at })).toArray();
      }
      sql.exec("UPDATE cg_run SET data=json_set(data,'$.nextStartAt',0) WHERE id=1").toArray();
    }));
    await mine.enqueueDecision(request('1'));
    await alarm(mine);
    let state = await saved(mine);
    expect(state.grants).toEqual([]);
    expect(state.queue.map(row => row.miner_id)).toEqual(['1']);
    expect(state.calls.filter(call => call.claimed_at !== null && call.claimed_at > time.now() - 60_000)).toHaveLength(RPM);
    time.advance(2);
    await alarm(mine);
    await claim(mine, claimInput(runId, '1', await grantFor(mine, '1')));
    state = await saved(mine);
    expect(state.calls.filter(call => call.claimed_at !== null && call.claimed_at > time.now() - 60_000)).toHaveLength(RPM);
    assertAccounting(state);
  });

  it('keeps one queue row per miner without advancing delayed eligibility or changing FIFO position on replay', async () => {
    const time = clock();
    const { mine, runId, request } = await fixture(3);
    const delayed = request('1', time.now() + PACE * 2);
    await mine.enqueueDecision(delayed);
    await mine.enqueueDecision(request('2'));
    await mine.enqueueDecision(request('3'));
    const first = await saved(mine);
    const ordinal = first.queue.find(row => row.miner_id === '1')!.ordinal;
    await mine.enqueueDecision(delayed);
    const repeated = await saved(mine);
    expect(repeated.queue.filter(row => row.miner_id === '1')).toHaveLength(1);
    expect(repeated.queue.find(row => row.miner_id === '1')).toMatchObject({ ordinal, eligible_at: delayed.eligibleAt });
    await claim(mine, claimInput(runId, '2', await grantFor(mine, '2')));
    time.advance(PACE);
    await alarm(mine);
    await claim(mine, claimInput(runId, '3', await grantFor(mine, '3')));
    time.advance(PACE);
    await alarm(mine);
    expect((await grantFor(mine, '1')).burstId).toBe(delayed.burstId);
    assertAccounting(await saved(mine));
  });

  it('expires an unclaimed ten-second grant without charging it and requeues that miner behind its peers', async () => {
    const time = clock();
    const { mine, runId, request } = await fixture(3);
    for (const agentId of ['1', '2', '3']) await mine.enqueueDecision(request(agentId));
    const expired = await grantFor(mine, '1');
    time.advance(9_999);
    await alarm(mine);
    expect(await grantFor(mine, '1')).toEqual(expired);
    time.advance(1);
    await alarm(mine);
    let state = await saved(mine);
    expect(state.calls.find(call => call.grant_id === expired.grantId)).toMatchObject({ state: 'unused', claimed_at: null, charged: 0 });
    expect(state.queue.map(row => row.miner_id)).toEqual(['3', '1']);
    expect(state.run).toMatchObject({ reservedMicroUSD: RESERVE, observedMicroUSD: 0, unknownMicroUSD: 0 });
    expect(await mine.claimInference(claimInput(runId, '1', expired))).toMatchObject({ ok: false, code: 'ADMISSION_REQUIRED' });
    const second = claimInput(runId, '2', await grantFor(mine, '2'));
    await claim(mine, second);
    time.advance(PACE);
    await alarm(mine);
    await claim(mine, claimInput(runId, '3', await grantFor(mine, '3')));
    time.advance(PACE);
    await alarm(mine);
    const replacement = await grantFor(mine, '1');
    expect(replacement.grantId).not.toBe(expired.grantId);
    expect(replacement.burstId).toBe(expired.burstId);
    state = await saved(mine);
    expect(state.calls.filter(call => call.claimed_at !== null)).toHaveLength(2);
    assertAccounting(state);
  });

  it('binds claims to every identity field and replays only the same committed invocation, including after pause', async () => {
    const time = clock();
    const { mine, runId, generation, request } = await fixture(2);
    await mine.enqueueDecision(request('1'));
    await mine.enqueueDecision(request('2'));
    const input = claimInput(runId, '1', await grantFor(mine, '1'));
    const wrong: Partial<InferenceClaim>[] = [
      { runId: crypto.randomUUID() }, { agentId: '2' }, { generation: generation - 1 },
      { burstId: 'another-burst' }, { grantId: crypto.randomUUID() },
    ];
    for (const fields of wrong) expect(await mine.claimInference({ ...input, ...fields })).toMatchObject({ ok: false, code: 'ADMISSION_REQUIRED' });
    expect((await saved(mine)).calls.filter(call => call.claimed_at !== null)).toEqual([]);
    const receipt = await claim(mine, input);
    expect(await mine.claimInference(input)).toEqual(receipt);
    expect(await mine.claimInference({ ...input, invocationId: crypto.randomUUID() })).toMatchObject({ ok: false, code: 'ADMISSION_REQUIRED' });
    for (const fields of wrong) expect(await mine.claimInference({ ...input, ...fields })).toMatchObject({ ok: false, code: 'ADMISSION_REQUIRED' });
    time.advance(PACE);
    await alarm(mine);
    const unused = claimInput(runId, '2', await grantFor(mine, '2'));
    await mine.command({ type: 'pause', operationId: crypto.randomUUID() });
    expect(await mine.claimInference(unused)).toMatchObject({ ok: false, code: 'ADMISSION_REQUIRED', mode: 'paused', generation: generation + 1 });
    expect(await mine.claimInference(input)).toEqual(receipt);
    const state = await saved(mine);
    expect(state.calls.filter(call => call.claimed_at !== null)).toHaveLength(1);
    expect(state.calls.find(call => call.grant_id === unused.grantId)?.state).toBe('unused');
    expect(state.queue).toEqual([]);
    expect(state.run).toMatchObject({ reservedMicroUSD: RESERVE, unknownMicroUSD: 0, observedMicroUSD: 0 });
    assertAccounting(state);
  });

  it('returns authoritative generation and mode when paused, retired, exhausted, or stopped rather than leaving eligibility work queued', async () => {
    clock();
    const { mine, generation, request } = await fixture(3);
    await mine.command({ type: 'pause', operationId: crypto.randomUUID() });
    expect(await mine.enqueueDecision(request('1'))).toEqual({ status: 'paused', mode: 'paused', generation: generation + 1 });
    await mine.command({ type: 'resume', operationId: crypto.randomUUID() });
    await mine.command({ type: 'retire', agentId: '1', operationId: crypto.randomUUID() });
    expect(await mine.enqueueDecision({ ...request('1'), generation: generation + 2 })).toEqual({ status: 'retired', mode: 'running', generation: generation + 2 });
    await runInDurableObject(mine, (_instance, state) => {
      state.storage.sql.exec("UPDATE cg_run SET data=json_set(data,'$.exhausted',json('true')) WHERE id=1").toArray();
    });
    expect(await mine.enqueueDecision({ ...request('2'), generation: generation + 2 })).toEqual({ status: 'exhausted', mode: 'running', generation: generation + 2 });
    await mine.command({ type: 'stop', operationId: crypto.randomUUID() });
    expect(await mine.enqueueDecision(request('3'))).toMatchObject({ mode: 'stopped', generation: generation + 3 });
    const state = await saved(mine);
    expect(state.queue).toEqual([]);
    expect(state.calls).toEqual([]);
    assertAccounting(state);
  });

  it('pauses before a third unaffordable reservation, freezes physical actions, and settles each known charge only once', async () => {
    const time = clock();
    const { mine, runId, generation, request } = await fixture(4, { allowance: RESERVE * 2, coal: true });
    await mine.enqueueDecision(request('1'));
    await mine.enqueueDecision(request('2'));
    const first = claimInput(runId, '1', await grantFor(mine, '1'));
    await claim(mine, first);
    time.advance(PACE);
    await alarm(mine);
    const second = claimInput(runId, '2', await grantFor(mine, '2'));
    await claim(mine, second);
    const effect = await mine.applyTool({ runId, agentId: '4', generation, operationId: `${runId}/4/${generation}/extract/mine`, observedRevision: 0, tool: 'mine', args: { x: 5, y: 4 } });
    expect(effect).toMatchObject({ ok: true, acceptedAmount: 3 });
    if (!effect.ok || !effect.action) throw new Error('Expected accepted extraction before budget pause');
    const action = effect.action;
    await mine.enqueueDecision(request('3'));
    time.advance(750);
    await alarm(mine);
    let state = await saved(mine);
    expect(state.run).toMatchObject({ mode: 'budget_paused', generation: generation + 1, pausedAt: time.now(), reservedMicroUSD: RESERVE * 2, observedMicroUSD: 0 });
    expect(state.calls.filter(call => call.claimed_at !== null)).toHaveLength(2);
    expect(state.grants).toEqual([]);
    expect(state.queue).toEqual([]);
    expect(await mine.enqueueDecision(request('3'))).toMatchObject({ status: 'paused', mode: 'budget_paused', generation: generation + 1 });
    time.advance(10_000);
    await alarm(mine);
    const snapshot = await mine.getSnapshot();
    expect(snapshot.actions.find(value => value.actionId === action.actionId)).toMatchObject({ status: 'accepted', startedAt: action.startedAt, endsAt: action.endsAt });
    expect(snapshot.run).toMatchObject({ minedCoal: 0, availableCoal: 4, reservedCoal: 3 });
    expect(await mine.applyTool({ runId, agentId: '3', generation, operationId: `${runId}/3/${generation}/late/discover`, observedRevision: 0, tool: 'discover', args: {} })).toMatchObject({ ok: false, code: 'STALE_GENERATION' });
    const terminal = await settle(mine, first, { inputTokens: 17, outputTokens: 9, cacheReadTokens: 3 });
    state = await saved(mine);
    // Prices in micro-USD/token: input .45, output 3.20, cache read .05; ceil once per call.
    const firstCharge = Math.ceil(17 * 0.45 + 9 * 3.2 + 3 * 0.05);
    expect(firstCharge).toBe(37);
    expect(state.run).toMatchObject({ observedMicroUSD: firstCharge, reservedMicroUSD: RESERVE, unknownMicroUSD: 0, mode: 'budget_paused' });
    expect(state.calls.find(call => call.invocation_id === first.invocationId)).toMatchObject({ state: 'settled', input_tokens: 17, output_tokens: 9, cache_read_tokens: 3, charged: firstCharge });
    await mine.settleInference(terminal);
    await mine.settleInference({ ...terminal, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    state = await saved(mine);
    expect(state.run).toMatchObject({ observedMicroUSD: firstCharge, reservedMicroUSD: RESERVE });
    expect(state.calls.find(call => call.invocation_id === second.invocationId)).toMatchObject({ state: 'claimed', charged: 0, reservation: RESERVE });
    await settle(mine, second);
    state = await saved(mine);
    expect(state.run).toMatchObject({ observedMicroUSD: firstCharge + 4, reservedMicroUSD: 0, unknownMicroUSD: 0, mode: 'budget_paused' });
    assertAccounting(state);
  });

  it('retains crashed and tokenless-error liabilities, releases their slots only after 120 seconds, and accepts late known usage once', async () => {
    const time = clock();
    const { mine, runId, request } = await fixture(6, { maxInFlight: 4 });
    for (const agentId of ['1', '2', '3', '4', '5', '6']) await mine.enqueueDecision(request(agentId));
    const inputs: InferenceClaim[] = [];
    const firstStart = time.now();
    for (let ordinal = 1; ordinal <= 4; ordinal++) {
      if (ordinal > 1) { time.advance(PACE); await alarm(mine); }
      const input = claimInput(runId, String(ordinal), await grantFor(mine, String(ordinal)));
      await claim(mine, input);
      inputs.push(input);
    }
    time.advance(120_000 - (time.now() - firstStart) - 1);
    await alarm(mine);
    let state = await saved(mine);
    expect(state.grants).toEqual([]);
    expect(occupied(state.calls, time.now())).toHaveLength(4);
    expect(state.run).toMatchObject({ reservedMicroUSD: RESERVE * 4, unknownMicroUSD: 0 });
    time.advance(1);
    await alarm(mine);
    state = await saved(mine);
    expect(state.calls.find(call => call.invocation_id === inputs[0]!.invocationId)).toMatchObject({ state: 'unknown', charged: 0 });
    expect(state.run).toMatchObject({ reservedMicroUSD: RESERVE * 4, unknownMicroUSD: RESERVE, observedMicroUSD: 0 });
    const fifth = claimInput(runId, '5', await grantFor(mine, '5'));
    await claim(mine, fifth);
    const noUsage: InferenceSettlement = { invocationId: inputs[1]!.invocationId, agentId: '2', error: 'Transport ended without usage; charge unknown', completedAt: time.now() };
    await mine.settleInference(noUsage);
    state = await saved(mine);
    expect(state.calls.find(call => call.invocation_id === inputs[1]!.invocationId)).toMatchObject({ state: 'unknown', input_tokens: null, output_tokens: null, charged: 0 });
    expect(state.run).toMatchObject({ reservedMicroUSD: RESERVE * 3, unknownMicroUSD: RESERVE * 2, observedMicroUSD: 0 });
    const late = await settle(mine, inputs[0]!, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 });
    await mine.settleInference(late);
    await mine.settleInference({ ...late, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    state = await saved(mine);
    expect(state.run).toMatchObject({ reservedMicroUSD: RESERVE * 3, unknownMicroUSD: RESERVE, observedMicroUSD: 70 });
    await mine.settleInference(noUsage);
    await alarm(mine);
    expect((await saved(mine)).grants).toEqual([]);
    time.advance(PACE - 1);
    await alarm(mine);
    expect((await saved(mine)).grants).toEqual([]);
    time.advance(1);
    await alarm(mine);
    await grantFor(mine, '6');
    state = await saved(mine);
    expect(state.run).toMatchObject({ reservedMicroUSD: RESERVE * 4, unknownMicroUSD: RESERVE, observedMicroUSD: 70 });
    const secondLate = await settle(mine, inputs[1]!, { inputTokens: 0, outputTokens: 1, cacheReadTokens: 0 });
    await mine.settleInference(secondLate);
    await mine.settleInference(noUsage);
    state = await saved(mine);
    expect(state.run).toMatchObject({ reservedMicroUSD: RESERVE * 4, unknownMicroUSD: 0, observedMicroUSD: 74 });
    expect(state.calls.find(call => call.invocation_id === inputs[0]!.invocationId)).toMatchObject({ state: 'settled', charged: 70, output_tokens: 20 });
    expect(state.calls.find(call => call.invocation_id === inputs[1]!.invocationId)).toMatchObject({ state: 'settled', charged: 4, output_tokens: 1 });
    assertAccounting(state);
  });

  it.each([429, 401, 403, 404])('fences admission after provider status %i without refunding an unknown charge', async status => {
    const time = clock();
    const { mine, runId, generation, request } = await fixture(2);
    await mine.enqueueDecision(request('1'));
    await mine.enqueueDecision(request('2'));
    const input = claimInput(runId, '1', await grantFor(mine, '1'));
    await claim(mine, input);
    await mine.settleInference({ invocationId: input.invocationId, agentId: '1', status, error: `Provider HTTP ${status}`, completedAt: time.now() });
    const state = await saved(mine);
    expect(state.run).toMatchObject({ mode: 'quota_paused', generation: generation + 1, reservedMicroUSD: 0, unknownMicroUSD: RESERVE, observedMicroUSD: 0 });
    expect(state.queue).toEqual([]);
    expect(state.grants).toEqual([]);
    expect(await mine.enqueueDecision(request('2'))).toMatchObject({ status: 'paused', mode: 'quota_paused', generation: generation + 1 });
    expect(await mine.claimInference({ ...input, invocationId: crypto.randomUUID() })).toMatchObject({ ok: false, code: 'ADMISSION_REQUIRED', mode: 'quota_paused' });
    assertAccounting(state);
  });
});

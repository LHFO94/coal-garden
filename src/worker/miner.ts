import { DurableObject } from 'cloudflare:workers';
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from 'agents/lifecycle';
import { PiHarness, type PiOperationResult } from 'agents/harness/pi';
import { createModels, type Provider } from '@earendil-works/pi-ai';
import { createRegistry, Harness, type EntryId, type EntryRecord } from '@earendil-works/pi-durable';
import type { Env } from './env';
import { buildPrompt, mineExtension, type ToolHost } from './miner-tools';
import { createLiveProvider, guardProvider, selectedModel, type AdmissionHost } from './inference-provider';
import {
  PublicError, WORLD_HEIGHT, WORLD_WIDTH,
  type InferenceClaim, type InferenceSettlement, type InferenceGrant, type MineRPC,
  type MinerMemory, type MinerNotice, type MinerReport, type PublicTraceEntry,
  type PublicTranscriptPage, type RunMode, type ToolArguments,
  type ToolName, type ToolResult,
} from '../shared/protocol';

const DRIVER_ID = 'cg.driver';
const RECONCILE_MS = 5_000;
const DECISION_MS = 10_000;
const ERROR_MS = 30_000;
type Phase = 'eligible' | 'queued' | 'preparing' | 'prepared' | 'submitted' | 'settled';
interface Terminal extends InferenceSettlement { burstId: string }
interface RuntimeState {
  runId?: string;
  agentId?: string;
  generation: number;
  mode: RunMode;
  latestRevision: number;
  lastControlRevision: number;
  burstSequence: number;
  phase: Phase;
  burstId?: string;
  burstGeneration?: number;
  burstRevision?: number;
  operationId?: string;
  grant?: InferenceGrant;
  prompt?: string;
  consumedMessageCursor?: number;
  memory: MinerMemory;
  nextEligibleAt: number;
  nextDriveAt: number;
  physicalAction?: { actionId: string; kind: 'walk_to' | 'mine'; endsAt: number };
  cancelIntent: boolean;
  blocked: boolean;
  retired: boolean;
  exhausted: boolean;
  admissionSuspended: boolean;
  admissionRequired: boolean;
  invocationId?: string;
  lastTerminal?: Terminal;
  lastDecision?: { status: string; reason?: string; text?: string; at: number };
  toolFailure: boolean;
  pendingToolTask?: string;
  pendingReport?: MinerReport;
  restartPending: boolean;
  transcriptCursor?: string;
}
interface ToolRecord extends Record<string, SqlStorageValue> { task_id: string; tool: ToolName; args: string; result: string; at: number; duration_ms: number }
interface TraceCursor { entryId: number; offset: number }
const initialState = (): RuntimeState => ({
  generation: 0, mode: 'paused', latestRevision: 0, lastControlRevision: -1,
  burstSequence: 0, phase: 'eligible', memory: { lastTools: [], messageCursor: 0 },
  nextEligibleAt: 0, nextDriveAt: 0, cancelIntent: false, blocked: false,
  retired: false, exhausted: false, admissionSuspended: false, admissionRequired: false,
  toolFailure: false, restartPending: false,
});
const isOverload = (error: unknown): boolean => typeof error === 'object' && error !== null && 'overloaded' in error && error.overloaded === true;
const text = (value: string, limit = 4_096): string => value.length <= limit ? value : `${value.slice(0, limit)}…`;
function toolName(value: string): value is ToolName { return value === 'walk_to' || value === 'mine' || value === 'discover' || value === 'deposit' || value === 'talk'; }
function coordinate(value: unknown): value is { x: number; y: number } {
  if (typeof value !== 'object' || value === null || !('x' in value) || !('y' in value)) return false;
  return Number.isInteger(value.x) && Number.isInteger(value.y) && typeof value.x === 'number' && typeof value.y === 'number'
    && value.x >= 0 && value.x < WORLD_WIDTH && value.y >= 0 && value.y < WORLD_HEIGHT;
}
/** Raw model arguments never cross the public trace boundary without domain-shaped validation. */
function publicArguments(tool: ToolName, input: unknown): ToolArguments | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  if (tool === 'discover' || tool === 'deposit') return Object.keys(input).length === 0 ? {} : undefined;
  if (tool === 'walk_to' || tool === 'mine') {
    if (!coordinate(input) || Object.keys(input).some(key => key !== 'x' && key !== 'y')) return undefined;
    return { x: input.x, y: input.y };
  }
  if (!('audience' in input) || (input.audience !== 'mine' && input.audience !== 'agent') || !('message' in input) || typeof input.message !== 'string'
    || input.message.trim().length === 0 || new TextEncoder().encode(input.message).length > 280) return undefined;
  if (input.audience === 'agent' && (!('agentId' in input) || typeof input.agentId !== 'string' || !/^[0-9]{1,4}$/.test(input.agentId))) return undefined;
  if ('at' in input && input.at !== undefined && !coordinate(input.at)) return undefined;
  return { audience: input.audience, message: input.message,
    ...('agentId' in input && typeof input.agentId === 'string' && /^[0-9]{1,4}$/.test(input.agentId) ? { agentId: input.agentId } : {}),
    ...('at' in input && coordinate(input.at) ? { at: { x: input.at.x, y: input.at.y } } : {}),
  };
}
/** Keep authoritative receipts, not potentially large discovery projections, in structured memory. */
function compactResult(result: ToolResult): ToolResult {
  if (!result.ok) return { ok: false, code: result.code, revision: result.revision,
    ...(result.claimant === undefined ? {} : { claimant: result.claimant }),
    ...(result.nearestFloor === undefined ? {} : { nearestFloor: result.nearestFloor }),
    ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
    ...(result.frontiers === undefined ? {} : { frontiers: result.frontiers.slice(0, 8) }),
  };
  return { ok: true, revision: result.revision,
    ...(result.action === undefined ? {} : { action: result.action }),
    ...(result.acceptedAmount === undefined ? {} : { acceptedAmount: result.acceptedAmount }),
    ...(result.endpoint === undefined ? {} : { endpoint: result.endpoint }),
    ...(result.sequence === undefined ? {} : { sequence: result.sequence }),
    ...(result.inventory === undefined ? {} : { inventory: result.inventory }),
    ...(result.hopper === undefined ? {} : { hopper: result.hopper }),
    ...(result.deposited === undefined ? {} : { deposited: result.deposited }),
  };
}

/** One durable Pi root session; only Mine can authorize inference or world effects. */
export class Miner extends DurableObject<Env> {
  private readonly harness: PiHarness;
  private readonly lifecycle: Lifecycle<Env>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS cg_miner_runtime (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)').toArray();
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS cg_miner_tools (task_id TEXT PRIMARY KEY, tool TEXT NOT NULL, args TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL, duration_ms REAL NOT NULL DEFAULT 0)').toArray();
    });
    this.harness = new PiHarness({
      defaults: { model: selectedModel(), thinkingLevel: 'off', maxTurns: 1 },
      harness: ({ storage, context, onWake }) => {
        const registry = createRegistry();
        registry.install(mineExtension(this.toolHost()));
        const models = createModels();
        // The override is intentionally called only here: synthetic objects need no AI binding.
        models.setProvider(guardProvider(this.createBaseProvider(), this.admissionHost()));
        return Harness.open(storage, { models, registry, onWake, settings: {
          retry: { maxRetries: 0 }, compaction: { enabled: false },
          toolExecution: 'sequential', afterFailedRun: 'withdraw',
        } }, context);
      },
    });
    this.lifecycle = Lifecycle.install(this).use(this.harness);
  }

  protected createBaseProvider(): Provider {
    return createLiveProvider(this.env.AI, () => {
      const state = this.state();
      if (!state.runId || !state.agentId || !state.burstId || !state.invocationId) throw new Error('NO_ADMITTED_GATEWAY_IDENTITY');
      return { runId: state.runId, agentId: state.agentId, burstId: state.burstId, invocationId: state.invocationId };
    });
  }

  private state(): RuntimeState {
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM cg_miner_runtime WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.data) as RuntimeState : initialState();
  }
  private update(change: (state: RuntimeState) => void): RuntimeState {
    return this.ctx.storage.transactionSync(() => {
      const state = this.state();
      change(state);
      this.ctx.storage.sql.exec('INSERT INTO cg_miner_runtime(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', JSON.stringify(state)).toArray();
      return state;
    });
  }
  private async mineCall<T>(call: (mine: MineRPC) => Promise<T>): Promise<T> {
    const state = this.state();
    if (!state.runId || !state.agentId) throw new PublicError('MINER_NOT_INITIALIZED', 'Miner has no authoritative identity.', 409);
    if (state.blocked) throw new PublicError('DO_OVERLOAD', 'This miner is locally blocked pending operator recovery.', 503);
    try {
      // Recreate a stub per durable attempt; a failed stub is never cached.
      return await call(this.env.MINES.getByName(`mine:${state.runId}`));
    } catch (error) {
      if (isOverload(error)) this.update(current => { current.blocked = true; });
      throw error;
    }
  }
  private driverTime(state: RuntimeState): number | undefined {
    if (!state.runId || state.blocked) return undefined;
    if (state.cancelIntent || state.phase === 'submitted') return Math.max(Date.now(), state.nextDriveAt);
    if (state.pendingReport || state.restartPending && state.phase !== 'queued') return Math.max(Date.now(), state.nextDriveAt);
    if (state.mode !== 'running' || state.retired || state.exhausted || state.admissionSuspended) return undefined;
    if (state.phase === 'queued') return state.grant ? Math.max(Date.now(), state.nextDriveAt) : undefined;
    return Math.max(Date.now(), state.nextDriveAt, state.nextEligibleAt, state.physicalAction?.endsAt ?? 0);
  }
  private async reconcileJob(): Promise<void> {
    const time = this.driverTime(this.state());
    if (time === undefined) await this.lifecycle.jobs.cancel(DRIVER_ID);
    else await this.lifecycle.jobs.push({ id: DRIVER_ID, fn: 'drive', time, singleflight: true });
  }

  async onStart(): Promise<void> {
    await this.lifecycle.start();
    this.update(state => { if (state.runId) state.restartPending = true; });
    await this.reconcileJob();
  }

  async synchronize(input: MinerNotice): Promise<{ revision: number }> {
    await this.lifecycle.start();
    const state = this.update(current => {
      if (current.runId && (current.runId !== input.runId || current.agentId !== input.agentId)) throw new PublicError('MINER_IDENTITY_CONFLICT', 'A miner identity cannot be replaced.', 409);
      current.runId = input.runId;
      current.agentId = input.agentId;
      const currentNotice = input.generation >= current.generation && input.revision >= current.latestRevision;
      const freshControl = input.generation >= current.generation && input.reasons.includes('control_changed') && input.revision > current.lastControlRevision;
      const previousGeneration = current.generation;
      const stopsWork = current.mode !== input.mode && input.mode !== 'running'
        || !current.retired && input.retired === true || !current.exhausted && input.exhausted === true;
      if (currentNotice) {
        current.generation = input.generation;
        current.mode = input.mode;
        current.retired ||= input.retired === true;
        current.exhausted = input.exhausted ?? current.exhausted;
      }
      current.latestRevision = Math.max(current.latestRevision, input.revision);
      if (freshControl) {
        current.lastControlRevision = input.revision;
        current.blocked = false;
        current.admissionSuspended = false;
      }
      if (currentNotice && (stopsWork || current.generation !== previousGeneration)) {
        current.cancelIntent = true;
        current.grant = undefined;
        current.nextDriveAt = Date.now();
      }
      if (input.grant && input.generation === current.generation && input.grant.generation === current.generation && current.mode === 'running'
        && !current.retired && !current.exhausted && input.grant.burstId === current.burstId && (current.phase === 'queued' || current.phase === 'eligible')) {
        current.phase = 'queued';
        current.grant = input.grant;
        current.nextDriveAt = Date.now();
      }
      if (currentNotice && input.reasons.includes('action_completed')) {
        current.physicalAction = undefined;
        current.nextDriveAt = Date.now();
      }
      if (freshControl && current.mode === 'running') current.nextDriveAt = Date.now();
      // world_changed only invalidates the revision; it never advances nextEligibleAt.
    });
    await this.reconcileJob();
    return { revision: state.latestRevision };
  }

  private toolHost(): ToolHost {
    return {
      identity: () => {
        const state = this.state();
        if (!state.runId || !state.agentId || state.burstGeneration === undefined || state.burstRevision === undefined || !state.operationId) throw new Error('NO_ACTIVE_BURST');
        return { runId: state.runId, agentId: state.agentId, generation: state.burstGeneration, observedRevision: state.burstRevision };
      },
      applyTool: async input => {
        let result: ToolResult;
        try { result = await this.mineCall(mine => mine.applyTool(input)); }
        catch (error) { this.update(state => { state.toolFailure = true; }); throw error; }
        const args = publicArguments(input.tool, input.args);
        if (!args) throw new Error('INVALID_COMMITTED_TOOL_ARGUMENTS');
        const taskId = input.operationId.split('/').at(-2);
        if (!taskId) throw new Error('INVALID_TOOL_EFFECT_ID');
        this.update(state => {
          this.ctx.storage.sql.exec('INSERT INTO cg_miner_tools(task_id,tool,args,result,at) VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET result=excluded.result', taskId, input.tool, JSON.stringify(args), JSON.stringify(compactResult(result)), Date.now()).toArray();
          state.pendingToolTask = taskId;
        });
        return result;
      },
      recordTool: (tool, args, result, durationMs) => this.recordTool(tool, args, result, durationMs),
    };
  }
  private async recordTool(tool: ToolName, args: ToolArguments, result: ToolResult, durationMs: number): Promise<void> {
    const compact = compactResult(result);
    const state = this.update(current => {
      const task = current.pendingToolTask;
      const saved = task ? this.ctx.storage.sql.exec<ToolRecord>('SELECT * FROM cg_miner_tools WHERE task_id=?', task).toArray()[0] : undefined;
      // A replay refreshes the same receipt instead of appending another memory item.
      if (!saved || saved.duration_ms === 0) {
        current.memory.lastTools.push({ tool, args, result: compact, at: saved?.at ?? Date.now() });
        current.memory.lastTools = current.memory.lastTools.slice(-8);
      }
      if (task) this.ctx.storage.sql.exec('UPDATE cg_miner_tools SET duration_ms=? WHERE task_id=?', Math.max(0.001, durationMs), task).toArray();
      if (result.ok && (tool === 'walk_to' || tool === 'mine') && args.x !== undefined && args.y !== undefined) current.memory.goal = { x: args.x, y: args.y };
      if (result.ok && result.action?.status === 'accepted') current.physicalAction = { actionId: result.action.actionId, kind: result.action.kind, endsAt: result.action.endsAt };
      current.latestRevision = Math.max(current.latestRevision, result.revision);
    });
    await this.mineCall(mine => mine.reportMiner({ agentId: state.agentId!, generation: state.burstGeneration!, memory: state.memory, observedRevision: result.revision, durationMs, tool }));
  }

  private admissionHost(): AdmissionHost {
    return {
      currentClaim: () => {
        const state = this.state();
        if (!state.runId || !state.agentId || !state.grant || !state.burstId || state.burstGeneration === undefined || state.cancelIntent || state.blocked || state.retired || state.mode !== 'running') return undefined;
        return { runId: state.runId, agentId: state.agentId, generation: state.burstGeneration, burstId: state.burstId, grantId: state.grant.grantId };
      },
      claim: async (input: InferenceClaim) => {
        const receipt = await this.mineCall(mine => mine.claimInference(input));
        this.update(state => {
          if (receipt.ok) state.invocationId = input.invocationId;
          else if (receipt.generation >= state.generation) {
            state.generation = receipt.generation;
            state.mode = receipt.mode;
            if (receipt.mode !== 'running') state.cancelIntent = true;
          }
        });
        return receipt;
      },
      settle: async input => {
        await this.mineCall(mine => mine.settleInference(input));
        this.update(state => {
          if (state.invocationId === input.invocationId && state.burstId) state.lastTerminal = { ...input, burstId: state.burstId };
        });
      },
      admissionRejected: async () => { this.update(state => { state.admissionRequired = true; }); },
    };
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    try {
      await this.lifecycle.start();
      if (job.id !== DRIVER_ID || job.fn !== 'drive') return;
      await this.drive();
    } catch (error) {
      this.update(state => {
        if (isOverload(error)) state.blocked = true;
        state.nextDriveAt = Date.now() + RECONCILE_MS;
        if (state.agentId && !state.pendingReport) state.pendingReport = { agentId: state.agentId, generation: state.generation, state: 'error', error: isOverload(error) ? 'DO_OVERLOAD' : error instanceof PublicError ? error.code : 'MINER_DRIVER_ERROR' };
      });
    }
    const next = this.driverTime(this.state());
    return next === undefined ? undefined : { rescheduleAt: next };
  }
  async onJobError(_context: LifecycleJobContext, error: unknown): Promise<LifecycleJobOutcome> {
    await this.lifecycle.start();
    this.update(state => { state.blocked ||= isOverload(error); state.nextDriveAt = Date.now() + RECONCILE_MS; });
    const next = this.driverTime(this.state());
    return next === undefined ? undefined : { rescheduleAt: next };
  }

  private async shortWait(operationId: string): Promise<PiOperationResult | undefined> {
    const signal = AbortSignal.timeout(25);
    try { return await this.harness.session().wait(operationId, signal); }
    catch (error) { if (signal.aborted) return undefined; throw error; }
  }
  private async flushReport(): Promise<void> {
    const saved = this.state().pendingReport;
    if (!saved) return;
    await this.mineCall(mine => mine.reportMiner(saved));
    this.update(state => { if (JSON.stringify(state.pendingReport) === JSON.stringify(saved)) state.pendingReport = undefined; });
  }
  private async reconcileCancellation(): Promise<void> {
    const session = this.harness.session();
    await session.abort(); // Requests durable cancellation; does not await the model run.
    const state = this.state();
    const pending = await this.harness.pending();
    const result = state.operationId && (state.phase === 'submitted' || pending.some(item => item.operationId === state.operationId)) ? await this.shortWait(state.operationId) : undefined;
    if (await session.busy() || (await this.harness.pending()).length) {
      this.update(current => { current.nextDriveAt = Date.now() + RECONCILE_MS; });
      return;
    }
    this.update(current => {
      current.cancelIntent = false;
      current.grant = undefined;
      current.prompt = undefined;
      current.phase = 'settled';
      current.nextDriveAt = Date.now();
      current.nextEligibleAt = Math.max(current.nextEligibleAt, Date.now() + DECISION_MS);
      current.lastDecision = { status: result?.status ?? 'unanswered', reason: result?.reason ?? 'cancelled', at: Date.now() };
      if (current.agentId) current.pendingReport = { agentId: current.agentId, generation: current.generation,
        state: current.retired ? 'retired' : current.mode === 'running' ? 'idle' : 'paused', memory: current.memory,
        ...(current.burstId ? { settledBurst: current.burstId } : {}),
      };
    });
  }

  private async drive(): Promise<void> {
    let state = this.state();
    if (state.blocked || !state.agentId) return;
    if (state.cancelIntent) { await this.reconcileCancellation(); return; }
    await this.flushReport();
    state = this.state();
    if (state.restartPending) {
      await this.mineCall(mine => mine.reportMiner({ agentId: state.agentId!, generation: state.generation, restart: true }));
      this.update(current => { current.restartPending = false; });
      state = this.state();
    }
    if (state.phase === 'submitted') {
      const result = await this.shortWait(state.operationId!);
      if (!result || await this.harness.session().busy() || (await this.harness.pending()).length) {
        this.update(current => { current.nextDriveAt = Date.now() + RECONCILE_MS; });
        return;
      }
      this.finishDecision(result);
      await this.flushReport();
      return;
    }
    if (state.mode !== 'running' || state.retired || state.exhausted || state.admissionSuspended) return;
    if (Date.now() < Math.max(state.nextEligibleAt, state.physicalAction?.endsAt ?? 0)) return;
    if (state.phase === 'settled' || state.phase === 'eligible') {
      const session = this.harness.session();
      const pending = await this.harness.pending();
      if (pending.length || await session.busy()) {
        this.update(current => { current.nextDriveAt = Date.now() + RECONCILE_MS; });
        return;
      }
      if (state.phase === 'settled' || !state.burstId) state = this.update(current => {
        current.burstSequence++;
        current.burstId = `burst:${current.runId}:${current.agentId}:${current.burstSequence}`;
        current.operationId = undefined;
        current.burstGeneration = undefined;
        current.burstRevision = undefined;
        current.grant = undefined;
        current.phase = 'eligible';
        current.admissionRequired = false;
        current.toolFailure = false;
        current.invocationId = undefined;
        current.nextDriveAt = Date.now();
      });
      const receipt = await this.mineCall(mine => mine.enqueueDecision({ agentId: state.agentId!, generation: state.generation, burstId: state.burstId!, eligibleAt: state.nextEligibleAt }));
      this.update(current => {
        // A grant/control notice can interleave while enqueueDecision crosses objects.
        if (receipt.generation < current.generation) return;
        current.generation = receipt.generation;
        current.mode = receipt.mode;
        current.retired ||= receipt.status === 'retired';
        current.exhausted ||= receipt.status === 'exhausted';
        if (receipt.status === 'queued') current.phase = 'queued';
        else { current.phase = 'settled'; current.grant = undefined; }
      });
      return; // Queued miners retain no admission poll or resident timer.
    }
    if (state.phase === 'queued') {
      if (!state.grant) return;
      const session = this.harness.session();
      if ((await this.harness.pending()).length || await session.busy()) {
        this.update(current => { current.nextDriveAt = Date.now() + RECONCILE_MS; });
        return;
      }
      const grant = state.grant;
      const observation = await this.mineCall(mine => mine.observe(state.agentId!));
      if (observation.generation !== grant.generation || observation.mode !== 'running' || observation.self.retired || observation.exhausted) {
        this.update(current => {
          if (observation.generation >= current.generation && observation.revision >= current.latestRevision) {
            current.generation = observation.generation;
            current.mode = observation.mode;
            current.retired ||= observation.self.retired;
            current.exhausted = observation.exhausted;
            current.latestRevision = observation.revision;
            current.cancelIntent = true;
            current.grant = undefined;
            current.nextDriveAt = Date.now();
          }
        });
        return;
      }
      const prompt = buildPrompt(observation, state.memory);
      // buildPrompt can trim old messages; never skip a sequence omitted from the actual prompt.
      const shown = observation.messages.filter(message => prompt.includes(JSON.stringify(message)));
      const consumed = shown.length === observation.messages.length ? Math.max(state.memory.messageCursor, ...shown.map(message => message.sequence)) : state.memory.messageCursor;
      await this.mineCall(mine => mine.reportMiner({ agentId: state.agentId!, generation: grant.generation,
        observation: { revision: observation.revision, messageSequences: shown.map(message => message.sequence), resourceTargets: observation.resourceTargets.map(target => ({ x: target.x, y: target.y })) },
      }));
      this.update(current => {
        if (current.cancelIntent || current.mode !== 'running' || current.generation !== grant.generation || observation.generation !== grant.generation || observation.mode !== 'running'
          || observation.self.retired || observation.exhausted || current.grant?.grantId !== grant.grantId) return;
        current.burstGeneration = grant.generation;
        current.burstRevision = observation.revision;
        current.operationId = current.burstId;
        current.prompt = prompt;
        current.consumedMessageCursor = consumed;
        current.phase = 'preparing';
        current.nextDriveAt = Date.now();
      });
      return;
    }
    if (state.phase === 'preparing') {
      if ((await this.harness.pending()).length || await this.harness.session().busy()) {
        this.update(current => { current.nextDriveAt = Date.now() + RECONCILE_MS; });
        return;
      }
      await this.harness.session().reset();
      this.update(current => { if (current.operationId === state.operationId && current.phase === 'preparing') current.phase = 'prepared'; });
      return;
    }
    if (state.phase === 'prepared') {
      const pending = await this.harness.pending();
      if (pending.some(item => item.operationId !== state.operationId) || await this.harness.session().busy() && !pending.some(item => item.operationId === state.operationId)) {
        this.update(current => { current.nextDriveAt = Date.now() + RECONCILE_MS; });
        return;
      }
      // Repeating this call after a crash reuses Pi's durable idempotency key, without another reset.
      await this.harness.session().submit(state.prompt!, { operationId: state.operationId!, whenBusy: 'reject', entry: {
        kind: 'app.miner-burst', data: { burstSequence: state.burstSequence, generation: state.burstGeneration! },
      } });
      this.update(current => { if (current.operationId === state.operationId) { current.phase = 'submitted'; current.nextDriveAt = Date.now(); } });
    }
  }

  private finishDecision(result: PiOperationResult): void {
    this.update(state => {
      const terminal = state.lastTerminal?.burstId === state.burstId ? state.lastTerminal : undefined;
      const providerError = terminal?.error !== undefined && terminal.error !== 'USAGE_UNAVAILABLE';
      const expected = result.status === 'done' || result.reason === 'turn_limit';
      const failed = !state.admissionRequired && (providerError || state.toolFailure || !expected);
      const needsOperator = terminal?.status === 429 || terminal?.status === 401 || terminal?.status === 403 || terminal?.status === 404;
      state.admissionSuspended ||= needsOperator;
      state.memory.messageCursor = Math.max(state.memory.messageCursor, state.consumedMessageCursor ?? 0);
      state.consumedMessageCursor = undefined;
      state.phase = 'settled';
      state.grant = undefined;
      state.prompt = undefined;
      state.nextEligibleAt = Math.max(Date.now() + (failed ? ERROR_MS : DECISION_MS), state.physicalAction?.endsAt ?? 0);
      state.nextDriveAt = Date.now();
      state.lastDecision = { status: result.status, ...(result.reason ? { reason: result.reason } : {}), ...(result.text ? { text: text(result.text) } : {}), at: Date.now() };
      state.pendingReport = { agentId: state.agentId!, generation: state.generation,
        state: failed ? 'error' : state.physicalAction ? state.physicalAction.kind === 'mine' ? 'mining' : 'walking' : 'idle',
        memory: state.memory, settledBurst: state.burstId,
        ...(failed ? { error: needsOperator ? 'INFERENCE_QUOTA_OR_CONFIGURATION' : state.toolFailure ? 'TOOL_EXECUTION_ERROR' : terminal?.error ?? 'MODEL_DECISION_ERROR' } : {}),
      };
    });
  }

  async inspect(input: { cursor?: string; limit: number }): Promise<PublicTranscriptPage> {
    await this.lifecycle.start();
    const limit = Math.max(1, Math.min(50, Number.isInteger(input.limit) ? input.limit : 50));
    let cursor: TraceCursor | undefined;
    if (input.cursor !== undefined) {
      if (input.cursor.length > 128) throw new PublicError('INVALID_CURSOR', 'Invalid transcript cursor.');
      try {
        const value: unknown = JSON.parse(input.cursor);
        if (typeof value !== 'object' || value === null || !('entryId' in value) || !('offset' in value) || typeof value.entryId !== 'number' || !Number.isSafeInteger(value.entryId) || value.entryId < 1
          || typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 100_000) throw new Error('Invalid cursor');
        cursor = { entryId: value.entryId, offset: value.offset };
      } catch { throw new PublicError('INVALID_CURSOR', 'Invalid transcript cursor.'); }
    }
    const session = this.harness.session();
    // The installed PiSession has no cursor parameter; maxEntryId is inclusive and spans resets.
    const page = await session.entries({ order: 'descending', ...(cursor ? { maxEntryId: cursor.entryId as EntryId } : {}) }, 50);
    const entries: PublicTraceEntry[] = [];
    let nextCursor: string | undefined;
    for (let index = 0; index < page.items.length; index++) {
      const source = page.items[index];
      const offset = cursor?.entryId === source.id ? cursor.offset : 0;
      const projection = this.projectEntry(source);
      const take = Math.min(limit - entries.length, Math.max(0, projection.length - offset));
      entries.push(...projection.slice(offset, offset + take));
      if (entries.length === limit) {
        if (offset + take < projection.length) nextCursor = JSON.stringify({ entryId: source.id, offset: offset + take });
        else if (source.id > 1 && (index + 1 < page.items.length || page.next)) nextCursor = JSON.stringify({ entryId: Number(source.id) - 1, offset: 0 });
        break;
      }
      if (index === page.items.length - 1 && page.next && source.id > 1) nextCursor = JSON.stringify({ entryId: Number(source.id) - 1, offset: 0 });
    }
    const state = this.update(current => { current.transcriptCursor = nextCursor; });
    return { entries, ...(nextCursor ? { nextCursor } : {}), busy: await session.busy(), operationId: state.operationId, phase: state.phase, memory: state.memory, blocked: state.blocked };
  }

  private projectEntry(entry: EntryRecord): PublicTraceEntry[] {
    const projected: PublicTraceEntry[] = [];
    const push = (value: Omit<PublicTraceEntry, 'id'>): void => { projected.push({ id: `${entry.id}:${projected.length}`, ...value }); };
    if (entry.kind === 'app.miner-burst') { push({ kind: 'input', text: 'Authoritative observation and mine handbook submitted.' }); return projected; }
    for (const message of entry.model ?? []) {
      if (message.role === 'assistant') {
        for (const part of message.content) {
          if (part.type === 'text' && part.text) push({ kind: 'text', timestamp: message.timestamp, text: text(part.text) });
          else if (part.type === 'toolCall' && toolName(part.name)) {
            const args = publicArguments(part.name, part.arguments);
            push({ kind: 'tool_call', timestamp: message.timestamp, tool: part.name, ...(args ? { args } : {}) });
          }
          // thinking, signatures, provider-native payloads, and diagnostics are never projected.
        }
        push({ kind: 'status', timestamp: message.timestamp, status: message.stopReason,
          durationMs: message.durationMs, usage: { input: message.usage.input, output: message.usage.output } });
      } else if (message.role === 'toolResult' && toolName(message.toolName)) {
        const saved = entry.byTaskId === undefined ? undefined : this.ctx.storage.sql.exec<ToolRecord>('SELECT * FROM cg_miner_tools WHERE task_id=?', String(entry.byTaskId)).toArray()[0];
        if (saved) push({ kind: 'tool_result', timestamp: message.timestamp, tool: saved.tool,
          args: JSON.parse(saved.args) as ToolArguments, result: text(saved.result, 8_192), durationMs: saved.duration_ms, status: message.isError ? 'error' : 'ok' });
        else push({ kind: 'tool_result', timestamp: message.timestamp, tool: message.toolName, status: message.isError ? 'error' : 'ok', durationMs: message.durationMs });
      }
    }
    return projected;
  }
}

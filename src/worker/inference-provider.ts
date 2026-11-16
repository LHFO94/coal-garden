import { createAI } from 'agents/models/pi-ai';
import { lazyStream } from '@earendil-works/pi-ai/api/lazy';
import type { Api, AssistantMessage, AssistantMessageEvent, Model, Provider, SimpleStreamOptions, StreamOptions } from '@earendil-works/pi-ai';
import { MODEL_ID, type InferenceClaim, type InferenceClaimResult, type InferenceSettlement } from '../shared/protocol';

export interface AdmissionHost {
  currentClaim(): Omit<InferenceClaim, 'invocationId'> | undefined;
  claim(input: InferenceClaim): Promise<InferenceClaimResult>;
  settle(input: InferenceSettlement): Promise<void>;
  admissionRejected(): Promise<void>;
}

/** Pure metadata: constructing a miner or selecting its model never reads an AI binding. */
export function selectedModel(): Model<Api> {
  return {
    id: MODEL_ID, name: 'Qwen 3.8 27B', provider: 'cloudflare', api: 'cloudflare-ai', baseUrl: '',
    input: ['text'], reasoning: true, contextWindow: 262_144, maxTokens: 1_024,
    cost: { input: 0.45, output: 3.2, cacheRead: 0.05, cacheWrite: 0 },
  };
}

function enforcedOptions(options?: StreamOptions): SimpleStreamOptions {
  return { ...options, maxTokens: 1_024, maxRetries: 0, timeoutMs: 90_000, reasoning: undefined,
    // Raw body overrides merge after named fields and must not bypass this policy.
    samplingParams: undefined,
  };
}

/** Keep provider metadata/auth intact and bind any inherited methods to their real receiver. */
function withStreams(base: Provider, stream: Provider['stream'], streamSimple: Provider['streamSimple'], model = selectedModel()): Provider {
  const models = [model];
  return new Proxy(base, {
    get(target, property) {
      if (property === 'stream') return stream;
      if (property === 'streamSimple') return streamSimple;
      if (property === 'getModels' || property === 'getAllModels') return () => models;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function createLiveProvider(binding: Ai, identity: () => Pick<InferenceClaim, 'runId' | 'agentId' | 'burstId' | 'invocationId'>): Provider {
  const gateway = 'coal-garden';
  const ai = createAI({ binding, gateway, skipCache: true, collectLog: true, retries: { maxAttempts: 1 }, requestTimeoutMs: 90_000 });
  // Reattach routing and trusted identity at dispatch: Pi strips model symbol metadata.
  const dispatchModel = () => {
    const claim = identity();
    return ai(selectedModel(), {
      gateway, collectLog: true,
      metadata: {
        user: `miner:${claim.runId}:${claim.agentId}`,
        run_id: claim.runId, agent_id: claim.agentId,
        burst_id: claim.burstId, invocation_id: claim.invocationId,
      },
      eventId: claim.burstId,
      headers: { 'cf-aig-collect-log-payload': 'false' },
      reasoningEffort: null, chatTemplateKwargs: { enable_thinking: false },
      fallback: [], skipCache: true, retries: { maxAttempts: 1 },
      requestTimeoutMs: 90_000, streamIdleTimeoutMs: 90_000,
    });
  };
  return withStreams(ai.provider,
    (_model, context, options) => ai.provider.stream(dispatchModel(), context, enforcedOptions(options)),
    (_model, context, options) => ai.provider.streamSimple(dispatchModel(), context, enforcedOptions(options)),
  );
}


/** Read only a bounded, whitelisted diagnostic projection, never arbitrary provider text or data. */
function failure(message: AssistantMessage): { error: string; status?: number } {
  let status: number | undefined;
  for (const diagnostic of message.diagnostics?.slice(0, 8) ?? []) {
    if (diagnostic.type !== 'cloudflare-error') continue;
    const details = diagnostic.details;
    if (typeof details === 'object' && details !== null && !Array.isArray(details)) {
      const candidate = details.status;
      if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) status = candidate;
    }
  }
  return { error: message.stopReason === 'aborted' ? 'PROVIDER_ABORTED' : 'PROVIDER_ERROR', ...(status === undefined ? {} : { status }) };
}

function knownUsage(message: AssistantMessage): boolean {
  const usage = message.usage;
  // Error messages and absent provider usage are initialized to zero by the SDK.
  return usage !== undefined && [usage.input, usage.output, usage.cacheRead].every(value => Number.isSafeInteger(value) && value >= 0)
    && usage.input + usage.output + usage.cacheRead > 0;
}

export function guardProvider(base: Provider, host: AdmissionHost): Provider {
  const model = selectedModel();
  const advertised = base.getModels().find(candidate => candidate.id === model.id && candidate.api === model.api);
  // Zero prices belong to an explicitly injected benchmark provider, not an environment switch.
  const zeroPrice = advertised !== undefined && advertised.cost.input === 0 && advertised.cost.output === 0
    && advertised.cost.cacheRead === 0 && advertised.cost.cacheWrite === 0;
  if (zeroPrice) model.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const setup = async (start: (options: SimpleStreamOptions) => AsyncIterable<AssistantMessageEvent>, options?: StreamOptions): Promise<AsyncIterable<AssistantMessageEvent>> => {
    const saved = host.currentClaim();
    if (!saved) {
      await host.admissionRejected();
      throw new Error('ADMISSION_REQUIRED');
    }
    const claim: InferenceClaim = { ...saved, invocationId: crypto.randomUUID() };
    let receipt: InferenceClaimResult;
    try {
      receipt = await host.claim(claim);
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true
        && !('overloaded' in error && error.overloaded === true))) throw error;
      receipt = await host.claim(claim);
    }
    if (!receipt.ok) {
      await host.admissionRejected();
      throw new Error('ADMISSION_REQUIRED');
    }
    const outbound: NonNullable<InferenceSettlement['outbound']> = {
      model: MODEL_ID, reasoningEffort: 'off', maxTokens: 1_024, noFallback: true, maxAttempts: 1,
    };
    return (async function* () {
      let terminal = false;
      const startedAt = performance.now();
      try {
        options?.signal?.throwIfAborted();
        for await (const event of start(enforcedOptions(options))) {
          if (event.type === 'done' || event.type === 'error') {
            const message = event.type === 'done' ? event.message : event.error;
            const settlement: InferenceSettlement = {
              invocationId: claim.invocationId, agentId: claim.agentId, completedAt: Date.now(), outbound,
              durationMs: Math.max(0, performance.now() - startedAt),
              ...(knownUsage(message) || (zeroPrice && event.type === 'done') ? {
                inputTokens: message.usage.input, outputTokens: message.usage.output, cacheReadTokens: message.usage.cacheRead,
              } : {}),
              ...(event.type === 'error' ? failure(message)
                : !knownUsage(message) && !zeroPrice ? { error: 'USAGE_UNAVAILABLE' } : {}),
            };
            // Pi must not see a terminal until the authoritative charge and local metadata persist.
            await host.settle(settlement);
            terminal = true;
          }
          yield event;
        }
        if (!terminal) throw new Error('INFERENCE_OUTCOME_UNKNOWN');
      } finally {
        if (!terminal) await host.settle({
          invocationId: claim.invocationId, agentId: claim.agentId, completedAt: Date.now(),
          durationMs: Math.max(0, performance.now() - startedAt),
          error: 'INFERENCE_OUTCOME_UNKNOWN', outbound,
        });
      }
    })();
  };
  return withStreams(base,
    (_model, context, options) => lazyStream(model, () => setup(enforced => base.stream(model, context, enforced), options), undefined, options?.signal),
    (_model, context, options) => lazyStream(model, () => setup(enforced => base.streamSimple(model, context, enforced), options), undefined, options?.signal),
    model,
  );
}

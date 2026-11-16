import { createProvider, type AssistantMessage, type AssistantMessageEvent, type Model, type Api, type Provider, type ToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import { lazyStream } from '@earendil-works/pi-ai/api/lazy';
import worker from '../worker/index';
import { Mine } from '../worker/mine';
import { Miner } from '../worker/miner';
import { selectedModel } from '../worker/inference-provider';
import { INVENTORY_CAPACITY, WORLD_HEIGHT, WORLD_WIDTH, type Coordinate, type Observation, type RuntimePolicy, type ToolArguments, type ToolName } from '../shared/protocol';

interface PromptMemory {
  lastTools: { tool: ToolName; args: ToolArguments; result: { ok: boolean }; at: number }[];
}

function promptState(context: TranscriptContext): { observation: Observation; memory: PromptMemory } {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index]!;
    if (message.role !== 'user') continue;
    const text = typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const lines = text.split('\n');
    const observationAt = lines.findIndex(line => line.startsWith('Observation JSON ('));
    const memoryAt = lines.findIndex(line => line.startsWith('Persistent structured memory JSON ('));
    if (observationAt < 0 || memoryAt < 0) continue;
    return { observation: JSON.parse(lines[observationAt + 1]!) as Observation, memory: JSON.parse(lines[memoryAt + 1]!) as PromptMemory };
  }
  throw new Error('SYNTHETIC_OBSERVATION_REQUIRED');
}

function same(a: Coordinate | undefined, b: Coordinate): boolean { return a?.x === b.x && a.y === b.y; }
function distance(a: Coordinate, b: Coordinate): number { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }

/** This planner is deliberately confined to the explicit local synthetic provider. */
function decide(observation: Observation, memory: PromptMemory): ToolCall[] {
  if (observation.mode !== 'running' || observation.exhausted || observation.self.retired || observation.action) return [];
  const calls: ToolCall[] = [];
  const call = (name: ToolName, args: ToolCall['arguments']) => calls.push({ type: 'toolCall', id: `synthetic-${observation.runId}-${observation.self.agentId}-${observation.revision}-${calls.length}`, name, arguments: args });
  const self = observation.self;
  const carried = self.inventory.coal + self.inventory.diamonds;
  const lastWork = memory.lastTools.findLast(entry => entry.tool !== 'talk');
  const returning = lastWork?.tool === 'walk_to' && lastWork.result.ok
    && lastWork.args.x === observation.hopper.x && lastWork.args.y === observation.hopper.y;
  if (carried > 0 && (carried >= INVENTORY_CAPACITY || returning)) {
    if (distance(self, observation.hopper) <= 1) call('deposit', {});
    else call('walk_to', { x: observation.hopper.x, y: observation.hopper.y });
    return calls;
  }
  const known = new Set(observation.localTiles.map(tile => tile.y * WORLD_WIDTH + tile.x));
  let unseenLocal = false;
  for (let y = Math.max(0, self.y - 6); y <= Math.min(WORLD_HEIGHT - 1, self.y + 6) && !unseenLocal; y++) {
    for (let x = Math.max(0, self.x - 6); x <= Math.min(WORLD_WIDTH - 1, self.x + 6); x++) {
      if (distance(self, { x, y }) <= 6 && !known.has(y * WORLD_WIDTH + x)) { unseenLocal = true; break; }
    }
  }
  const lastPhysicalOrDiscovery = memory.lastTools.findLast(entry => entry.tool !== 'talk');
  // A recent discovery with no subsequent walk already covered this position. Truncated
  // local observations must not turn that into an endless paid/discover-equivalent loop.
  if (unseenLocal && lastPhysicalOrDiscovery?.tool !== 'discover') {
    call('discover', {});
    return calls;
  }
  const targets = observation.resourceTargets.filter(target => target.available > 0 && !target.claimant);
  const announced = targets.find(target => target.resource === targets[0]?.resource && observation.messages.some(message => same(message.at, target) && message.sender !== self.agentId));
  const target = announced ?? targets[0];
  if (target) {
    const alreadyAnnounced = observation.messages.some(message => same(message.at, target)) || memory.lastTools.some(entry => entry.tool === 'talk' && entry.result.ok && same(entry.args.at, target));
    const lastTalk = memory.lastTools.findLast(entry => entry.tool === 'talk' && entry.result.ok);
    if (!alreadyAnnounced && (!lastTalk || observation.serverTime - lastTalk.at >= 5_000)) {
      call('talk', { audience: 'mine', message: `SYNTHETIC ${target.resource} deposit at (${target.x},${target.y}); approach (${target.destination.x},${target.destination.y}).`, at: { x: target.x, y: target.y } });
    }
    if (distance(self, target) === 1) call('mine', { x: target.x, y: target.y });
    else call('walk_to', { x: target.destination.x, y: target.destination.y });
  } else {
    const frontier = observation.frontiers.find(candidate => !same(candidate, self));
    if (frontier) call('walk_to', { x: frontier.x, y: frontier.y });
    else if (carried > 0) {
      if (distance(self, observation.hopper) <= 1) call('deposit', {});
      else call('walk_to', { x: observation.hopper.x, y: observation.hopper.y });
    }
  }
  return calls;
}

function syntheticProvider(): Provider {
  const model: Model<Api> = { ...selectedModel(), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const stream: Provider['streamSimple'] = (_selected, context, options) => lazyStream(model, async () => {
    options?.signal?.throwIfAborted();
    const { observation, memory } = promptState(context);
    const calls = decide(observation, memory);
    return (async function* (): AsyncGenerator<AssistantMessageEvent> {
      const message: AssistantMessage = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: calls.length ? 'toolUse' : 'stop',
      };
      yield { type: 'start', partial: message };
      for (const toolCall of calls) {
        options?.signal?.throwIfAborted();
        const contentIndex = message.content.length;
        message.content.push({ ...toolCall, arguments: {} });
        yield { type: 'toolcall_start', contentIndex, partial: message };
        yield { type: 'toolcall_delta', contentIndex, delta: JSON.stringify(toolCall.arguments), partial: message };
        message.content[contentIndex] = toolCall;
        yield { type: 'toolcall_end', contentIndex, toolCall, partial: message };
      }
      yield { type: 'done', reason: calls.length ? 'toolUse' : 'stop', message };
    })();
  }, undefined, options?.signal);
  return createProvider({ id: model.provider, name: 'SYNTHETIC / NO MODEL INFERENCE', models: [model],
    auth: { apiKey: { name: 'Local synthetic benchmark', resolve: async () => ({ auth: {} }) } },
    api: { stream, streamSimple: stream },
  });
}

export class BenchmarkMiner extends Miner {
  protected override createBaseProvider(): Provider { return syntheticProvider(); }
}

export class BenchmarkMine extends Mine {
  protected override runtimePolicy(): RuntimePolicy { return { providerMode: 'synthetic', defaultRPM: 6_000, maxInFlight: 32, reservationMicroUSD: 0 }; }
}

export default worker;

import { flags, client, command, stopRun, save, sleep, eventsSince, invariant, halted, interruption } from './common.mjs';
const options = flags({ agents: { type: 'string', default: '3' }, provider: { type: 'string', default: 'live' }, 'budget-usd': { type: 'string', default: '5' } });
const count = Number(options.agents);
if (!Number.isInteger(count) || count < 2 || count > 1000 || !['live', 'synthetic'].includes(options.provider) || Number(options['budget-usd']) !== 5) throw new Error('Use 2–1000 agents, provider live|synthetic, and the fixed --budget-usd 5.');
const request = client(options.base), interrupt = interruption(), runId = crypto.randomUUID();
const output = options.output ?? `results/${options.provider}-smoke.json`;
const result = { runId, provider: options.provider, startedAt: Date.now(), accepted: false, criteria: {}, events: [], traces: [] };
let created = false, seen = 0;
function criteria(events, metrics) {
  const messages = events.flatMap(event => event.changes.filter(change => change.kind === 'message_append').map(change => change.message));
  let cooperation;
  for (const message of messages) {
    if (!message.at) continue;
    const observation = events.find(event => event.type === 'observation' && event.agentId !== message.sender && event.revision > message.revision && event.detail?.messageSequences?.includes(message.sequence));
    if (!observation) continue;
    const action = events.find(event => event.revision > observation.revision && event.agentId === observation.agentId && event.type === 'action' && !event.detail?.completed && event.at && ((event.detail?.tool === 'mine' && event.at.x === message.at.x && event.at.y === message.at.y) || (event.detail?.tool === 'walk_to' && Math.abs(event.at.x - message.at.x) + Math.abs(event.at.y - message.at.y) === 1)));
    if (action) { cooperation = { sequence: message.sequence, sender: message.sender, teammate: observation.agentId, coordinate: message.at, observationRevision: observation.revision, actionRevision: action.revision, actionId: action.detail?.actionId }; break; }
  }
  const claimed = new Set(events.filter(event => event.type === 'inference' && event.detail?.grantId && event.detail?.invocationId).map(event => event.detail.invocationId));
  const responses = events.filter(event => event.type === 'inference' && event.detail?.knownUsage !== undefined);
  return {
    realResponses: options.provider === 'synthetic' ? 'not_applicable_synthetic' : metrics.agentsWithRealInference >= count,
    provisioned: metrics.provisioned === count,
    validatedTools: metrics.agentsWithValidatedTools === count,
    discover: events.some(event => event.type === 'discovery'),
    walk: events.some(event => event.type === 'action' && event.detail?.tool === 'walk_to' && !event.detail?.completed),
    extraction: metrics.coal + metrics.diamonds > 0,
    talk: messages.length > 0,
    cooperation,
    guardedDispatch: responses.length > 0 && responses.every(event => claimed.has(event.detail.invocationId) && event.detail.model === '@cf/qwen/qwen3.8-27b' && event.detail.reasoningEffort === 'off' && event.detail.maxTokens === 1024 && event.detail.noFallback === true && event.detail.maxAttempts === 1),
    resourceInvariant: invariant(metrics),
  };
}
try {
  const snapshot = await request('/api/runs', { runId, operationId: crypto.randomUUID(), seed: options.seed }); created = true;
  if (snapshot.run.providerMode !== options.provider) throw new Error(`Server is ${snapshot.run.providerMode}, requested ${options.provider}`);
  if (snapshot.run.allowanceMicroUSD !== 5_000_000) throw new Error('Server allowance differs from fixed $5');
  await command(request, runId, 'spawn', { count }); await command(request, runId, 'resume');
  const until = Date.now() + 15 * 60000;
  while (Date.now() < until) {
    interrupt.check();
    const events = await eventsSince(request, runId, seen);
    if (events.length) seen = events.at(-1).revision;
    result.events.push(...events);
    const metrics = await request(`/api/runs/${runId}/metrics`);
    result.criteria = criteria(result.events, metrics);
    const reason = halted(metrics); if (reason) { result.halted = reason; break; }
    if (Object.values(result.criteria).every(Boolean)) {
      const before = metrics;
      // This runner never opens a viewer. Observe another full minute of server-only work.
      const absenceUntil = Date.now() + 60000;
      while (Date.now() < absenceUntil) { interrupt.check(); await sleep(Math.min(1000, absenceUntil - Date.now())); }
      const after = await request(`/api/runs/${runId}/metrics`);
      result.noViewer = { durationMs: after.serverTime - before.serverTime, beforeCalls: before.modelCallsTotal, afterCalls: after.modelCallsTotal, beforeValue: before.value, afterValue: after.value, progressed: after.modelCallsTotal > before.modelCallsTotal || after.value > before.value };
      break;
    }
    await sleep(2000);
  }
  await command(request, runId, 'pause');
  result.measurement = await request(`/api/runs/${runId}/export`);
  for (let index = 1; index <= count; index++) {
    const trace = await request(`/api/runs/${runId}/miners/${index}/trace?limit=50`);
    result.traces.push({ agentId: String(index), ...trace });
  }
  result.accepted = Object.values(result.criteria).every(Boolean) && result.noViewer?.progressed === true && result.traces.every(trace => trace.entries.some(entry => entry.kind === 'tool_result'));
  if (!result.accepted && !result.halted) result.failure = 'Acceptance criteria not met before timeout, or the public transcript lacks a validated tool result.';
} catch (error) { result.error = { code: error.code ?? error.name, message: error.message }; }
finally {
  if (created) {
    try { await stopRun(request, runId); result.stoppedAt = Date.now(); } catch (error) { result.stopError = error.message; }
    if (!result.measurement) { try { result.measurement = await request(`/api/runs/${runId}/export`); } catch (error) { result.exportError = error.message; } }
  }
  interrupt.close(); await save(output, result);
}
console.log(JSON.stringify({ runId, accepted: result.accepted, halted: result.halted, error: result.error, criteria: result.criteria, output }));
if (!result.accepted || result.stopError) process.exitCode = 1;

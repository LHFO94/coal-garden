import { flags, client, command, stopRun, save, sleep, invariant, halted, interruption } from './common.mjs';

const options = flags({ mode: { type: 'string' }, counts: { type: 'string' }, seconds: { type: 'string' } });
if (!['live', 'synthetic'].includes(options.mode) || !options.counts || !options.seconds || !options.output) throw new Error('Required: --base --mode live|synthetic --counts --seconds --seed --output');
const counts = options.counts.split(',').map(Number), seconds = Number(options.seconds);
if (counts.some(n => !Number.isInteger(n) || n < 1 || n > 1000) || !Number.isInteger(seconds) || seconds < 1) throw new Error('Counts must be 1–1000; seconds must be positive.');
const request = client(options.base), interrupt = interruption();
const result = { recordedAt: new Date().toISOString(), base: options.base, mode: options.mode, label: options.mode === 'synthetic' ? 'SYNTHETIC / NO MODEL INFERENCE' : 'LIVE QWEN', seed: options.seed, requestedCounts: counts, requestedSeconds: seconds, rows: [], complete: false, cpu: 'unavailable', memory: 'unavailable', renderingFPS: 'unavailable; run browser proof separately' };
let activeRun;
try {
  for (const count of counts) {
    interrupt.check();
    const runId = crypto.randomUUID(); activeRun = runId;
    const row = { requested: count, runId, startedAt: Date.now(), samples: [], accepted: false };
    result.rows.push(row);
    try {
      const created = await request('/api/runs', { runId, operationId: crypto.randomUUID(), seed: options.seed });
      if (created.run.providerMode !== options.mode) throw new Error(`Server mode ${created.run.providerMode} does not match ${options.mode}`);
      if (options.mode === 'live' && created.run.allowanceMicroUSD !== 5_000_000) throw new Error('Live allowance is not the required fixed $5');
      await command(request, runId, 'spawn', { count });
      const provisionStarted = Date.now(), provisionUntil = provisionStarted + 120000;
      while (true) {
        interrupt.check();
        const metrics = await request(`/api/runs/${runId}/metrics`);
        if (metrics.provisioned === count) break;
        if (Date.now() >= provisionUntil || metrics.mode === 'capacity_paused') throw new Error(`PROVISIONING_INCOMPLETE: ${metrics.provisioned}/${count}`);
        await sleep(500);
      }
      row.provisioningMs = Date.now() - provisionStarted;
      row.sampleStartedAt = Date.now();
      await command(request, runId, 'resume');
      const until = Date.now() + seconds * 1000;
      while (Date.now() < until) {
        interrupt.check();
        const metrics = await request(`/api/runs/${runId}/metrics`);
        row.samples.push({ at: Date.now(), retained: metrics.retained, provisioned: metrics.provisioned, realAgents: metrics.agentsWithRealInference, toolAgents: metrics.agentsWithValidatedTools, coal: metrics.coal, diamonds: metrics.diamonds, value: metrics.value, queued: metrics.states.queued, calls: metrics.modelCallsTotal, inFlight: metrics.inFlight, backlog: metrics.deliveryBacklog, oldestDeliveryAgeMs: metrics.oldestDeliveryAgeMs, worldRPCp95: metrics.worldRPC.p95, errors: metrics.errors });
        const reason = halted(metrics); if (reason) { row.halted = reason; break; }
        await sleep(Math.min(2000, Math.max(1, until - Date.now())));
      }
      await command(request, runId, 'pause');
      row.measurement = await request(`/api/runs/${runId}/export`);
      const metrics = row.measurement.metrics;
      row.durationMs = Date.now() - row.sampleStartedAt;
      row.scope = options.mode === 'synthetic' ? 'Local actual Pi/Miner/Mine code with injected deterministic provider; not remote scale.' : count === 1000 ? 'Provisioning and bounded real work; no claim of 1,000 model responses or concurrent inference.' : 'Real terminal responses, validated Pi tools, and completed extraction required per miner count.';
      const fullPass = metrics.agentsWithValidatedTools === count && (options.mode === 'synthetic' || metrics.agentsWithRealInference === count);
      const boundedLiveStress = options.mode === 'live' && count === 1000 && metrics.agentsWithValidatedTools > 0 && metrics.agentsWithRealInference > 0;
      row.accepted = !row.halted && invariant(metrics) && metrics.provisioned === count && metrics.coal + metrics.diamonds > 0 && (fullPass || boundedLiveStress);
      console.log(JSON.stringify({ count, runId, accepted: row.accepted, halted: row.halted, provisioned: metrics.provisioned, realAgents: metrics.agentsWithRealInference, toolAgents: metrics.agentsWithValidatedTools, coal: metrics.coal, diamonds: metrics.diamonds, value: metrics.value, worldRPCp95: metrics.worldRPC.p95, observedMicroUSD: metrics.observedMicroUSD }));
    } catch (error) {
      row.error = { code: error.code ?? error.name, message: error.message };
      try { row.measurement = await request(`/api/runs/${runId}/export`); } catch (exportError) { row.exportError = exportError.message; }
    } finally {
      await stopRun(request, runId); activeRun = undefined;
      row.stoppedAt = Date.now();
      await save(options.output, result);
    }
    if (row.halted || row.error) { result.stoppedAfter = count; break; }
  }
  result.complete = result.rows.length === counts.length && result.rows.every(row => row.accepted);
} catch (error) { result.error = error.message; }
finally {
  if (activeRun) { try { await stopRun(request, activeRun); } catch (error) { result.stopError = error.message; } }
  interrupt.close(); await save(options.output, result);
}
if (!result.complete) { console.error(`Scale acceptance not met. Evidence: ${options.output}`); process.exitCode = 1; }

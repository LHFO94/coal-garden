import { parseArgs } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
export function flags(extra = {}) {
  const { values } = parseArgs({ options: { base: { type: 'string' }, seed: { type: 'string', default: '42' }, output: { type: 'string' }, ...extra }, strict: true });
  if (!values.base) throw new Error('--base is required');
  const url = new URL(values.base); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP base URL');
  values.base = url.origin;
  values.seed = Number(values.seed);
  if (!Number.isInteger(values.seed) || values.seed < 0 || values.seed > 0xffffffff) throw new Error('--seed must be uint32');
  return values;
}
export const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export function client(base) {
  const headers = { Origin: new URL(base).origin };
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
  }
  return async (path, data) => {
    const response = await fetch(base + path, { method: data ? 'POST' : 'GET', headers: { ...headers, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(30000), redirect: 'error' });
    let value; try { value = await response.json(); } catch { throw new Error(`HTTP ${response.status}: expected JSON; check Access authentication`); }
    if (!response.ok) throw Object.assign(new Error(value.error?.message ?? `HTTP ${response.status}`), { code: value.error?.code, status: response.status });
    return value;
  };
}
export function command(request, runId, type, fields = {}, operationId = crypto.randomUUID()) { return request(`/api/runs/${runId}/commands`, { type, ...fields, operationId }); }
export async function stopRun(request, runId) {
  const operationId = crypto.randomUUID(); let failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await command(request, runId, 'stop', {}, operationId); }
    catch (error) {
      if (error.code === 'RUN_NOT_FOUND') return { notCreated: true };
      failure = error; await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`STOP NOT ACKNOWLEDGED for ${runId}: ${failure?.message}`);
}
export async function save(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n'); }
export async function eventsSince(request, runId, after = 0) {
  const events = []; let before;
  while (events.length < 10000) {
    const page = await request(`/api/runs/${runId}/events?limit=100${before === undefined ? '' : `&before=${before}`}`);
    for (const event of page.events) if (event.revision > after) events.push(event);
    if (!page.nextBefore || !page.events.length || page.events.at(-1).revision <= after) break;
    before = page.nextBefore;
  }
  return events.reverse();
}
export function invariant(metrics) {
  return metrics.initialCoal === metrics.availableCoal + metrics.reservedCoal + metrics.coal
    && metrics.initialDiamonds === metrics.availableDiamonds + metrics.reservedDiamonds + metrics.diamonds
    && metrics.value === metrics.coal + metrics.diamonds * 10 && metrics.invariantFailures === 0;
}
export function halted(metrics) {
  if (!invariant(metrics)) return 'RESOURCE_INVARIANT';
  if (['quota_paused', 'capacity_paused', 'budget_paused', 'stopped'].includes(metrics.mode)) return metrics.cause ?? metrics.mode;
  if (metrics.oldestActionLatenessMs > 30000) return 'ACTION_BACKLOG';
}
export function interruption() {
  let signal;
  const handler = name => { signal = name; };
  const onInt = () => handler('SIGINT'), onTerm = () => handler('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  return { check() { if (signal) throw new Error(`Interrupted by ${signal}`); }, close() { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); } };
}

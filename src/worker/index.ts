import type { Env } from './env';
import { MAX_IN_FLIGHT, PublicError, VERSIONS, type OperatorCommand, type MeasurementExport } from '../shared/protocol';
export { Mine } from './mine';
export { Miner } from './miner';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const agent = /^(?:[1-9]\d{0,2}|1000)$/;
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
function fields(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new PublicError('INVALID_ARGUMENT', 'Unknown request field.');
}
function integer(value: unknown, min: number, max: number): value is number { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max; }
function id(value: unknown): value is string { return typeof value === 'string' && uuid.test(value); }
function numberQuery(url: URL, key: string, fallback: number | undefined, min: number, max: number): number | undefined {
  const value = url.searchParams.get(key);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !integer(Number(value), min, max)) throw new PublicError('INVALID_ARGUMENT', `Invalid ${key}.`);
  return Number(value);
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new PublicError('INVALID_ARGUMENT', 'Use application/json.');
  const reader = request.body?.getReader();
  if (!reader) throw new PublicError('INVALID_ARGUMENT', 'A JSON object is required.');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new PublicError('BODY_TOO_LARGE', 'Command bodies are limited to 8 KiB.', 400); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new PublicError('INVALID_ARGUMENT', 'Malformed JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PublicError('INVALID_ARGUMENT', 'A JSON object is required.');
  return value as Record<string, unknown>;
}
function command(value: Record<string, unknown>): OperatorCommand {
  if (!id(value.operationId)) throw new PublicError('INVALID_ARGUMENT', 'A UUID operationId is required.');
  const base = { operationId: value.operationId };
  switch (value.type) {
    case 'pause': case 'resume': case 'stop': fields(value, ['type', 'operationId']); return { ...base, type: value.type };
    case 'spawn': fields(value, ['type', 'operationId', 'count']); if (integer(value.count, 1, 1000)) return { ...base, type: 'spawn', count: value.count }; break;
    case 'retire': case 'retry_provisioning':
      fields(value, ['type', 'operationId', 'agentId']);
      if (typeof value.agentId === 'string' && agent.test(value.agentId)) return { ...base, type: value.type, agentId: value.agentId }; break;
    case 'set_quota':
      fields(value, ['type', 'operationId', 'verifiedModelRPM', 'maxInFlight']);
      if (integer(value.verifiedModelRPM, 1, 1000) && integer(value.maxInFlight, 1, MAX_IN_FLIGHT)) return { ...base, type: 'set_quota', verifiedModelRPM: value.verifiedModelRPM, maxInFlight: value.maxInFlight }; break;
  }
  throw new PublicError('INVALID_ARGUMENT', 'Invalid command.', 400, base.operationId);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url); let operationId: string | undefined;
    try {
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
      if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        if (request.headers.get('Origin') !== url.origin) throw new PublicError('ORIGIN_REJECTED', 'A matching Origin header is required.', 403);
      }
      if (url.pathname === '/api/runs' && request.method === 'POST') {
        const value = await body(request); operationId = typeof value.operationId === 'string' ? value.operationId : undefined;
        fields(value, ['runId', 'operationId', 'seed']);
        if (!id(value.runId) || !id(value.operationId) || !integer(value.seed, 0, 0xffffffff)) throw new PublicError('INVALID_ARGUMENT', 'Use run and operation UUIDs and an unsigned 32-bit seed.');
        return json(await env.MINES.getByName(`mine:${value.runId}`).initialize({ runId: value.runId, seed: value.seed }), 201);
      }
      const match = /^\/api\/runs\/([^/]+)(?:\/(commands|events|socket|metrics|export|miners\/([^/]+)\/trace))?$/.exec(url.pathname);
      if (!match || !id(match[1])) throw new PublicError('NOT_FOUND', 'Endpoint not found.', 404);
      const runId = match[1], route = match[2], minerId = match[3];
      const mine = env.MINES.getByName(`mine:${runId}`);
      if (!route && request.method === 'GET') return json(await mine.getSnapshot());
      if (route === 'commands' && request.method === 'POST') {
        const value = await body(request); operationId = typeof value.operationId === 'string' ? value.operationId : undefined;
        return json(await mine.command(command(value)));
      }
      if (request.method !== 'GET') throw new PublicError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
      if (route === 'events') return json(await mine.getEvents({ before: numberQuery(url, 'before', undefined, 0, Number.MAX_SAFE_INTEGER), limit: numberQuery(url, 'limit', 50, 1, 100)! }));
      if (route === 'socket') {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new PublicError('UPGRADE_REQUIRED', 'A WebSocket upgrade is required.', 400);
        numberQuery(url, 'after', undefined, 0, Number.MAX_SAFE_INTEGER);
        return mine.fetch(request);
      }
      if (route === 'metrics') return json(await mine.getMetrics());
      if (route?.startsWith('miners/')) {
        if (!minerId || !agent.test(minerId)) throw new PublicError('MINER_NOT_FOUND', 'Unknown miner.', 404);
        const snapshot = await mine.getSnapshot();
        if (!snapshot.miners.some(miner => miner.agentId === minerId)) throw new PublicError('MINER_NOT_FOUND', 'Unknown miner.', 404);
        const cursor = url.searchParams.get('cursor') ?? undefined;
        if (cursor && cursor.length > 256) throw new PublicError('INVALID_ARGUMENT', 'Trace cursor is too long.');
        return json(await env.MINERS.getByName(`miner:${runId}:${minerId}`).inspect({ cursor, limit: numberQuery(url, 'limit', 50, 1, 50)! }));
      }
      if (route === 'export') {
        const snapshot = await mine.getSnapshot(); const metrics = await mine.getMetrics();
        const value: MeasurementExport = { versions: VERSIONS, recordedAt: Date.now(), snapshot, metrics, limits: { allowanceMicroUSD: snapshot.run.allowanceMicroUSD, effectiveRPM: snapshot.run.effectiveRPM, verifiedModelRPM: snapshot.run.verifiedModelRPM, maxInFlight: snapshot.run.maxInFlight, maxMiners: 1000 }, history: await mine.getEvents({ limit: 100 }), caveats: ['Application-priced inference only. Worker, Durable Object, storage, network, and provider-internal executions are excluded.', 'CPU and isolate memory telemetry unavailable. Local or synthetic runs do not prove remote scale.', 'One Mine serializes shared state. The documented 1,000 requests/second soft limit is not a throughput guarantee.'] };
        return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="coal-garden-${runId}.json"` } });
      }
      throw new PublicError('NOT_FOUND', 'Endpoint not found.', 404);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'overloaded' in error && error.overloaded === true) return json({ error: { code: 'DO_OVERLOAD', message: 'Mine overloaded. Use Recover.', operationId } }, 503);
      if (error instanceof PublicError) return json({ error: { code: error.code, message: error.message.slice(error.code.length + 2), operationId: error.operationId ?? operationId } }, error.status);
      if (error instanceof Error) {
        const publicCodes: Record<string, number> = { RUN_NOT_FOUND: 404, MINER_NOT_FOUND: 404, OPERATION_CONFLICT: 409, RUN_STOPPED: 409, HISTORY_EXPIRED: 410, MINER_LIMIT: 429, ALLOWANCE_REACHED: 409, INVALID_ARGUMENT: 400, INVALID_CURSOR: 400, VIEWER_LIMIT: 429, ORIGIN_REJECTED: 403, SNAPSHOT_TOO_LARGE: 503 };
        const match = /^([A-Z_]+): ([\s\S]*)$/.exec(error.message);
        if (match && publicCodes[match[1]]) return json({ error: { code: match[1], message: match[2], operationId } }, publicCodes[match[1]]);
      }
      return json({ error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'The dependency is unavailable. Retry with the same operation ID.', operationId } }, 503);
    }
  },
};

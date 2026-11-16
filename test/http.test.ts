import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../src/worker/index';
const base = 'https://coal-garden.test';
function request(path: string, data?: unknown, origin = base): Request {
  return new Request(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
}
async function create() {
  const runId = crypto.randomUUID(), input = { runId, operationId: crypto.randomUUID(), seed: 42 };
  const response = await worker.fetch(request('/api/runs', input), env);
  expect(response.status).toBe(201);
  return { runId, input, original: await response.json() };
}
describe('same-origin operator HTTP boundary', () => {
  it('does not initialize unknown mines during a read', async () => {
    const response = await worker.fetch(request(`/api/runs/${crypto.randomUUID()}`), env);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'RUN_NOT_FOUND' } });
  });
  it('rejects cross-origin mutations before durable state exists', async () => {
    const runId = crypto.randomUUID();
    const response = await worker.fetch(request('/api/runs', { runId, operationId: crypto.randomUUID(), seed: 42 }, 'https://another.test'), env);
    expect(response.status).toBe(403);
    expect((await worker.fetch(request(`/api/runs/${runId}`), env)).status).toBe(404);
  });
  it('rejects unknown fields, oversized commands, and fractional spawn counts without creating miners', async () => {
    const { runId } = await create();
    for (const input of [
      { type: 'spawn', operationId: crypto.randomUUID(), count: 1, extra: true },
      { type: 'spawn', operationId: crypto.randomUUID(), count: 1.9 },
      { type: 'spawn', operationId: crypto.randomUUID(), count: 1, padding: 'x'.repeat(9000) },
    ]) expect((await worker.fetch(request(`/api/runs/${runId}/commands`, input), env)).status).toBe(400);
    const snapshot = await (await worker.fetch(request(`/api/runs/${runId}`), env)).json() as { miners: unknown[] };
    expect(snapshot.miners).toEqual([]);
  });
  it('replays the immutable creation result and exactly one spawn after later commands', async () => {
    const { runId, input, original } = await create();
    const spawn = { type: 'spawn', operationId: crypto.randomUUID(), count: 2 };
    const first = await (await worker.fetch(request(`/api/runs/${runId}/commands`, spawn), env)).json();
    expect(await (await worker.fetch(request(`/api/runs/${runId}/commands`, spawn), env)).json()).toEqual(first);
    const replay = await worker.fetch(request('/api/runs', input), env);
    expect(await replay.json()).toEqual(original);
    expect((await worker.fetch(request(`/api/runs/${runId}/commands`, { ...spawn, count: 3 }), env)).status).toBe(409);
    const snapshot = await (await worker.fetch(request(`/api/runs/${runId}`), env)).json() as { miners: unknown[] };
    expect(snapshot.miners).toHaveLength(2);
  });
  it('accepts 32 overlapping model calls but rejects invalid caps without changing saved limits', async () => {
    const { runId } = await create();
    const path = `/api/runs/${runId}/commands`;
    expect((await worker.fetch(request(path, { type: 'set_quota', verifiedModelRPM: 300, maxInFlight: 32, operationId: crypto.randomUUID() }), env)).status).toBe(200);
    const before = await (await worker.fetch(request(`/api/runs/${runId}`), env)).json() as { run: { revision: number } };
    for (const maxInFlight of [0, 33, 1.5]) {
      const response = await worker.fetch(request(path, { type: 'set_quota', verifiedModelRPM: 300, maxInFlight, operationId: crypto.randomUUID() }), env);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
    }
    await expect(Promise.resolve(env.MINES.getByName(`mine:${runId}`).command({ type: 'set_quota', verifiedModelRPM: 300, maxInFlight: 33, operationId: crypto.randomUUID() }))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', status: 400 });
    const after = await (await worker.fetch(request(`/api/runs/${runId}`), env)).json() as { run: object };
    expect(after.run).toMatchObject({ revision: before.run.revision, effectiveRPM: 240, maxInFlight: 32, mode: 'paused' });
  });
  it('rejects arbitrary durable RPC routes and terminal run changes', async () => {
    const { runId } = await create();
    expect((await worker.fetch(request(`/api/runs/${runId}/applyTool`, { tool: 'mine' }), env)).status).toBe(404);
    expect((await worker.fetch(request(`/api/runs/${runId}/commands`, { type: 'stop', operationId: crypto.randomUUID() }), env)).status).toBe(200);
    expect((await worker.fetch(request(`/api/runs/${runId}/commands`, { type: 'resume', operationId: crypto.randomUUID() }), env)).status).toBe(409);
  });
});

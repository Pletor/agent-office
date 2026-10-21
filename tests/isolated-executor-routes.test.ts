import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Ctx } from '../src/server/office/context.js';
import { requestHandler } from '../src/server/http/router.js';
import { createIsolatedExecutorRoutes, IsolatedExecutorRouteError, type IsolatedOfficeAccess } from '../src/server/http/routes/isolated-executors.js';

test('isolated executor HTTP boundary is explicit, admin-only for writes, floor-pinned and sanitized', async t => {
  const floor = {};
  const floors = new Map<string, object>([['floor-a', floor]]);
  const ctx = {
    cfg: { port: 0, trustProxy: false }, floors, services: { lookup: () => undefined },
    auth: { fromAnyCookie: () => undefined, fromRequest: (req: http.IncomingMessage) => req.headers['x-test-session'] === 'admin' ? { account: { role: 'admin' } } : req.headers['x-test-session'] === 'guest-admin' ? {} : req.headers['x-test-session'] === 'member' ? { account: { role: 'member' } } : undefined },
  } as unknown as Ctx;
  let calls: string[] = [];
  let resolves = 0;
  let startGate: (() => void) | undefined;
  let holdStart = false;
  const access: IsolatedOfficeAccess = {
    capabilities: async () => { calls.push('capabilities'); return { available: false }; },
    status: async () => { calls.push('status'); return { runs: [] }; },
    start: async input => { calls.push('start'); if (holdStart) await new Promise<void>(resolve => { startGate = resolve; }); return { requestId: input.requestId }; },
    stop: async input => { calls.push(`stop:${input.intentId}`); return { stopped: true }; },
    reconcile: async () => { calls.push('reconcile'); return { reconciled: true }; },
  };
  const routes = createIsolatedExecutorRoutes((_ctx, selected) => { resolves++; assert.equal(selected, floor); return access; });
  const server = http.createServer(requestHandler(ctx, routes));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx.cfg.port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(() => { server.close(); server.closeAllConnections(); });
  const call = (path: string, method = 'GET', session = 'admin', body?: unknown, origin = base) => fetch(`${base}${path}`, {
    method, headers: { 'x-test-session': session, origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const root = '/api/opora/isolated-executors';
  const floorQuery = '?floor=floor-a';

  assert.equal((await call(`${root}/runs${floorQuery}`, 'GET', '')).status, 401);
  assert.equal((await call(`${root}/start${floorQuery}`, 'POST', 'member', { executorId: 'anthropic-managed-agents', cardId: 'card', requestId: 'req' })).status, 403);
  assert.equal((await call(`${root}/start${floorQuery}`, 'POST', 'admin', { executorId: 'anthropic-managed-agents', cardId: 'card', requestId: 'req' }, 'https://evil.example')).status, 403);
  assert.deepEqual(calls, []);

  assert.equal((await call(`${root}/start${floorQuery}`, 'POST', 'admin', { cardId: 'card', requestId: 'req' })).status, 400, 'no implicit executor');
  assert.equal((await call(`${root}/start${floorQuery}`, 'POST', 'admin', { executorId: 'other', cardId: 'card', requestId: 'req' })).status, 400);
  assert.equal((await call(`${root}/start${floorQuery}`, 'POST', 'admin', { executorId: 'anthropic-managed-agents', cardId: 'card', requestId: 'req', providerUrl: 'https://attacker' })).status, 400, 'unknown keys rejected');
  assert.equal((await call(`${root}/start${floorQuery}`, 'POST', 'admin', { executorId: 'anthropic-managed-agents', cardId: 'bad.card', requestId: 'req' })).status, 400, 'card ids follow Canvas syntax');
  assert.equal((await call(`${root}/stop${floorQuery}`, 'POST', 'admin', { intentId: 'intent-1' })).status, 400, 'stop requires a canonical intent id');
  assert.equal((await call(`${root}/reconcile${floorQuery}`, 'POST', 'admin', { confirm: true })).status, 400);
  assert.deepEqual(calls, []);
  assert.equal(resolves, 0, 'invalid requests never resolve an executor service');

  const tooLarge = await fetch(`${base}${root}/reconcile${floorQuery}`, { method: 'POST', headers: { 'x-test-session': 'admin', origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(16 * 1024) }) });
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(calls, []);
  assert.equal(resolves, 0, 'oversized bodies never resolve an executor service');

  assert.equal((await call(`${root}/reconcile${floorQuery}`, 'POST', 'guest-admin', {})).status, 200, 'shared-password sessions retain existing admin semantics');

  assert.equal((await call(`${root}/capabilities${floorQuery}`)).status, 200);
  assert.equal((await call(`${root}/runs${floorQuery}`)).status, 200);
  assert.equal((await call(`${root}/start${floorQuery}`, 'POST', 'admin', { executorId: 'anthropic-managed-agents', cardId: '_card-1', requestId: 'request-1' })).status, 200);
  assert.equal((await call(`${root}/stop${floorQuery}`, 'POST', 'admin', { intentId: 'a'.repeat(40) })).status, 200);
  assert.equal((await call(`${root}/reconcile${floorQuery}`, 'POST', 'admin', {})).status, 200);
  assert.deepEqual(calls, ['reconcile', 'capabilities', 'status', 'start', `stop:${'a'.repeat(40)}`, 'reconcile']);
  assert.equal((await call(`${root}/runs${floorQuery}`, 'DELETE')).status, 405);

  holdStart = true;
  const started = call(`${root}/start${floorQuery}`, 'POST', 'admin', { executorId: 'anthropic-managed-agents', cardId: 'card_2', requestId: 'request-2' });
  while (!startGate) await new Promise(resolve => setImmediate(resolve));
  floors.delete('floor-a');
  startGate();
  assert.equal((await started).status, 404, 'a removed floor cannot complete its pending route response');
});

test('isolated executor errors expose only conflict or generic unavailable', async t => {
  const floor = {};
  const ctx = {
    cfg: { port: 0, trustProxy: false }, floors: new Map([['f', floor]]), services: { lookup: () => undefined },
    auth: { fromAnyCookie: () => undefined, fromRequest: () => ({ account: { role: 'admin' } }) },
  } as unknown as Ctx;
  const access: IsolatedOfficeAccess = {
    capabilities: async () => { throw new IsolatedExecutorRouteError('conflict'); },
    status: async () => { throw new Error('provider token=secret'); },
    start: async () => ({}), stop: async () => ({}), reconcile: async () => ({}),
  };
  const server = http.createServer(requestHandler(ctx, createIsolatedExecutorRoutes(() => access)));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx.cfg.port = (server.address() as { port: number }).port;
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { 'x-test-session': 'admin' };
  const conflict = await fetch(`${base}/api/opora/isolated-executors/capabilities?floor=f`, { headers });
  assert.equal(conflict.status, 409);
  assert.doesNotMatch(await conflict.text(), /secret|provider/);
  const unavailable = await fetch(`${base}/api/opora/isolated-executors/runs?floor=f`, { headers });
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(await unavailable.text(), /secret|provider/);
});

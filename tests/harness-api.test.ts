import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Ctx } from '../src/server/office/context.js';
import { requestHandler } from '../src/server/http/router.js';
import { harnessProfileRoute, harnessRoute } from '../src/server/http/routes/harness.js';
import { officeHarness } from '../src/server/harness/api.js';

test('profile HTTP and hook API enforce session, origin, admin, planner and revision boundaries', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-api-'));
  const floor = {
    dir, opora: { view: () => ({ cards: [] }) },
    workers: { authenticate: (id: string, token: string) => token === 'test-token' ? { id } : undefined },
    planning: { state: () => ({ current: { workerId: 'planner', mode: 'opora', owner: 'admin' } }) },
  };
  const ctx = {
    cfg: { dataDir: dir, port: 0 }, floors: new Map([['floor', floor]]),
    accounts: { get: (id: string) => ({ role: id === 'admin' ? 'admin' : 'member' }) },
    auth: { fromRequest: (req: http.IncomingMessage) => req.headers['x-test-session'] === 'admin' ? {} : req.headers['x-test-session'] === 'member' ? { account: { role: 'member' } } : undefined },
    workerFloor: () => floor,
  } as unknown as Ctx;
  const handler = requestHandler(ctx, [harnessProfileRoute, harnessRoute]);
  const server = http.createServer((req, res) => req.url?.startsWith('/office/') ? void officeHarness(ctx, req, res, new URL(req.url, 'http://x')) : void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  ctx.cfg.port = (server.address() as { port: number }).port;
  t.after(() => { server.close(); server.closeAllConnections(); rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const api = '/api/harness/profile?floor=floor';
  const data = { scope: 'global', layer: { language: { value: 'cs' } }, revision: 0 };
  const call = (url: string, session = '', body?: unknown, origin = base, auth = '') => fetch(base + url, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-test-session': session, origin, authorization: auth, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await call(api)).status, 401);
  assert.equal((await call(api, 'member', data)).status, 403);
  assert.equal((await call(api, 'admin', data, 'https://evil.example')).status, 403);
  assert.equal((await call(api, 'admin', data)).status, 200);
  assert.equal((await call(api, 'admin', data)).status, 409);
  assert.equal((await call('/api/harness/profile?floor=other', 'admin')).status, 404);
  assert.equal((await call('/office/harness?worker=planner')).status, 401);
  assert.equal((await call('/office/harness?worker=ordinary', '', { ...data, scope: 'repository', revision: 1 }, base, 'Bearer test-token')).status, 403);
  assert.equal((await call('/office/harness?worker=planner', '', { ...data, revision: 1 }, base, 'Bearer test-token')).status, 403);
  const saved = await call('/office/harness?worker=planner&task=one', '', { ...data, scope: 'task', revision: 1 }, base, 'Bearer test-token');
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).effective.language.scope, 'task');
  assert.equal((await call(api, 'admin', { ...data, layer: { rule: { resource: 'missing' } }, revision: 2 })).status, 400);
  // A resource that was listed and then removed is refused as missing (tombstone), not as unknown, and is never remapped.
  mkdirSync(path.join(dir, '.harness', 'rules'), { recursive: true });
  writeFileSync(path.join(dir, '.harness', 'rules', 'review.md'), 'review');
  const listed = await (await call('/api/harness?floor=floor', 'admin')).json() as { entries: { id: string; path: string; version: number }[] };
  const review = listed.entries.find((e) => e.path === 'rules/review.md')!;
  assert.equal(review.version, 1);
  assert.equal((await call(api, 'admin', { ...data, layer: { rule: { resource: review.id } }, revision: 2 })).status, 200);
  rmSync(path.join(dir, '.harness', 'rules', 'review.md'));
  const refused = await call(api, 'admin', { ...data, layer: { rule: { resource: review.id } }, revision: 3 });
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { error: string }).error, /missing since .*rules\/review\.md/);
});

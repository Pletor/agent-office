import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Ctx } from '../src/server/office/context.js';
import { requestHandler } from '../src/server/http/router.js';
import { harnessProfileRoute } from '../src/server/http/routes/harness.js';
import { officeHarness } from '../src/server/harness/api.js';
import { oporaKey } from '../src/shared/opora-identity.js';

test('profile HTTP and hook API enforce session, origin, admin, planner and revision boundaries', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-api-'));
  // A canvas like the Harness plan: a page, a layer, an area beside the sector, and two cards in it.
  const nodes = [
    { id: 'root', kind: 'sector', name: 'Shop', parentId: null }, { id: 'page', kind: 'node', name: 'Page', parentId: 'root' }, { id: 'layer', kind: 'node', name: 'Layer', parentId: 'page' },
    { id: 'area', kind: 'area', name: 'Area', parentId: 'layer' }, { id: 'sector', kind: 'sector', name: 'Sector', parentId: 'layer', memberOf: 'area' },
    { id: 'c1', kind: 'node', name: 'Card 1', parentId: 'sector' }, { id: 'c2', kind: 'node', name: 'Card 2', parentId: 'sector' },
  ];
  const place = { project: 'p', workspace: 'w' };
  const k = (id: string) => oporaKey(place, id);
  const floor = {
    dir, opora: { view: () => ({ project: { id: 'p', name: 'P' }, workspace: 'w', cards: [{ id: 'c1', name: 'Card 1' }] }), canvasNodes: () => nodes },
    workers: { authenticate: (id: string, token: string) => token === 'test-token' ? { id } : undefined },
    planning: { state: () => ({ current: { workerId: 'planner', mode: 'opora', owner: 'admin' } }) },
  };
  const ctx = {
    cfg: { dataDir: dir, port: 0 }, floors: new Map([['floor', floor]]),
    accounts: { get: (id: string) => ({ role: id === 'admin' ? 'admin' : 'member' }) },
    auth: { fromRequest: (req: http.IncomingMessage) => req.headers['x-test-session'] === 'admin' ? { account: { id: 'admin', role: 'admin' } } : req.headers['x-test-session'] === 'member' ? { account: { role: 'member' } } : undefined },
    workerFloor: () => floor,
  } as unknown as Ctx;
  const handler = requestHandler(ctx, [harnessProfileRoute]);
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
  // Down the hierarchy: a card's key is placed on the canvas, its sector's layer reaches it and its sibling, with provenance and audit.
  const card = await call(api + '&node=' + encodeURIComponent(k('c1')), 'admin');
  assert.equal(card.status, 200);
  const view = await card.json();
  assert.deepEqual(view.path.map((p: { level: string }) => p.level), ['page', 'layer', 'area', 'sector', 'task']);
  assert.deepEqual(view.levels, ['global', 'project', 'page', 'layer', 'area', 'sector', 'task']);
  assert.deepEqual(view.tasks, [{ id: k('c1'), title: 'Card 1' }]);
  assert.equal((await call(api + '&node=' + encodeURIComponent(k('c1')), 'admin', { scope: 'sector', layer: { tone: { value: 'terse' } }, revision: 2 })).status, 200);
  const sibling = await (await call(api + '&task=' + encodeURIComponent(k('c2')), 'admin')).json();
  assert.deepEqual(sibling.effective.tone, { binding: { value: 'terse' }, scope: 'sector', node: k('sector') });
  assert.deepEqual(sibling.layers.task, {});
  assert.equal(sibling.audit[0].level, 'sector');
  assert.equal(sibling.audit[0].by, 'account:admin');
  assert.equal(sibling.audit[0].node, k('sector'));
  assert.equal(sibling.revision, 3);
  // A worker's save goes into the audit as the worker; a stale revision is refused; a foreign key never resolves.
  assert.equal((await call('/office/harness?worker=planner&node=' + encodeURIComponent(k('c2')), '', { scope: 'task', layer: { tone: { value: 'warm' } }, revision: 2 }, base, 'Bearer test-token')).status, 409);
  const mine = await call('/office/harness?worker=planner&node=' + encodeURIComponent(k('c2')), '', { scope: 'task', layer: { tone: { value: 'warm' } }, revision: 3 }, base, 'Bearer test-token');
  assert.equal(mine.status, 200);
  const after = await mine.json();
  assert.equal(after.effective.tone.scope, 'task');
  assert.equal(after.audit[0].by, 'worker:planner');
  assert.equal((await call(api + '&node=' + encodeURIComponent(oporaKey({ project: 'other', workspace: 'w' }, 'c1')), 'admin')).status, 400);
  assert.equal((await call(api + '&node=' + encodeURIComponent(k('c1')), 'admin', { scope: 'floor', layer: {}, revision: 4 })).status, 400);
  assert.equal((await call(api + '&task=custom', 'admin', { scope: 'sector', layer: {}, revision: 4 })).status, 400, 'a custom task has no sector above it');
});

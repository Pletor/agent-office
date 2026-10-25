import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Ctx } from '../src/server/office/context.js';
import { requestHandler } from '../src/server/http/router.js';
import { harnessHierarchyRoute } from '../src/server/http/routes/harness-hierarchy.js';
import { officeHarness } from '../src/server/harness/api.js';
import { harnessHandoff } from '../src/server/harness/handoff.js';
import { hierarchyAbout } from '../src/server/harness/hierarchy-context.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('bound hierarchy HTTP selects real scopes, fences moves, isolates projects and reaches worker handoff', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-navigation-'));
  const n = (id: string, kind: string, parentId: string | null) => ({ id, kind, parentId, name: id, x: 0, y: 0 });
  const nodes = [n('domain', 'sector', null), n('page', 'node', 'domain'), n('layer', 'node', 'page'),
    { ...n('area', 'area', 'layer'), size: { w: 800, h: 600 } }, { ...n('sector', 'sector', 'layer'), memberOf: 'area' as string | undefined }, n('card', 'node', 'sector')];
  let historyMode = 'valid';
  const canvas = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://local');
    if (url.pathname === '/api/oporahub/harness-origin-history') {
      assert.equal(req.headers.authorization, undefined);
      assert.equal(url.searchParams.get('project'), 'p'); assert.equal(url.searchParams.get('workspace'), 'w');
      if (historyMode === 'missing') { res.writeHead(404); res.end(); return; }
      if (historyMode === 'oversized') { res.end('x'.repeat(256 * 1024 + 1)); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ schema: 'harness.origin-history/1', scope: { project: historyMode === 'foreign' ? 'foreign' : 'p', workspace: 'w', nodeId: null },
        window: { kind: 'newest-enrolled-executions', limit: 100, examined: 0, excluded: 0 },
        limited: false, omittedCohortContributions: 0, cohorts: [], promotionAllowed: false, causalContribution: false, invocationObserved: false })); return;
    }
    assert.equal(url.pathname, '/api/view'); assert.equal(url.searchParams.get('project'), 'p'); assert.equal(url.searchParams.get('workspace'), 'w');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ graph: { nodes } }));
  });
  await new Promise<void>(resolve => canvas.listen(0, '127.0.0.1', resolve));
  const canvasUrl = 'http://127.0.0.1:' + (canvas.address() as { port: number }).port;
  const linked = { connected: true, url: canvasUrl, project: { id: 'p', name: 'Project' }, workspace: 'w', cards: [] };
  const floor = { id: 'floor', dir, info: () => ({ name: 'Floor' }), opora: { view: () => linked },
    workers: { authenticate: (id: string, token: string) => token === 'test-token' ? { id } : undefined },
    planning: { state: () => ({ current: { workerId: 'planner', mode: 'opora', owner: 'admin' } }) } };
  const ctx = { cfg: { dataDir: dir, port: 0 }, floors: new Map([['floor', floor]]), workerFloor: () => floor,
    accounts: { get: () => ({ role: 'admin' }) }, auth: { fromRequest: (req: http.IncomingMessage) => {
      const role = req.headers['x-test-session']; return role === 'admin' ? {} : role === 'member' ? { account: { role: 'member' } } : undefined;
    } } } as unknown as Ctx;
  const handler = requestHandler(ctx, [harnessHierarchyRoute]);
  const server = http.createServer((req, res) => req.url?.startsWith('/office/') ? void officeHarness(ctx, req, res, new URL(req.url, 'http://x')) : void handler(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx.cfg.port = (server.address() as { port: number }).port;
  t.after(() => { for (const instance of [server, canvas]) { instance.close(); instance.closeAllConnections(); } rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + ctx.cfg.port;
  const call = (query = '', body?: unknown, role = 'admin', origin = base) => fetch(base + '/api/harness/hierarchy?floor=floor' + query, {
    method: body ? 'POST' : 'GET', headers: { 'x-test-session': role, origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await call('', undefined, '')).status, 401);
  const binding = { op: 'bind', project: 'p', workspace: 'w', revision: 0 };
  assert.equal((await call('', binding, 'member')).status, 403);
  assert.equal((await call('', binding, 'admin', 'https://evil.example')).status, 403);
  assert.equal((await call('', { ...binding, project: 'foreign' })).status, 409);
  let response = await call('', binding); assert.equal(response.status, 200);
  let view = await response.json(); assert.equal(view.choices.length, 5);
  const area = '&node=opora:p:w:area';
  response = await call(area); view = await response.json(); assert.equal(view.level, 'area');
  response = await call(area + '&origin-history=1');
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).schema, 'harness.origin-history/1');
  const cli = await promisify(execFile)(process.execPath, ['bin/office-harness.js', '--origin-history', 'area', '--task', 'opora:p:w:area'],
    { env: { ...process.env, AGENT_OFFICE_HOOK_URL: base, AGENT_OFFICE_WORKER_ID: 'ordinary', AGENT_OFFICE_HOOK_TOKEN: 'test-token' } });
  assert.equal(JSON.parse(cli.stdout).schema, 'harness.origin-history/1');
  for (const mode of ['missing', 'foreign', 'oversized']) { historyMode = mode; assert.equal((await call(area + '&origin-history=1')).status, 503); }
  historyMode = 'valid';
  assert.equal((await call(area + '&origin-history=1', { op: 'save' })).status, 405);
  const save = { op: 'save', scope: 'area', revision: view.revision, pathDigest: view.pathDigest, layer: { quality: { resource: 'guide:testing' } } };
  assert.equal((await call(area, save)).status, 200);
  assert.equal((await call(area, save)).status, 409);
  response = await call('&node=opora:p:w:card'); view = await response.json();
  assert.equal(view.effective.quality.scope, 'area');
  assert.match(await harnessHandoff(dir, dir, 'opora:p:w:card', false), /guide:testing/);
  assert.equal((await call('&node=opora:foreign:w:card')).status, 403);
  assert.equal((await call('&node=opora:p:w:missing')).status, 404);
  assert.equal((await call('&scope=typo')).status, 400);
  assert.equal((await call('&node=opora:p:w:card&scope=area')).status, 400);
  // Layout is presentation; explicit membership alone changes inherited equipment.
  nodes.find(node => node.id === 'sector')!.x = 2000;
  const moved = await (await call('&node=opora:p:w:card')).json();
  assert.equal(moved.pathDigest, view.pathDigest);
  assert.equal(moved.effective.quality.scope, 'area');
  assert.match(await harnessHandoff(dir, dir, 'opora:p:w:card', false), /guide:testing/);
  delete nodes.find(node => node.id === 'sector')!.memberOf;
  assert.equal((await call('&node=opora:p:w:card', { ...save, scope: 'task', revision: view.revision, pathDigest: view.pathDigest })).status, 409);
  assert.doesNotMatch(await harnessHandoff(dir, dir, 'opora:p:w:card', false), /guide:testing/);
  const hook = '/office/harness?worker=ordinary&hierarchy=1&node=opora:p:w:card';
  response = await fetch(base + hook, { headers: { authorization: 'Bearer test-token' } });
  assert.equal(response.status, 200); assert.equal((await response.json()).writable, false);
  assert.equal((await fetch(base + hook, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify(save) })).status, 403);
  linked.project = { id: 'foreign', name: 'Foreign' };
  assert.equal((await call('&node=opora:p:w:card')).status, 503);
  assert.equal((await call('')).status, 200, 'project defaults remain editable during link drift');
});

test('an unbound floor says when Opora is unreachable instead of asking to connect it', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-offline-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const floor = (connected: boolean) => ({ id: 'floor', opora: { view: () => ({ connected, url: 'http://127.0.0.1:1', project: null, workspace: null }) } }) as any;
  assert.match(hierarchyAbout(dir, floor(false)).notice, /^Opora není dostupná, patro proto zatím nelze připojit/);
  assert.match(hierarchyAbout(dir, floor(true)).notice, /^Připojte patro k projektu Opory/);
  const open = { id: 'floor', opora: { view: () => ({ connected: true, url: 'http://127.0.0.1:1', project: { id: 'p1', name: 'Ample' }, workspace: 'draft' }) } } as any;
  assert.match(hierarchyAbout(dir, open).notice, /tlačítkem „Připojit otevřenou Oporu“ \(okno Opory je teď v projektu „Ample“\); teprve potom se zobrazí Stránka až Karta/);
  assert.equal(hierarchyAbout(dir, open).binding, undefined, 'an open Opora window never binds the floor by itself');
});

import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Ctx } from '../src/server/office/context.js';
import { requestHandler } from '../src/server/http/router.js';
import { officeHarness } from '../src/server/harness/api.js';
import { harnessHandoff } from '../src/server/harness/handoff.js';

const required = ['http/routes/harness-hierarchy.ts', 'harness/recommend.ts', 'harness/runner-probe-api.ts', 'harness/native-paired.ts', 'harness/native-verifier.ts'];
const missing = required.filter(file => !existsSync(new URL('../src/server/' + file, import.meta.url)));

test('composed Harness: inherited choices, authenticated CLI and explicit membership', {
  skip: missing.length ? 'Composition modules not installed: ' + missing.join(', ') : false,
}, async t => {
  // Dynamic import keeps the test runnable on main before the independent feature PRs land.
  const hierarchyModule = '../src/server/http/routes/harness-hierarchy.js';
  const { harnessHierarchyRoute } = await import(hierarchyModule);
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-navigation-'));
  const n = (id: string, kind: string, parentId: string | null, memberOf?: string) => ({ id, kind, parentId, ...(memberOf ? { memberOf } : {}), name: id, x: 0, y: 0 });
  const nodes = [n('domain', 'sector', null), n('page', 'node', 'domain'), n('layer', 'node', 'page'),
    { ...n('area', 'area', 'layer'), size: { w: 800, h: 600 } }, n('sector', 'sector', 'layer', 'area'), n('card', 'node', 'sector')];
  const optionalReads = new Set<string>();
  const optionalPaths = ['/api/oporahub/harness-paired-evaluations', '/api/oporahub/harness-verifier/requests'];
  const canvas = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://local');
    if (url.pathname === '/api/oporahub/harness-learning') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ schema: 'harness.learning/1', authority: 'native-outbox-projection', scope: { project: 'p', workspace: 'w', nodeId: null }, limited: false, cohorts: [] })); return; }
    if (optionalPaths.includes(url.pathname)) {
      optionalReads.add(url.pathname); res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Optional verifier not installed' })); return;
    }
    assert.equal(url.pathname, '/api/view'); assert.equal(url.searchParams.get('project'), 'p'); assert.equal(url.searchParams.get('workspace'), 'w');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ graph: { nodes } }));
  });
  await new Promise<void>(resolve => canvas.listen(0, '127.0.0.1', resolve));
  const canvasUrl = 'http://127.0.0.1:' + (canvas.address() as { port: number }).port;
  const linked = { connected: true, url: canvasUrl, project: { id: 'p', name: 'Project' }, workspace: 'w', cards: [] };
  const floor = { id: 'floor', dir, info: () => ({ name: 'Floor' }), opora: { view: () => linked },
    workers: { authenticate: (id: string, token: string) => token === 'test-token' ? { id, provider: 'custom' } : undefined },
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
  const save = { op: 'save', scope: 'area', revision: view.revision, pathDigest: view.pathDigest, layer: { quality: { resource: 'guide:testing' } } };
  assert.equal((await call(area, save)).status, 200);
  assert.equal((await call(area, save)).status, 409);
  response = await call('&node=opora:p:w:card'); view = await response.json();
  assert.equal(view.effective.quality.scope, 'area');
  assert.match(await harnessHandoff(dir, dir, 'opora:p:w:card', false), /guide:testing/);
  const cli = async (...args: string[]) => (await promisify(execFile)(process.execPath, ['bin/office-harness.js', ...args], {
    cwd: process.cwd(), env: { ...process.env, AGENT_OFFICE_HOOK_URL: base, AGENT_OFFICE_WORKER_ID: 'ordinary', AGENT_OFFICE_HOOK_TOKEN: 'test-token' }, timeout: 30_000,
  })).stdout;
  const recommendation = JSON.parse(await cli('--recommend', 'ts.references', '--task', 'opora:p:w:card'));
  const capabilities = JSON.parse(await cli('--probe'));
  assert.equal(capabilities.runner, 'custom'); assert.equal(capabilities.workerEnvironmentAttested, false);
  assert.deepEqual(capabilities.availableRequirements, []);
  assert.equal(recommendation.history.status, 'available');
  assert.deepEqual([...optionalReads].sort(), [...optionalPaths].sort());
  assert.equal(recommendation.pairedHistory.status, 'unavailable');
  assert.equal(recommendation.fixtureHistory.status, 'unavailable');
  assert.equal(recommendation.fixtureHistory.budget.status, 'unavailable');
  assert.equal(recommendation.promotionAllowed, false);
  assert.ok(recommendation.kit.resources.some((resource: { resource: string }) => resource.resource === 'guide:testing'));
  assert.equal(recommendation.context.pathDigest, view.pathDigest);
  const search = JSON.parse(await cli('--search', 'testing', '--category', 'testing'));
  assert.ok(search.entries.some((entry: { id: string }) => entry.id === 'guide:testing'));
  assert.match(await cli('--read', 'guide:testing'), /test/i);
  const bundle = await cli('--bundle', 'guide:testing');
  assert.match(bundle, /SHA-256 [a-f0-9]{64}/);
  assert.match(bundle, /guide:testing/);
  await assert.rejects(cli('--read', 'private-machine-resource'), /unavailable/);

  assert.equal((await call('&node=opora:foreign:w:card')).status, 403);
  assert.equal((await call('&node=opora:p:w:missing')).status, 404);
  assert.equal((await call('&scope=typo')).status, 400);
  assert.equal((await call('&node=opora:p:w:card&scope=area')).status, 400);
  // Moving a sector visually must not change its explicit membership or inherited kit.
  nodes.find(node => node.id === 'sector')!.x = 2000;
  const repositioned = await (await call('&node=opora:p:w:card')).json();
  assert.equal(repositioned.pathDigest, view.pathDigest);
  assert.equal(repositioned.effective.quality.scope, 'area');
  assert.match(await harnessHandoff(dir, dir, 'opora:p:w:card', false), /guide:testing/);
  const unchanged = JSON.parse(await cli('--recommend', 'ts.references', '--task', 'opora:p:w:card'));
  assert.equal(unchanged.context.pathDigest, recommendation.context.pathDigest);
  assert.ok(unchanged.kit.resources.some((resource: { resource: string }) => resource.resource === 'guide:testing'));
  // Explicit removal changes ownership even though geometry and parent IDs stay unchanged.
  delete nodes.find(node => node.id === 'sector')!.memberOf;
  assert.equal((await call('&node=opora:p:w:card', { ...save, scope: 'task', revision: view.revision, pathDigest: view.pathDigest })).status, 409);
  assert.doesNotMatch(await harnessHandoff(dir, dir, 'opora:p:w:card', false), /guide:testing/);
  const moved = JSON.parse(await cli('--recommend', 'ts.references', '--task', 'opora:p:w:card'));
  assert.notEqual(moved.context.pathDigest, recommendation.context.pathDigest);
  assert.ok(!moved.selections?.some((item: { reason: string }) => item.reason === 'explicit:quality'));

  const hook = '/office/harness?worker=ordinary&hierarchy=1&node=opora:p:w:card';
  response = await fetch(base + hook, { headers: { authorization: 'Bearer test-token' } });
  assert.equal(response.status, 200); assert.equal((await response.json()).writable, false);
  assert.equal((await fetch(base + hook, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify(save) })).status, 403);
  linked.project = { id: 'foreign', name: 'Foreign' };
  assert.equal((await call('&node=opora:p:w:card')).status, 503);
  assert.equal((await call('')).status, 200, 'project defaults remain editable during link drift');
});

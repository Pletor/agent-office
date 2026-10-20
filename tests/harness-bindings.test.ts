// The floor ↔ Opora project bindings and the orchestrator contract (docs/harness.md "Project bindings
// and orchestrator contract"): the store, the authorization matrix of both endpoints, safe retries
// (requestId), CAS, an unknown node, Opora down, rebinding, a restart and the dispatch gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Ctx } from '../src/server/office/context.js';
import { requestHandler } from '../src/server/http/router.js';
import { harnessBindingRoute, harnessProfileRoute } from '../src/server/http/routes/harness.js';
import { officeHarness } from '../src/server/harness/api.js';
import { officeHarnessBinding, checkBindTarget } from '../src/server/harness/binding-api.js';
import { HarnessBindings, assertBoundWrite } from '../src/server/harness/bindings.js';
import { HarnessRequests, requestDigest } from '../src/server/harness/requests.js';
import { HarnessProfiles, harnessRepoKey } from '../src/server/harness/profiles.js';
import { withFileLock } from '../src/server/harness/lock.js';
import { harnessCardHandoff } from '../src/server/harness/handoff.js';
import { oporaKey } from '../src/shared/opora-identity.js';
import { remoteHarness } from '../bin/harness-remote.js';

const place = { project: 'p', workspace: 'w' };
const k = (id: string) => oporaKey(place, id);

/** An office with three floors: A (bound, admin-owned planner), B (another checkout, no plan), C (a planner a member owns). */
function office(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-bind-'));
  const dirB = mkdtempSync(path.join(tmpdir(), 'harness-bind-b-'));
  const dirC = mkdtempSync(path.join(tmpdir(), 'harness-bind-c-'));
  const nodes = [
    { id: 'root', kind: 'sector', name: 'Shop', parentId: null }, { id: 'page', kind: 'node', name: 'Page', parentId: 'root' },
    { id: 'sector', kind: 'sector', name: 'Sector', parentId: 'page' }, { id: 'c1', kind: 'node', name: 'Card 1', parentId: 'sector' },
  ];
  /** Opora as floor A's window reads it; the tests take it down and drift it. */
  const opora: { connected: boolean; error?: string; project: { id: string; name: string } | null; workspace: string | null } = { connected: true, project: { id: 'p', name: 'P' }, workspace: 'w' };
  const workers = { authenticate: (id: string, token: string) => (token === 'tok-' + id ? { id } : undefined) };
  const floor = { id: 'a', dir, opora: { view: () => ({ ...opora, cards: [{ id: 'c1', name: 'Card 1' }] }), canvasNodes: () => nodes }, workers, planning: { state: () => ({ current: { workerId: 'planner', mode: 'opora', owner: 'admin' } }) } };
  const floorB = { id: 'b', dir: dirB, opora: { view: () => ({ connected: true, project: { id: 'pb', name: 'PB' }, workspace: 'w', cards: [] }), canvasNodes: () => [] }, workers, planning: { state: () => ({ current: undefined }) } };
  const floorC = { id: 'c', dir: dirC, opora: { view: () => ({ connected: true, project: { id: 'pc', name: 'PC' }, workspace: 'w', cards: [] }), canvasNodes: () => [] }, workers, planning: { state: () => ({ current: { workerId: 'mplanner', mode: 'router', owner: 'member' } }) } };
  const byWorker: Record<string, unknown> = { planner: floor, ordinary: floor, 'worker-b': floorB, mplanner: floorC };
  const ctx = {
    cfg: { dataDir: dir, port: 0 }, floors: new Map([['a', floor], ['b', floorB], ['c', floorC]]),
    accounts: { get: (id: string) => ({ role: id === 'admin' || id.startsWith('admin-') ? 'admin' : 'member' }) },
    auth: { fromRequest: (req: http.IncomingMessage) => {
      const s = req.headers['x-test-session'];
      return s === 'admin' || s?.startsWith('admin-') ? { account: { id: String(s), role: 'admin' } } : s === 'member' ? { account: { id: 'mia', role: 'member' } } : s === 'shared' ? {} : undefined;
    } },
    workerFloor: (id: string) => byWorker[id],
  } as unknown as Ctx;
  const handler = requestHandler(ctx, [harnessProfileRoute, harnessBindingRoute]);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/office/harness/binding') return void officeHarnessBinding(ctx, req, res, url);
    if (url.pathname === '/office/harness') return void officeHarness(ctx, req, res, url);
    return void handler(req, res);
  });
  return new Promise<{ base: string; dir: string; dirB: string; opora: typeof opora; call: (url: string, session?: string, body?: unknown, origin?: string, auth?: string) => Promise<Response> }>((resolve) => server.listen(0, '127.0.0.1', () => {
    ctx.cfg.port = (server.address() as { port: number }).port;
    const base = 'http://127.0.0.1:' + ctx.cfg.port;
    t.after(() => { server.close(); server.closeAllConnections(); for (const d of [dir, dirB, dirC]) rmSync(d, { recursive: true, force: true }); });
    const call = (url: string, session = '', body?: unknown, origin = base, auth = '') => fetch(base + url, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-test-session': session, origin, authorization: auth, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    resolve({ base, dir, dirB, opora, call });
  }));
}

test('the binding store: one project and workspace per floor, explicit audited rebinding, CAS, a restart', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-bind-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = path.join(dir, 'repo');
  const store = new HarnessBindings(dir);
  assert.equal(store.forFloor('a'), undefined);
  const first = await store.bind('a', checkout, place, 'account:admin');
  assert.equal(first.changed, true);
  assert.equal(first.revision, 1);
  assert.deepEqual(Object.keys(first.binding).sort(), ['boundAt', 'boundBy', 'checkoutPath', 'floorId', 'project', 'repoHash', 'workspace']);
  assert.equal(first.binding.repoHash, harnessRepoKey(checkout), 'the same key the profile store files the checkout under');
  // The same place again is nothing: no write, no audit entry, same revision.
  const same = await store.bind('a', checkout, place, 'account:other');
  assert.equal(same.changed, false);
  assert.equal(same.revision, 1);
  assert.equal(same.binding.boundBy, 'account:admin');
  assert.equal(store.audit().length, 1);
  // Another place is a rebind, which must be asked for; a stale revision is a conflict; names are not ids.
  await assert.rejects(() => store.bind('a', checkout, { project: 'q', workspace: 'w' }, 'account:admin'), (e: Error & { status: number }) => e.status === 409 && /Rebinding is explicit/.test(e.message));
  await assert.rejects(() => store.bind('a', checkout, { project: 'q', workspace: 'w' }, 'account:admin', { rebind: true, revision: 0 }), (e: Error & { status: number }) => e.status === 409 && /changed elsewhere/.test(e.message));
  // Another floor on the same checkout shares the place: it can't be bound elsewhere.
  await assert.rejects(() => store.bind('a2', checkout, { project: 'q', workspace: 'w' }, 'account:admin'), (e: Error & { status: number }) => e.status === 409 && /Floor a has the same checkout bound/.test(e.message));
  assert.equal((await store.bind('a2', checkout, place, 'account:admin')).changed, true);
  // A rebind moves every floor on the checkout together, each with its own audit entry.
  const moved = await store.bind('a', checkout, { project: 'q', workspace: 'w2' }, 'worker:planner', { rebind: true, revision: 2 });
  assert.equal(store.forFloor('a2')?.project, 'q', 'the other floor on the checkout moved with it');
  assert.equal(store.audit(20, 'a2')[0].by, 'worker:planner');
  assert.equal(moved.changed, true);
  assert.deepEqual(store.audit(20, 'a').map((a) => [a.from, a.to, a.by]), [[{ project: 'p', workspace: 'w' }, { project: 'q', workspace: 'w2' }, 'worker:planner'], [null, { project: 'p', workspace: 'w' }, 'account:admin']]);
  // A restart is a new instance over the same file; the binding is found by floor and by checkout.
  const after = new HarnessBindings(dir);
  assert.equal(after.forFloor('a')?.project, 'q');
  assert.equal(after.forRepo(checkout)?.workspace, 'w2');
  assert.equal(after.forRepo(path.join(dir, 'elsewhere')), undefined);
  assert.equal(after.revision(), 3);
  // A damaged file fails closed and is left alone.
  writeFileSync(path.join(dir, 'harness-bindings.json'), '{not json');
  assert.throws(() => after.forFloor('a'), (e: Error & { status: number }) => e.status === 503);
  assert.equal(readFileSync(path.join(dir, 'harness-bindings.json'), 'utf8'), '{not json');
});

test('the request log: a repeat by id or by payload gets the first result, the same id with another payload is refused', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-req-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = new HarnessRequests(dir);
  const body = { scope: 'task', layer: { tone: { value: 'warm' } }, revision: 3, requestId: 'r1' };
  assert.equal(log.replay('repo:x', body), undefined);
  await log.exclusive(async () => log.record('repo:x', body, 200, { revision: 4 }));
  assert.deepEqual(log.replay('repo:x', { ...body, layer: { tone: { value: 'warm' } } })?.body, { revision: 4 }, 'key order and the id do not count');
  assert.equal(log.replay('repo:y', body), undefined, 'another repository knows nothing of it');
  assert.throws(() => log.replay('repo:x', { ...body, revision: 4 }), (e: Error & { status: number }) => e.status === 409 && /another request/.test(e.message));
  assert.throws(() => log.replay('repo:x', { ...body, requestId: 'bad id!' }), (e: Error & { status: number }) => e.status === 400);
  // Without an id the payload itself (revision included) is the key; with a new revision it is a new write.
  const plain = { scope: 'task', layer: {}, revision: 5 };
  await log.exclusive(async () => log.record('repo:x', plain, 200, { revision: 6 }));
  assert.deepEqual(log.replay('repo:x', { layer: {}, revision: 5, scope: 'task' })?.body, { revision: 6 });
  assert.equal(log.replay('repo:x', { ...plain, revision: 6 }), undefined);
  assert.notEqual(requestDigest(plain), requestDigest({ ...plain, revision: 6 }));
  assert.equal(new HarnessRequests(dir).replay('repo:x', body)?.status, 200, 'the log survives a restart');
});

test('the authorization matrix of profiles and bindings: who reads, who writes, who binds', async (t) => {
  const { call } = await office(t);
  const api = '/api/harness/profile?floor=a&node=' + encodeURIComponent(k('c1'));
  const bindApi = '/api/harness/binding?floor=a';
  // Floor A is bound by the administrator up front; its planner then may write below global.
  assert.equal((await call(bindApi, 'admin', place)).status, 200);
  const revision = async (caller: Caller) => ((await (await call(caller.profile, caller.session, undefined, undefined, caller.auth)).json()) as { revision: number }).revision;
  interface Caller { who: string; session?: string; auth?: string; origin?: string; profile: string; binding: string; expect: { read: number; below: number; global: number; readBinding: number; bind: number } }
  // A worker's floor is its own: the ones of floors B and C address a custom task of theirs (floor A's keys are another project's there).
  const worker = (id: string, token = 'tok-' + id, node = k('c1')) => ({ profile: '/office/harness?worker=' + id + '&node=' + encodeURIComponent(node), binding: '/office/harness/binding?worker=' + id, auth: 'Bearer ' + token });
  const session = (who: string) => ({ session: who, profile: api, binding: bindApi });
  const callers: Caller[] = [
    { who: 'administrator session', ...session('admin'), expect: { read: 200, below: 200, global: 200, readBinding: 200, bind: 200 } },
    { who: 'shared-password session', ...session('shared'), expect: { read: 200, below: 200, global: 200, readBinding: 200, bind: 200 } },
    { who: 'member session', ...session('member'), expect: { read: 200, below: 403, global: 403, readBinding: 200, bind: 403 } },
    { who: 'no session', ...session(''), expect: { read: 401, below: 401, global: 401, readBinding: 401, bind: 401 } },
    { who: 'administrator from another origin', ...session('admin'), origin: 'https://evil.example', expect: { read: 200, below: 403, global: 403, readBinding: 200, bind: 403 } },
    { who: 'planner an administrator owns', ...worker('planner'), expect: { read: 200, below: 200, global: 403, readBinding: 200, bind: 200 } },
    { who: 'ordinary worker of the floor', ...worker('ordinary'), expect: { read: 200, below: 403, global: 403, readBinding: 200, bind: 403 } },
    { who: 'planner a member owns', ...worker('mplanner', undefined, 'own-task'), expect: { read: 200, below: 403, global: 403, readBinding: 200, bind: 403 } },
    { who: 'another floor\'s worker', ...worker('worker-b', undefined, 'own-task'), expect: { read: 200, below: 403, global: 403, readBinding: 200, bind: 403 } },
    { who: 'forged token', ...worker('planner', 'tok-worker-b'), expect: { read: 401, below: 401, global: 401, readBinding: 401, bind: 401 } },
    { who: 'forged worker id', ...worker('nobody'), expect: { read: 401, below: 401, global: 401, readBinding: 401, bind: 401 } },
  ];
  for (const c of callers) {
    const post = async (url: string, body: unknown) => (await call(url, c.session, body, c.origin, c.auth)).status;
    assert.equal((await call(c.profile, c.session, undefined, c.origin, c.auth)).status, c.expect.read, `${c.who}: read profile`);
    assert.equal((await call(c.binding, c.session, undefined, c.origin, c.auth)).status, c.expect.readBinding, `${c.who}: read binding`);
    const rev = c.expect.read === 200 ? await revision(c) : 0;
    assert.equal(await post(c.profile, { scope: 'sector', layer: { who: { value: c.who } }, revision: rev, at: k('sector') }), c.expect.below, `${c.who}: write below global`);
    assert.equal(await post(c.profile, { scope: 'global', layer: { who: { value: c.who } }, revision: c.expect.below === 200 ? rev + 1 : rev }), c.expect.global, `${c.who}: write global`);
    assert.equal(await post(c.binding, place), c.expect.bind, `${c.who}: bind`);
  }
  // A worker reads its own floor's binding and nothing of another's: floor B's worker sees floor B (unbound), not floor A.
  const b = await (await call('/office/harness/binding?worker=worker-b', '', undefined, undefined, 'Bearer tok-worker-b')).json() as { binding: unknown; audit: unknown[] };
  assert.equal(b.binding, null);
  assert.deepEqual(b.audit, []);
  const a = await (await call('/office/harness/binding?worker=ordinary', '', undefined, undefined, 'Bearer tok-ordinary')).json() as { binding: { project: string; boundBy: string } };
  assert.equal(a.binding.project, 'p');
  assert.equal(a.binding.boundBy, 'account:admin');
  // The audit names each writer; the member-owned planner and the ordinary worker never got in.
  const view = await (await call(api, 'admin')).json() as { audit: { by: string }[] };
  assert.deepEqual([...new Set(view.audit.map((x) => x.by))].sort(), ['account:admin', 'shared-password', 'worker:planner']);
});

test('the orchestrator contract: safe retries, CAS, an unknown node, a request naming another project, Opora down, link drift', async (t) => {
  const { call, dir, opora } = await office(t);
  const api = '/api/harness/profile?floor=a&node=' + encodeURIComponent(k('c1'));
  const planner = (q = '') => '/office/harness?worker=planner' + q;
  const auth = 'Bearer tok-planner';
  // Before the floor is bound, the orchestrator's save at an Opora node is refused with the way out; the project and global layers need no binding.
  const unbound = await call(planner('&node=' + encodeURIComponent(k('c1'))), '', { scope: 'sector', layer: {}, revision: 0, at: k('sector') }, undefined, auth);
  assert.equal(unbound.status, 409);
  assert.match((await unbound.json() as { error: string }).error, /not bound to an Opora project.*--bind PROJECT WORKSPACE/);
  assert.equal((await call(planner(), '', { scope: 'repository', layer: { a: { value: 1 } }, revision: 0 }, undefined, auth)).status, 200);
  // The planner binds its floor with a request id; the same request again is the same answer, one audit entry; another payload under the id is refused.
  const bind = { ...place, requestId: 'bind-1' };
  const bound = await call('/office/harness/binding?worker=planner', '', bind, undefined, auth);
  assert.equal(bound.status, 200);
  const boundBody = await bound.json() as { binding: { boundBy: string }; revision: number; changed: boolean; audit: unknown[] };
  assert.equal(boundBody.changed, true);
  assert.equal(boundBody.binding.boundBy, 'worker:planner');
  const boundAgain = await call('/office/harness/binding?worker=planner', '', bind, undefined, auth);
  assert.equal(boundAgain.status, 200);
  assert.equal(boundAgain.headers.get('x-harness-replay'), '1');
  assert.deepEqual(await boundAgain.json(), boundBody);
  assert.equal(new HarnessBindings(dir).audit().length, 1);
  const reused = await call('/office/harness/binding?worker=planner', '', { project: 'q', workspace: 'w', requestId: 'bind-1' }, undefined, auth);
  assert.equal(reused.status, 409);
  assert.match((await reused.json() as { error: string }).error, /requestId bind-1 was used for another request/);
  // A profile save with a request id: the repeat returns the stored result (same body, no second audit entry, revision untouched); another payload under it is 409.
  const save = { scope: 'sector', layer: { tone: { value: 'terse' } }, revision: 1, at: k('sector'), requestId: 'save-1' };
  const first = await call(planner('&node=' + encodeURIComponent(k('c1'))), '', save, undefined, auth);
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { revision: number; audit: unknown[]; binding: { project: string }; preview: string };
  assert.equal(firstBody.revision, 2);
  assert.equal(firstBody.binding.project, 'p');
  const second = await call(planner('&node=' + encodeURIComponent(k('c1'))), '', save, undefined, auth);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-harness-replay'), '1');
  assert.deepEqual(await second.json(), { ...firstBody, preview: '' }, 'the stored reply, without the preview');
  const profiles = new HarnessProfiles(dir);
  assert.equal(profiles.view(dir).revision, 2, 'nothing was written twice');
  assert.equal(profiles.audit(50).filter((a) => a.level === 'sector').length, 1, 'one audit entry');
  assert.equal((await call(planner('&node=' + encodeURIComponent(k('c1'))), '', { ...save, layer: { tone: { value: 'warm' } } }, undefined, auth)).status, 409);
  // The node addressed is part of the request: the same id at another node is a reused id (409), and without an id the same body at another node is a new write, not a replay.
  const elsewhere = await call(planner('&node=' + encodeURIComponent(k('sector'))), '', save, undefined, auth);
  assert.equal(elsewhere.status, 409);
  assert.match((await elsewhere.json() as { error: string }).error, /requestId save-1 was used for another request/);
  const { requestId: _r, ...plain } = save;
  const plainElsewhere = await call(planner('&node=' + encodeURIComponent(k('sector'))), '', plain, undefined, auth);
  assert.equal(plainElsewhere.status, 409, 'a stale revision at another node is the conflict it is');
  assert.equal(plainElsewhere.headers.get('x-harness-replay'), null);
  assert.ok(typeof firstBody.preview === 'string' && firstBody.preview.length > 0, 'the first reply carries the preview');
  // The log is the caller's own: the administrator sending the planner's exact request is not handed the planner's reply but a conflict of its own (stale revision).
  const admin = await call(api, 'admin', save);
  assert.equal(admin.status, 409);
  assert.equal(admin.headers.get('x-harness-replay'), null);
  // CAS: a stale revision with a new payload is a conflict, and the layer is as the accepted save left it.
  const stale = await call(planner('&node=' + encodeURIComponent(k('c1'))), '', { scope: 'sector', layer: { tone: { value: 'warm' } }, revision: 1, at: k('sector') }, undefined, auth);
  assert.equal(stale.status, 409);
  assert.deepEqual(profiles.view(dir, [{ level: 'sector', node: k('sector') }]).layers.sector, { tone: { value: 'terse' } });
  // A request that names the project and workspace it acts on is checked against the binding.
  assert.equal((await call(planner('&node=' + encodeURIComponent(k('c1'))), '', { scope: 'task', layer: {}, revision: 2, at: k('c1'), project: 'p', workspace: 'w' }, undefined, auth)).status, 200);
  const other = await call(planner('&node=' + encodeURIComponent(k('c1'))), '', { scope: 'task', layer: {}, revision: 3, at: k('c1'), project: 'q', workspace: 'w' }, undefined, auth);
  assert.equal(other.status, 409);
  assert.match((await other.json() as { error: string }).error, /acts on project q, workspace w, but floor a is bound to project p, workspace w/);
  // A node of another project or workspace is not this floor's to change (403); an unknown node of the bound project echoes its id (400).
  const foreign = await call(planner('&node=' + encodeURIComponent(oporaKey({ project: 'q', workspace: 'w' }, 'c1'))), '', { scope: 'task', layer: {}, revision: 3, at: '' }, undefined, auth);
  assert.equal(foreign.status, 403);
  assert.match((await foreign.json() as { error: string }).error, /project q, workspace w; floor a is bound to project p/);
  const unknown = await call(planner('&node=' + encodeURIComponent(k('ghost-42'))), '', { scope: 'task', layer: { x: { value: 1 } }, revision: 3, at: k('ghost-42') }, undefined, auth);
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json() as { error: string }).error, /Unknown node ghost-42: it isn't on the canvas of project p, workspace w/);
  assert.equal((await call(planner('&node=' + encodeURIComponent(k('ghost-42'))), '', undefined, undefined, auth)).status, 200, 'reading an unknown node still answers (a task with nothing above it)');
  assert.equal(profiles.view(dir).revision, 3, 'none of the refusals wrote anything');
  // Opora down: reads still answer from the local store (and say so), writes below the project are refused with 503 and nothing is written.
  Object.assign(opora, { connected: false, error: 'Opora isn\'t answering at http://127.0.0.1:1 (fetch failed)', project: null, workspace: null });
  const offline = await (await call(api, 'admin')).json() as { revision: number; binding: { project: string }; warning: string; path: { level: string }[] };
  assert.equal(offline.revision, 3);
  assert.equal(offline.binding.project, 'p');
  assert.match(offline.warning, /Opora isn't answering: this is the local store/);
  assert.deepEqual(offline.path.map((p) => p.level), ['page', 'sector', 'task'], 'the canvas as last read still places the card');
  const down = await call(planner('&node=' + encodeURIComponent(k('c1'))), '', { scope: 'sector', layer: { tone: { value: 'offline' } }, revision: 3, at: k('sector') }, undefined, auth);
  assert.equal(down.status, 503);
  assert.match((await down.json() as { error: string }).error, /Opora isn't answering \(Opora isn't answering at http:\/\/127\.0\.0\.1:1 \(fetch failed\)\): the node's place on the canvas can't be checked, so nothing was written/);
  const downBind = await call('/office/harness/binding?worker=planner', '', { project: 'p', workspace: 'w3', rebind: true }, undefined, auth);
  assert.equal(downBind.status, 503);
  assert.equal(profiles.view(dir).revision, 3);
  assert.equal(new HarnessBindings(dir).forFloor('a')?.workspace, 'w');
  assert.equal((await call(planner(), '', { scope: 'repository', layer: { a: { value: 2 } }, revision: 3 }, undefined, auth)).status, 200, 'the project layer needs no canvas');
  // Link drift: the window reads another project than the floor is bound to; a save at an Opora node is refused until one of them is changed.
  Object.assign(opora, { connected: true, error: undefined, project: { id: 'q', name: 'Q' }, workspace: 'w' });
  const drift = await call(planner('&node=' + encodeURIComponent(k('c1'))), '', { scope: 'sector', layer: {}, revision: 4, at: k('sector') }, undefined, auth);
  assert.equal(drift.status, 409);
  assert.match((await drift.json() as { error: string }).error, /window reads project q, workspace w, but the floor is bound to project p, workspace w/);
  const driftBind = await call('/office/harness/binding?worker=planner', '', { project: 'q', workspace: 'w', rebind: false }, undefined, auth);
  assert.equal(driftBind.status, 409, 'rebinding to what the window reads is explicit');
  assert.match((await driftBind.json() as { error: string }).error, /Rebinding is explicit/);
  Object.assign(opora, { project: { id: 'p', name: 'P' } });
});

test('rebinding keeps the old binding\'s profiles under the checkout\'s key, and the dispatch gate refuses a card of another project', async (t) => {
  const { call, dir, opora } = await office(t);
  assert.equal((await call('/api/harness/binding?floor=a', 'admin', place)).status, 200);
  assert.equal((await call('/api/harness/profile?floor=a&node=' + encodeURIComponent(k('c1')), 'admin', { scope: 'sector', layer: { tone: { value: 'kept' } }, revision: 0, at: k('sector') })).status, 200);
  const before = new HarnessProfiles(dir).view(dir, [{ level: 'sector', node: k('sector') }]);
  // The window moves to another workspace; the administrator rebinds explicitly. Profiles are keyed by the checkout, not the project: still there.
  opora.workspace = 'w2';
  const implicit = await call('/api/harness/binding?floor=a', 'admin', { project: 'p', workspace: 'w2' });
  assert.equal(implicit.status, 409);
  const rebound = await call('/api/harness/binding?floor=a', 'admin', { project: 'p', workspace: 'w2', rebind: true });
  assert.equal(rebound.status, 200);
  const body = await rebound.json() as { binding: { workspace: string }; audit: { from: unknown; to: unknown }[]; changed: boolean };
  assert.equal(body.binding.workspace, 'w2');
  assert.deepEqual(body.audit[0], { ...body.audit[0], from: place, to: { project: 'p', workspace: 'w2' } });
  const after = new HarnessProfiles(dir).view(dir, [{ level: 'sector', node: k('sector') }]);
  assert.deepEqual(after.layers, before.layers);
  assert.equal(after.revision, before.revision);
  // The old workspace's keys are another workspace's now (403); the new one's resolve. A GET shows the new binding; a restart (new store instance) keeps it.
  assert.equal((await call('/api/harness/profile?floor=a&node=' + encodeURIComponent(k('c1')), 'admin', { scope: 'sector', layer: {}, revision: after.revision, at: k('sector') })).status, 403);
  const view = await (await call('/api/harness/profile?floor=a&node=' + encodeURIComponent(oporaKey({ project: 'p', workspace: 'w2' }, 'c1')), 'admin')).json() as { binding: { workspace: string }; layers: { sector: unknown } };
  assert.equal(view.binding.workspace, 'w2');
  assert.deepEqual(view.layers.sector, {}, 'the old workspace\'s sector layer is not this workspace\'s');
  assert.equal(new HarnessBindings(dir).forFloor('a')?.workspace, 'w2');
  // The dispatch gate: a card of the bound project and workspace is handed out; one of another is refused before any lease is claimed.
  const nodes = [{ id: 'sector', kind: 'sector', name: 'Sector', parentId: null }, { id: 'c1', kind: 'node', name: 'Card 1', parentId: 'sector' }];
  assert.match(await harnessCardHandoff(dir, dir, { project: 'p', workspace: 'w2' }, 'c1', nodes, true), /Resolved Harness/);
  await assert.rejects(harnessCardHandoff(dir, dir, place, 'c1', nodes, true), /bound to Opora project p, workspace w2, and the card is in project p, workspace w/);
  await assert.rejects(harnessCardHandoff(dir, dir, { project: 'q', workspace: 'w2' }, 'c1', nodes, true), /bound to Opora project p/);
  // An unbound floor (another checkout) dispatches as before.
  assert.match(await harnessCardHandoff(dir, path.join(dir, 'other'), { project: 'q', workspace: 'w2' }, 'c1', nodes, true), /Resolved Harness/);
});

test('the pure checks: what a bind target and a bound write are refused for', () => {
  const linked = { connected: true, project: { id: 'p', name: 'P' }, workspace: 'w' };
  assert.doesNotThrow(() => checkBindTarget(linked, place));
  assert.throws(() => checkBindTarget({ ...linked, connected: false, error: 'down' }, place), (e: Error & { status: number }) => e.status === 503 && /nothing was bound/.test(e.message));
  assert.throws(() => checkBindTarget({ connected: true, project: null, workspace: null }, place), (e: Error & { status: number }) => e.status === 409 && /No Opora project is linked/.test(e.message));
  assert.throws(() => checkBindTarget(linked, { project: 'p', workspace: 'w2' }), (e: Error & { status: number }) => e.status === 409 && /never names a project the floor doesn't read/.test(e.message));
  const binding = { ...place, repoHash: 'h', floorId: 'a', checkoutPath: '/a', boundAt: '', boundBy: '' };
  const write = { floorId: 'a', binding, opora: { connected: true }, linked: place, key: k('c1'), below: true, claims: {}, known: true };
  assert.doesNotThrow(() => assertBoundWrite(write));
  assert.doesNotThrow(() => assertBoundWrite({ ...write, binding: undefined, key: 'custom-task' }), 'a custom task id needs no binding');
  assert.doesNotThrow(() => assertBoundWrite({ ...write, binding: undefined, below: false }), 'the project and global layers need none');
  assert.doesNotThrow(() => assertBoundWrite({ ...write, opora: { connected: false }, below: false }), 'Opora down does not stop a project-level save');
  const status = (w: Parameters<typeof assertBoundWrite>[0]) => { try { assertBoundWrite(w); return 200; } catch (e) { return (e as { status: number }).status; } };
  assert.equal(status({ ...write, binding: undefined }), 409);
  assert.equal(status({ ...write, binding: undefined, below: false, claims: { project: 'p', workspace: 'w' } }), 409);
  assert.equal(status({ ...write, claims: { project: 'p', workspace: 'w2' } }), 409);
  assert.equal(status({ ...write, key: oporaKey({ project: 'q', workspace: 'w' }, 'c1') }), 403);
  assert.equal(status({ ...write, opora: { connected: false } }), 503);
  assert.equal(status({ ...write, linked: undefined }), 409);
  assert.equal(status({ ...write, linked: { project: 'p', workspace: 'w2' } }), 409);
  assert.equal(status({ ...write, known: false }), 400);
});

test('the CLI: --binding, --bind, --assign --request-id inside a worker; a clear line outside one', async (t) => {
  const { base, call, dir } = await office(t);
  const env = { AGENT_OFFICE_HOOK_URL: base, AGENT_OFFICE_WORKER_ID: 'planner', AGENT_OFFICE_HOOK_TOKEN: 'tok-planner' };
  const previous = { ...process.env };
  Object.assign(process.env, env);
  const printed: string[] = [];
  const log = console.log;
  console.log = (line: string) => void printed.push(line);
  const last = () => JSON.parse(printed.pop()!);
  try {
    await remoteHarness(['--binding']);
    assert.equal(last().binding, null);
    await assert.rejects(remoteHarness(['--bind', 'p']), /--bind takes the Opora project id and workspace id/);
    await assert.rejects(remoteHarness(['--bind', 'p', 'w', '--node', k('c1')]), /about the floor, not a node/);
    await assert.rejects(remoteHarness(['--rebind', '--effective']), /--rebind goes with --bind/);
    await assert.rejects(remoteHarness(['--effective', '--request-id', 'x']), /--request-id goes with --assign or --bind/);
    await remoteHarness(['--bind', 'p', 'w', '--request-id', 'cli-bind']);
    assert.equal(last().binding.boundBy, 'worker:planner');
    await remoteHarness(['--bind', 'p', 'w', '--request-id', 'cli-bind']);
    assert.equal(last().changed, true, 'the repeat is the stored answer of the first bind');
    assert.equal(new HarnessBindings(dir).audit().length, 1);
    await assert.rejects(remoteHarness(['--bind', 'p', 'w2']), /window reads project p \(P\), workspace w/);
    await remoteHarness(['--binding']);
    assert.equal(last().binding.project, 'p');
    const assignments = path.join(dir, 'assignments.json');
    writeFileSync(assignments, JSON.stringify({ revision: 0, layer: { tone: { value: 'cli' } } }));
    await remoteHarness(['--assign', 'sector', assignments, '--node', k('c1'), '--request-id', 'cli-save']);
    assert.equal(last().revision, 1);
    await remoteHarness(['--assign', 'sector', assignments, '--node', k('c1'), '--request-id', 'cli-save']);
    assert.equal(last().revision, 1, 'the retry gets the first answer back');
    assert.equal(new HarnessProfiles(dir).view(dir).revision, 1);
    assert.equal((await (await call('/api/harness/profile?floor=a', 'admin')).json() as { audit: unknown[] }).audit.length, 1);
    await assert.rejects(remoteHarness(['--assign', 'sector', assignments, '--node', k('c1')]), /Profiles changed elsewhere/, 'without the id, a stale revision is the conflict it is');
  } finally { console.log = log; for (const key of Object.keys(env)) delete process.env[key]; Object.assign(process.env, previous); }
});

const status = (code: number, message: RegExp) => (err: Error & { status: number }) => err.status === code && message.test(err.message);
const child = (dir: string, mode: string, arg: string) => promisify(execFile)(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'fixtures', 'harness-bindings-writer.ts'), dir, mode, arg], { cwd: path.join(import.meta.dirname, '..'), timeout: 110_000 }).then((r) => JSON.parse(r.stdout) as string | number);

test('the same save sent twice at once is written once: one revision, one audit entry, the second is a replay', async (t) => {
  const { call, dir } = await office(t);
  await new HarnessBindings(dir).bind('a', dir, place, 'account:admin');
  const api = '/api/harness/profile?floor=a&node=' + encodeURIComponent(k('c1'));
  const before = await (await call(api, 'admin')).json() as { revision: number };
  const save = { scope: 'sector', layer: { tone: { value: 'once' } }, revision: before.revision, at: k('sector'), requestId: 'twice' };
  const replies = await Promise.all([call(api, 'admin', save), call(api, 'admin', save)]);
  assert.deepEqual(replies.map((r) => r.status), [200, 200]);
  assert.equal(replies.filter((r) => r.headers.get('x-harness-replay') === '1').length, 1, 'exactly one of them is a replay');
  const [first, second] = await Promise.all(replies.map((r) => r.json() as Promise<{ revision: number }>));
  assert.equal(first.revision, before.revision + 1);
  assert.equal(second.revision, before.revision + 1, 'the replay carries the first write result');
  const after = await (await call(api, 'admin')).json() as { revision: number; audit: { slots: string[] }[] };
  assert.equal(after.revision, before.revision + 1, 'one write');
  assert.equal(after.audit.filter((a) => a.slots.includes('tone')).length, 1, 'one audit entry');
  assert.equal(existsSync(path.join(dir, 'harness-requests.json.lock')), false, 'the request log lock is released');
});

test('the same bind sent twice at once binds once; two binds to different projects at once: one wins, the other is a 409', async (t) => {
  const { call, dir } = await office(t);
  const bind = { ...place, requestId: 'bind-twice' };
  const replies = await Promise.all([call('/api/harness/binding?floor=a', 'admin', bind), call('/api/harness/binding?floor=a', 'admin', bind)]);
  assert.deepEqual(replies.map((r) => r.status), [200, 200]);
  assert.equal(replies.filter((r) => r.headers.get('x-harness-replay') === '1').length, 1);
  assert.equal(new HarnessBindings(dir).audit().length, 1, 'one audit entry');
  // Two stores (two offices on one directory) binding a new floor to different projects: the check and the write are one step under the lock.
  const checkout = path.join(dir, 'other');
  const results = await Promise.allSettled([new HarnessBindings(dir).bind('z', checkout, { project: 'p1', workspace: 'w' }, 'x'), new HarnessBindings(dir).bind('z2', checkout, { project: 'p2', workspace: 'w' }, 'y')]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(status(409, /same checkout bound/)(lost.reason), String(lost.reason));
  assert.equal(new HarnessBindings(dir).audit().length, 2, 'one more entry, the winner');
  assert.equal(existsSync(path.join(dir, 'harness-bindings.json.lock')), false);
});

test('two office processes sending the same write, and binding one floor to different projects, at once', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-lock2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wrote = await Promise.all([child(dir, 'request', 'one'), child(dir, 'request', 'two')]);
  assert.deepEqual([...wrote].sort(), ['replay', 'wrote'], 'one process wrote, the other found its record');
  assert.equal(readFileSync(path.join(dir, 'writes.log'), 'utf8').trim().split(String.fromCharCode(10)).length, 1, 'one write, one audit line');
  assert.equal(new HarnessRequests(dir).replay('repo:x', { scope: 'task', layer: { tone: { value: 'warm' } }, revision: 0, requestId: 'same' })?.status, 200);
  const bound = await Promise.all([child(dir, 'bind', 'p1'), child(dir, 'bind', 'p2')]);
  assert.deepEqual([...bound].sort(), [409, 'bound'], 'one project won, the other is a 409');
  assert.equal(new HarnessBindings(dir).audit().length, 1);
  assert.equal(new HarnessBindings(dir).revision(), 1);
});

test('a bind repeated without a requestId is replayed only while its stored reply is still the truth (E1)', async (t) => {
  const { call, dir, opora } = await office(t);
  const bindUrl = '/api/harness/binding?floor=a';
  const fileProject = () => (JSON.parse(readFileSync(path.join(dir, 'harness-bindings.json'), 'utf8')) as { bindings: Record<string, { project: string }> }).bindings.a?.project;
  assert.equal((await call(bindUrl, 'admin', place)).status, 200);
  // The same payload again while nothing changed is a replay of the first reply.
  const again = await call(bindUrl, 'admin', place);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('x-harness-replay'), '1');
  Object.assign(opora, { project: { id: 'q', name: 'Q' } });
  assert.equal((await call(bindUrl, 'admin', { project: 'q', workspace: 'w', rebind: true })).status, 200);
  Object.assign(opora, { project: { id: 'p', name: 'P' } });
  // Bound to q now: binding p again without rebind is a conflict, never a replay claiming p.
  const stale = await call(bindUrl, 'admin', place);
  assert.equal(stale.status, 409);
  assert.equal(stale.headers.get('x-harness-replay'), null);
  assert.equal(fileProject(), 'q');
  // Binding q again (what the file holds) succeeds idempotently and reports q.
  Object.assign(opora, { project: { id: 'q', name: 'Q' } });
  const idem = await call(bindUrl, 'admin', { project: 'q', workspace: 'w' });
  assert.equal(idem.status, 200);
  assert.equal(((await idem.json()) as { binding: { project: string } }).binding.project, 'q');
});

test('a save queued behind the request-log lock sees a rebind that landed while it waited (E2)', async (t) => {
  const { call, dir } = await office(t);
  assert.equal((await call('/api/harness/binding?floor=a', 'admin', place)).status, 200);
  const url = '/api/harness/profile?floor=a&node=' + encodeURIComponent(k('c1'));
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let acquired!: () => void;
  const gotLock = new Promise<void>((r) => (acquired = r));
  const holder = withFileLock(path.join(dir, 'harness-requests.json.lock'), { waitMs: 5000 }, async () => { acquired(); await held; });
  await gotLock;
  const save = call(url, 'admin', { scope: 'sector', layer: { tone: { value: 'stale' } }, revision: 0, at: k('sector') });
  await new Promise((r) => setTimeout(r, 400)); // the save is queued behind the lock
  await new HarnessBindings(dir).bind('a', dir, { project: 'q', workspace: 'w' }, 'account:admin', { rebind: true });
  release();
  await holder;
  const res = await save;
  assert.equal(res.status, 403, 'a node of project p is foreign once the floor is bound to q');
  assert.equal(existsSync(path.join(dir, 'harness-profiles.json')), false, 'nothing was written');
});

test('a null item in the bindings audit fails closed with 503 (not a TypeError)', async (t) => {
  const { call, dir } = await office(t);
  assert.equal((await call('/api/harness/binding?floor=a', 'admin', place)).status, 200);
  const file = path.join(dir, 'harness-bindings.json');
  const data = JSON.parse(readFileSync(file, 'utf8')) as { audit: unknown[] };
  data.audit.push(null);
  writeFileSync(file, JSON.stringify(data));
  const res = await call('/api/harness/binding?floor=a', 'admin');
  assert.equal(res.status, 503);
  assert.throws(() => new HarnessBindings(dir).audit(), (e: Error & { status: number }) => e.status === 503);
});

const MAX_LOG = 4 * 1024 * 1024;
const logSize = (dir: string) => statSync(path.join(dir, 'harness-requests.json')).size;

test('many callers saving large profiles never leave a request log the reader refuses (B1)', async (t) => {
  const { call, dir } = await office(t);
  const api = '/api/harness/profile?floor=a';
  let revision = 0;
  // 14 different callers (each its own log scope), each a valid save of 50 slots x 3500 characters: together far over the log's cap.
  for (let i = 0; i < 14; i++) {
    const layer = Object.fromEntries(Array.from({ length: 50 }, (_, n) => ['s' + n, { value: String(i % 10).repeat(3500) }]));
    const res = await call(api, 'admin-' + i, { scope: 'repository', layer, revision });
    assert.equal(res.status, 200, 'save ' + i + ': ' + (res.status === 200 ? '' : JSON.stringify(await res.clone().json())));
    revision = (await res.json() as { revision: number }).revision;
    assert.ok(logSize(dir) <= MAX_LOG, 'the file stays under the cap after save ' + i);
    assert.doesNotThrow(() => new HarnessRequests(dir).replay('repo:none', { scope: 'task', layer: {}, revision: 0 }), 'a fresh reader accepts the file after save ' + i);
  }
  // A bind goes through too (it also needs a readable log).
  assert.equal((await call('/api/harness/binding?floor=a', 'admin', { ...place, requestId: 'b1-bind' })).status, 200);
});

test('the request log keeps at most 200 scopes, the least recently written dropped first', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-scopes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = new HarnessRequests(dir);
  const body = (n: number) => ({ scope: 'task', layer: { n: { value: n } }, revision: n });
  for (let i = 0; i < 205; i++) await log.exclusive(async () => log.record('scope:' + i, body(i), 200, { i }));
  const stored = JSON.parse(readFileSync(path.join(dir, 'harness-requests.json'), 'utf8')) as { requests: Record<string, unknown[]> };
  assert.equal(Object.keys(stored.requests).length, 200);
  const fresh = new HarnessRequests(dir);
  for (let i = 0; i < 5; i++) assert.equal(fresh.replay('scope:' + i, body(i)), undefined, 'scope ' + i + ' was evicted');
  for (let i = 5; i < 205; i++) assert.equal(fresh.replay('scope:' + i, body(i))?.status, 200, 'scope ' + i + ' is kept');
});

test('a single reply over the per-record cap is not stored, and the log stays as it was', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-big-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = new HarnessRequests(dir);
  const small = { scope: 'task', layer: {}, revision: 1 }, big = { scope: 'task', layer: {}, revision: 2 };
  await log.exclusive(async () => log.record('repo:x', small, 200, { ok: true }));
  const before = readFileSync(path.join(dir, 'harness-requests.json'), 'utf8');
  await log.exclusive(async () => log.record('repo:x', big, 200, { blob: 'x'.repeat(MAX_LOG) }));
  assert.equal(readFileSync(path.join(dir, 'harness-requests.json'), 'utf8'), before);
  assert.equal(new HarnessRequests(dir).replay('repo:x', big), undefined, 'the retry gets an ordinary answer');
  assert.equal(new HarnessRequests(dir).replay('repo:x', small)?.status, 200);
});

test('the log a writer evicted down is read by a fresh instance, newest records kept, oldest scopes gone', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-evict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = new HarnessRequests(dir);
  const body = (n: number) => ({ scope: 'task', layer: {}, revision: n, requestId: 'r' + n });
  const reply = (n: number) => ({ n, pad: String(n % 10).repeat(380 * 1024) });
  // One scope with several records, then 12 scopes of one 380 KiB record each: well over 4 MiB.
  for (let n = 0; n < 3; n++) await log.exclusive(async () => log.record('scope:multi', body(n), 200, reply(n)));
  for (let i = 0; i < 12; i++) await log.exclusive(async () => log.record('scope:' + i, body(100 + i), 200, reply(100 + i)));
  assert.ok(logSize(dir) <= MAX_LOG);
  const fresh = new HarnessRequests(dir);
  assert.equal(fresh.replay('scope:11', body(111))?.status, 200, 'the newest write is kept');
  assert.equal(fresh.replay('scope:multi', body(0)), undefined, 'the oldest records of a multi-record scope went first');
  assert.equal(fresh.replay('scope:0', body(100)), undefined, 'then the oldest whole scope');
  await log.exclusive(async () => log.record('scope:12', body(112), 200, reply(112)));
  assert.equal(new HarnessRequests(dir).replay('scope:12', body(112))?.status, 200, 'and the log still takes writes');
});

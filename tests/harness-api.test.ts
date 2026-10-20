import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Ctx } from '../src/server/office/context.js';
import { requestHandler } from '../src/server/http/router.js';
import { harnessBindingRoute, harnessProfileRoute, harnessRoute } from '../src/server/http/routes/harness.js';
import { officeHarness } from '../src/server/harness/api.js';
import { officeHarnessBinding } from '../src/server/harness/binding-api.js';
import { oporaKey } from '../src/shared/opora-identity.js';
import { remoteHarness } from '../bin/harness-remote.js';

test('profile HTTP and hook API enforce session, origin, admin, planner and revision boundaries', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-api-'));
  // A canvas like the Harness plan: a page, a layer, an area beside the sector, and two cards in it; a card between
  // the page and the layer (`mid`) that no task's path goes through; a second sector that is a member of the area.
  let nodes = [
    { id: 'root', kind: 'sector', name: 'Shop', parentId: null }, { id: 'page', kind: 'node', name: 'Page', parentId: 'root' }, { id: 'layer', kind: 'node', name: 'Layer', parentId: 'page' },
    { id: 'area', kind: 'area', name: 'Area', parentId: 'layer' }, { id: 'sector', kind: 'sector', name: 'Sector', parentId: 'layer', memberOf: 'area' },
    { id: 'c1', kind: 'node', name: 'Card 1', parentId: 'sector' }, { id: 'c2', kind: 'node', name: 'Card 2', parentId: 'sector' },
    { id: 'sector2', kind: 'sector', name: 'Sector 2', parentId: 'layer', memberOf: 'area' }, { id: 'c3', kind: 'node', name: 'Card 3', parentId: 'sector2' },
    { id: 'mid', kind: 'node', name: 'Mid', parentId: 'page' }, { id: 'layer2', kind: 'node', name: 'Layer 2', parentId: 'mid' }, { id: 'sector3', kind: 'sector', name: 'Sector 3', parentId: 'layer2' }, { id: 'c4', kind: 'node', name: 'Card 4', parentId: 'sector3' },
  ];
  /** Set to move Card 1 to Sector 2 after the next canvas read: a move between a client's read and its save. */
  let moveAfterRead = false;
  /** Set to N to move Card 1 to the other sector on the Nth canvas read from now: a move while a save waits for the store's lock (the third read of a POST is the one under the lock). */
  let moveOnRead = 0, reads = 0;
  const moveCard1 = () => { nodes = nodes.map((n) => (n.id === 'c1' ? { ...n, parentId: n.parentId === 'sector' ? 'sector2' : 'sector' } : n)); };
  const canvasNodes = () => {
    reads++;
    if (moveOnRead && reads === moveOnRead) { moveOnRead = 0; moveCard1(); }
    const now = nodes;
    if (moveAfterRead) { moveAfterRead = false; nodes = nodes.map((n) => (n.id === 'c1' ? { ...n, parentId: 'sector2' } : n)); }
    return now;
  };
  const place = { project: 'p', workspace: 'w' };
  const k = (id: string) => oporaKey(place, id);
  const floor = {
    id: 'floor', dir, opora: { view: () => ({ connected: true, project: { id: 'p', name: 'P' }, workspace: 'w', cards: [{ id: 'c1', name: 'Card 1' }] }), canvasNodes },
    workers: { authenticate: (id: string, token: string) => token === 'test-token' ? { id } : undefined },
    planning: { state: () => ({ current: { workerId: 'planner', mode: 'opora', owner: 'admin' } }) },
  };
  // Another floor, another checkout, on the same office: its worker must see nothing of the first floor's saves.
  const dirB = mkdtempSync(path.join(tmpdir(), 'harness-api-b-'));
  const floorB = { ...floor, id: 'floor-b', dir: dirB, opora: { view: () => ({ connected: true, project: { id: 'pb', name: 'PB' }, workspace: 'w', cards: [] }), canvasNodes: () => [] }, planning: { state: () => ({ current: undefined }) } };
  const file = path.join(dir, 'harness-profiles.json');
  /** Set to N to make the store unreadable on the Nth read of the floor's checkout from now: in a POST the second one comes right after the commit. */
  let breakOnDirRead = 0, dirReads = 0, preserved = '';
  Object.defineProperty(floor, 'dir', { get() { if (breakOnDirRead && ++dirReads === breakOnDirRead) { breakOnDirRead = 0; preserved = readFileSync(file, 'utf8'); writeFileSync(file, 'broken'); } return dir; } });
  const ctx = {
    cfg: { dataDir: dir, port: 0 }, floors: new Map([['floor', floor], ['floor-b', floorB]]),
    accounts: { get: (id: string) => ({ role: id === 'admin' ? 'admin' : 'member' }) },
    auth: { fromRequest: (req: http.IncomingMessage) => req.headers['x-test-session'] === 'admin' ? { account: { id: 'admin', role: 'admin' } } : req.headers['x-test-session'] === 'member' ? { account: { role: 'member' } } : undefined },
    workerFloor: (id: string) => (id === 'worker-b' ? floorB : floor),
  } as unknown as Ctx;
  const handler = requestHandler(ctx, [harnessProfileRoute, harnessBindingRoute, harnessRoute]);
  const server = http.createServer((req, res) => req.url?.startsWith('/office/harness/binding') ? void officeHarnessBinding(ctx, req, res, new URL(req.url, 'http://x')) : req.url?.startsWith('/office/') ? void officeHarness(ctx, req, res, new URL(req.url, 'http://x')) : void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  ctx.cfg.port = (server.address() as { port: number }).port;
  t.after(() => { server.close(); server.closeAllConnections(); rmSync(dir, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }); });
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
  // The same payload at the same revision again is a retry: the stored result comes back, nothing is written twice; another payload at the stale revision is the conflict (CAS).
  const again = await call(api, 'admin', data);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('x-harness-replay'), '1');
  assert.equal((await again.json()).revision, 1);
  assert.equal((await call(api, 'admin', { ...data, layer: { language: { value: 'en' } } })).status, 409);
  assert.equal((await call('/api/harness/profile?floor=other', 'admin')).status, 404);
  assert.equal((await call('/office/harness?worker=planner')).status, 401);
  assert.equal((await call('/office/harness?worker=ordinary', '', { ...data, scope: 'repository', revision: 1 }, base, 'Bearer test-token')).status, 403);
  assert.equal((await call('/office/harness?worker=planner', '', { ...data, revision: 1 }, base, 'Bearer test-token')).status, 403);
  const saved = await call('/office/harness?worker=planner&task=one', '', { ...data, scope: 'task', revision: 1 }, base, 'Bearer test-token');
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).effective.language.scope, 'task');
  assert.equal((await call(api, 'admin', { ...data, layer: { rule: { resource: 'missing' } }, revision: 2 })).status, 400);
  // Profiles at Opora nodes need the floor bound to its project and workspace first (tests/harness-bindings.test.ts has the matrix).
  const unbound = await call(api + '&node=' + encodeURIComponent(k('c1')), 'admin', { scope: 'sector', layer: { tone: { value: 'terse' } }, revision: 2, at: k('sector') });
  assert.equal(unbound.status, 409);
  assert.match((await unbound.json()).error, /not bound to an Opora project/);
  assert.equal((await call('/api/harness/binding?floor=floor', 'admin', { project: 'p', workspace: 'w' })).status, 200);
  // Down the hierarchy: a card's key is placed on the canvas, its sector's layer reaches it and its sibling, with provenance and audit.
  const card = await call(api + '&node=' + encodeURIComponent(k('c1')), 'admin');
  assert.equal(card.status, 200);
  const view = await card.json();
  assert.deepEqual(view.path.map((p: { level: string }) => p.level), ['page', 'layer', 'area', 'sector', 'task']);
  assert.deepEqual(view.levels, ['global', 'project', 'page', 'layer', 'area', 'sector', 'task']);
  assert.deepEqual(view.tasks, [{ id: k('c1'), title: 'Card 1' }]);
  assert.deepEqual(Object.keys(view.binding).sort(), ['floorId', 'project', 'repoHash', 'workspace']);
  assert.equal(view.binding.project, 'p');
  // A save below the project at a node of the canvas must say which node it is for (`at`).
  const noAt = await call(api + '&node=' + encodeURIComponent(k('c1')), 'admin', { scope: 'sector', layer: { tone: { value: 'terse' } }, revision: 2 });
  assert.equal(noAt.status, 400);
  assert.match((await noAt.json()).error, /Send "at"/);
  assert.equal((await call(api + '&node=' + encodeURIComponent(k('c1')), 'admin', { scope: 'sector', layer: { tone: { value: 'terse' } }, revision: 2, at: k('sector') })).status, 200);
  const sibling = await (await call(api + '&task=' + encodeURIComponent(k('c2')), 'admin')).json();
  assert.deepEqual(sibling.effective.tone, { binding: { value: 'terse' }, scope: 'sector', node: k('sector'), nodeName: 'Sector' });
  assert.deepEqual(sibling.layers.task, {});
  assert.equal(sibling.audit[0].level, 'sector');
  assert.equal(sibling.audit[0].by, 'account:admin');
  assert.equal(sibling.audit[0].node, k('sector'));
  assert.equal(sibling.revision, 3);
  // A worker's save goes into the audit as the worker; a stale revision is refused; a foreign key never resolves.
  assert.equal((await call('/office/harness?worker=planner&node=' + encodeURIComponent(k('c2')), '', { scope: 'task', layer: { tone: { value: 'warm' } }, revision: 2, at: k('c2') }, base, 'Bearer test-token')).status, 409);
  const mine = await call('/office/harness?worker=planner&node=' + encodeURIComponent(k('c2')), '', { scope: 'task', layer: { tone: { value: 'warm' } }, revision: 3, at: k('c2') }, base, 'Bearer test-token');
  assert.equal(mine.status, 200);
  const after = await mine.json();
  assert.equal(after.effective.tone.scope, 'task');
  assert.equal(after.audit[0].by, 'worker:planner');
  assert.equal((await call(api + '&node=' + encodeURIComponent(oporaKey({ project: 'other', workspace: 'w' }, 'c1')), 'admin')).status, 400);
  assert.equal((await call(api + '&node=' + encodeURIComponent(k('c1')), 'admin', { scope: 'floor', layer: {}, revision: 4 })).status, 400);
  assert.equal((await call(api + '&task=custom', 'admin', { scope: 'sector', layer: {}, revision: 4 })).status, 400, 'a custom task has no sector above it');
  // A save that names the node it was edited for is refused when the canvas has moved the target since.
  assert.equal((await call(api + '&node=' + encodeURIComponent(k('c1')), 'admin', { scope: 'sector', layer: {}, revision: 4, at: k('sector') })).status, 200);
  assert.equal((await call(api + '&node=' + encodeURIComponent(k('c1')), 'admin', { scope: 'sector', layer: {}, revision: 5, at: k('other-sector') })).status, 409);
  assert.equal((await call(api + '&node=' + encodeURIComponent(k('c1')), 'admin', { scope: 'global', layer: {}, revision: 5, at: '' })).status, 200);
  // An area layer saved through the area's own key reaches every card whose sector is a member of it (memberOf), in both sectors.
  const areaView = await (await call(api + '&node=' + encodeURIComponent(k('area')), 'admin')).json();
  assert.deepEqual(areaView.path.map((p: { level: string }) => p.level), ['page', 'layer', 'area']);
  assert.equal((await call(api + '&node=' + encodeURIComponent(k('area')), 'admin', { scope: 'area', layer: { palette: { value: 'warm' } }, revision: 6, at: k('area') })).status, 200);
  for (const card of ['c1', 'c3']) assert.deepEqual((await (await call(api + '&node=' + encodeURIComponent(k(card)), 'admin')).json()).effective.palette, { binding: { value: 'warm' }, scope: 'area', node: k('area'), nodeName: 'Area' }, `${card} inherits the area through its sector's membership`);
  assert.equal((await (await call(api + '&node=' + encodeURIComponent(k('c4')), 'admin')).json()).effective.palette, undefined, 'a card whose sector is in no area does not');
  // A card between the page and the layers under it is given no level any task goes through: a save there is refused, not written into the void.
  const midView = await (await call(api + '&node=' + encodeURIComponent(k('mid')), 'admin')).json();
  assert.deepEqual(midView.path.map((p: { level: string }) => p.level), ['page', 'layer']);
  const dead = await call(api + '&node=' + encodeURIComponent(k('mid')), 'admin', { scope: 'layer', layer: { palette: { value: 'cold' } }, revision: 7, at: k('mid') });
  assert.equal(dead.status, 400);
  assert.match((await dead.json()).error, /no task's path goes through it/);
  assert.equal((await call(api + '&node=' + encodeURIComponent(k('mid')), 'admin', { scope: 'page', layer: { palette: { value: 'cold' } }, revision: 7, at: k('page') })).status, 200, 'the page above it is reachable from the same node');
  assert.equal((await call(api + '&node=' + encodeURIComponent(k('c4')), 'admin', { scope: 'layer', layer: { palette: { value: 'cold' } }, revision: 8, at: k('layer2') })).status, 200, 'the real layer of Card 4 is reachable through the card');
  // The audit a worker reads is its floor's repository's: nothing of another floor, no global saves. The administrator sees everything.
  const adminAudit = (await (await call(api, 'admin')).json()).audit;
  assert.ok(adminAudit.some((a: { level: string }) => a.level === 'global') && adminAudit.length >= 8);
  assert.equal((await call('/api/harness/profile?floor=floor-b', 'admin', { scope: 'repository', layer: { own: { value: 'b' } }, revision: 9 })).status, 200);
  const workerB = await (await call('/office/harness?worker=worker-b', '', undefined, base, 'Bearer test-token')).json();
  assert.deepEqual(workerB.audit.map((a: { level: string; slots: string[] }) => [a.level, a.slots]), [['project', ['own']]], 'floor B\'s worker sees its own repository\'s save and none of floor A\'s keys, slots or accounts');
  assert.deepEqual(workerB.levels, ['global', 'project', 'page', 'layer', 'area', 'sector', 'task']);
  const workerA = await (await call('/office/harness?worker=planner', '', undefined, base, 'Bearer test-token')).json();
  assert.ok(workerA.audit.length > 0 && workerA.audit.every((a: { level: string; repo: string }) => a.level !== 'global' && a.repo === workerA.audit[0].repo), 'floor A\'s planner sees only its repository\'s saves below global');
  // The CLI sends `at` from the path it read right before saving, so a card the canvas moved in between is refused (409).
  const assignments = path.join(dir, 'assignments.json');
  writeFileSync(assignments, JSON.stringify({ revision: 10, layer: { tone: { value: 'cli' } } }));
  const env = { AGENT_OFFICE_HOOK_URL: base, AGENT_OFFICE_WORKER_ID: 'planner', AGENT_OFFICE_HOOK_TOKEN: 'test-token' };
  const previous = { ...process.env };
  Object.assign(process.env, env);
  const printed: string[] = [];
  const log = console.log;
  console.log = (line: string) => void printed.push(line);
  try {
    moveAfterRead = true;
    await assert.rejects(remoteHarness(['--assign', 'sector', assignments, '--node', k('c1')]), /canvas moved this node/);
    assert.equal((await (await call(api + '&node=' + encodeURIComponent(k('c1')), 'admin')).json()).revision, 10, 'nothing was written');
    const saved = await remoteHarness(['--assign', 'sector', assignments, '--node', k('c1')]).then(() => JSON.parse(printed.pop()!));
    assert.deepEqual(saved.effective.tone, { binding: { value: 'cli' }, scope: 'sector', node: k('sector2'), nodeName: 'Sector 2' }, 'read again, Card 1 is in Sector 2 now and the save goes there');
    assert.equal(saved.audit[0].node, k('sector2'));
    await assert.rejects(remoteHarness(['--assign', 'area', assignments, '--node', k('c4')]), /has no area on its way down the canvas/);
    await assert.rejects(remoteHarness(['--assign', 'sector', assignments]), /needs the node it is for/);
    await assert.rejects(remoteHarness(['--assign', 'sector', assignments, '--node', k('c1'), '--at', k('sector')]), /canvas moved this node/, 'an explicit --at is sent as given');
    await assert.rejects(remoteHarness(['--assign', 'repository', assignments, '--at', k('sector')]), /takes none/);
    await assert.rejects(remoteHarness(['--assign', 'sector', assignments, '--at', k('sector')]), /goes with --task ID or --node ID/);
    // The dead-end check sees through a non-canonical spelling of the key.
    const spelled = await call(api + '&node=' + encodeURIComponent('opora:p:w:m%69d'), 'admin', { scope: 'layer', layer: { palette: { value: 'cold' } }, revision: 11, at: k('mid') });
    assert.equal(spelled.status, 400);
    assert.match((await spelled.json()).error, /no task's path goes through it/);
  } finally { console.log = log; for (const key of Object.keys(env)) delete process.env[key]; Object.assign(process.env, previous); }
  // A resource that was listed and then removed is refused as missing (tombstone), not as unknown, and is never remapped.
  mkdirSync(path.join(dir, '.harness', 'rules'), { recursive: true });
  writeFileSync(path.join(dir, '.harness', 'rules', 'review.md'), 'review');
  const listed = await (await call('/api/harness?floor=floor', 'admin')).json() as { entries: { id: string; path: string; version: number }[] };
  const review = listed.entries.find((e) => e.path === 'rules/review.md')!;
  assert.equal(review.version, 1);
  // A project element names a different file in every other project, so the global layer refuses it; the repository layer takes it.
  const global = await call(api, 'admin', { ...data, layer: { rule: { resource: review.id } }, revision: 11 });
  assert.equal(global.status, 400);
  assert.match(((await global.json()) as { error: string }).error, /Project-scoped element in global layer/);
  assert.equal((await call(api, 'admin', { ...data, scope: 'repository', layer: { rule: { resource: review.id } }, revision: 11 })).status, 200);
  rmSync(path.join(dir, '.harness', 'rules', 'review.md'));
  const refused = await call(api, 'admin', { ...data, scope: 'repository', layer: { rule: { resource: review.id } }, revision: 12 });
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { error: string }).error, /missing since .*rules\/review\.md/);
  const node = (id: string) => api + '&node=' + encodeURIComponent(k(id));
  const sectorOf = (view: { path: { level: string; node: string }[] }) => view.path.find((p) => p.level === 'sector')!.node;
  // A save queued behind another office's lock is checked again under the lock, against the canvas as it is then: a card moved meanwhile is refused and nothing is written.
  const before = await (await call(node('c1'), 'admin')).json();
  const lock = file + '.lock';
  writeFileSync(lock, JSON.stringify({ token: 'other-office', pid: 0, acquiredAt: Date.now(), renewedAt: Date.now() }));
  reads = 0; moveOnRead = 2;
  const queued = call(node('c1'), 'admin', { scope: 'sector', layer: { tone: { value: 'late' } }, revision: before.revision, at: sectorOf(before) });
  await new Promise((r) => setTimeout(r, 300));
  unlinkSync(lock);
  const moved = await queued;
  assert.equal(moved.status, 409);
  assert.match((await moved.json()).error, /moved this node while the save waited/);
  assert.equal(moveOnRead, 0, 'the card was moved on the read under the lock');
  const afterMove = await (await call(node('c1'), 'admin')).json();
  assert.equal(afterMove.revision, before.revision, 'nothing was written');
  assert.notEqual(sectorOf(afterMove), sectorOf(before));
  assert.equal(afterMove.layers.sector.tone, undefined);
  // A save that committed is answered 200 with what was saved, even when the store can't be read again for the rest of the response.
  dirReads = 0; breakOnDirRead = 3;
  const committed = await call(node('c1'), 'admin', { scope: 'sector', layer: { tone: { value: 'kept' } }, revision: afterMove.revision, at: sectorOf(afterMove) });
  assert.equal(committed.status, 200);
  const kept = await committed.json();
  assert.equal(kept.revision, afterMove.revision + 1, 'the response carries the committed revision');
  assert.deepEqual(kept.layers.sector, { tone: { value: 'kept' } });
  assert.match(kept.warning, /Saved as revision \d+, but the rest of this response could not be built/);
  assert.deepEqual(kept.audit, []);
  assert.equal(breakOnDirRead, 0);
  assert.equal(readFileSync(file, 'utf8'), 'broken', 'the store really was unreadable after the commit');
  assert.equal((await call(node('c1'), 'admin')).status, 503, 'and the next read says so');
  writeFileSync(file, preserved);
  assert.equal((await (await call(node('c1'), 'admin')).json()).revision, kept.revision, 'the committed write is in the file');
  // Members read any floor's published profiles and audit (there is no member-to-floor check; this is the existing behaviour, not an access list) and still can't write.
  const memberRead = await call('/api/harness/profile?floor=floor-b', 'member');
  assert.equal(memberRead.status, 200);
  const memberView = await memberRead.json();
  assert.equal(memberView.writable, false);
  assert.ok(memberView.audit.length > 0, 'a member sees the floor\'s audit');
  assert.equal((await call('/api/harness/profile?floor=floor-b', 'member', { scope: 'repository', layer: {}, revision: memberView.revision })).status, 403);
  // A worker's `node` or `at` never reaches another project's nodes or another floor: a foreign key is refused, a wrong `at` is a 409, and nothing is written.
  const current = (await (await call(node('c2'), 'admin')).json()).revision;
  assert.equal((await call('/office/harness?worker=planner&node=' + encodeURIComponent(oporaKey({ project: 'other', workspace: 'w' }, 'c1')), '', { scope: 'task', layer: { tone: { value: 'x' } }, revision: current, at: oporaKey({ project: 'other', workspace: 'w' }, 'c1') }, base, 'Bearer test-token')).status, 403, 'a key of another project');
  assert.equal((await call('/office/harness?worker=worker-b&node=' + encodeURIComponent(k('c1')), '', undefined, base, 'Bearer test-token')).status, 400, 'floor B\'s worker cannot address floor A\'s project by its key');
  const wrongAt = await call('/office/harness?worker=planner&node=' + encodeURIComponent(k('c2')), '', { scope: 'sector', layer: { tone: { value: 'x' } }, revision: current, at: k('sector2') }, base, 'Bearer test-token');
  assert.equal(wrongAt.status, 409, 'Card 2 is in Sector, not Sector 2');
  assert.equal((await (await call(node('c2'), 'admin')).json()).revision, current, 'nothing was written');
  // Audit entries from before the repository was recorded (no `repo`) are the administrator's to see, never a worker's.
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  stored.audit.push({ at: '2026-01-01T00:00:00.000Z', revision: 0, level: 'task', node: 'old-task', by: 'account:old', slots: ['legacy'] });
  writeFileSync(file, JSON.stringify(stored));
  const oldEntry = (a: { by: string }) => a.by === 'account:old';
  assert.ok((await (await call(api, 'admin')).json()).audit.some(oldEntry), 'the administrator sees the old entry');
  assert.ok(!(await (await call('/office/harness?worker=planner', '', undefined, base, 'Bearer test-token')).json()).audit.some(oldEntry), 'the worker does not');
});

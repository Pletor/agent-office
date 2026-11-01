import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OporaBridge, type BridgeFloor } from '../src/server/opora/bridge.js';
import { describeActivity } from '../src/server/opora/live.js';
import { buildScope, cardInFocus, cleanFocus, focusLeaves, focusLine, inFocus, placeCards, toggleFocus, type CanvasNode } from '../src/shared/opora-scope.js';
import { BOARD_PICKUP, inPlanningRoom, PLANNING_ROOM } from '../src/shared/planning.js';
import { officeNav } from '../src/shared/nav.js';
import { DESKS } from '../src/shared/layout.js';
import { PROMPTS, fillPrompt } from '../src/shared/prompts.js';
import type { OporaState, WorkerInfo } from '../src/shared/protocol.js';

// Tajemství opory's architecture, cut down: the same three domains in Produkce and in Vývoj.
const NODES: CanvasNode[] = [
  { id: 'www', kind: 'sector', name: 'Veřejný web', parentId: null, env: 'Produkce', host: 'www.tajemstviopory.cz' },
  { id: 'app', kind: 'sector', name: 'Aplikace', parentId: null, env: 'Produkce', host: 'app.tajemstviopory.cz' },
  { id: 'devapp', kind: 'sector', name: 'Aplikace', parentId: null, env: 'Vývoj', host: 'app.tajemstviopory.dev' },
  { id: 'oracle', kind: 'node', name: 'Oracle', parentId: 'devapp' },
  // A subpage listed before its page: the cascade takes any order.
  { id: 'namiru', kind: 'node', name: 'Na míru', parentId: 'oracle' },
  { id: 'chat', kind: 'node', name: 'Chat', parentId: 'devapp' },
  { id: 'lost', kind: 'node', name: 'Orphan', parentId: 'gone' },
  { id: 'a1', kind: 'area', name: 'Somewhere', parentId: null },
].sort((a, b) => (a.id === 'namiru' ? -1 : b.id === 'namiru' ? 1 : 0));

test('the architecture cascades environment › domain › page › subpage', () => {
  const scope = buildScope(NODES);
  const by = new Map(scope.map((n) => [n.id, n]));
  assert.deepEqual(
    scope.filter((n) => n.level === 'env').map((n) => n.name),
    ['Produkce', 'Vývoj'],
  );
  assert.equal(by.get('devapp')?.parentId, 'env:Vývoj');
  assert.equal(by.get('devapp')?.host, 'app.tajemstviopory.dev');
  assert.equal(by.get('oracle')?.level, 'page');
  assert.equal(by.get('namiru')?.level, 'subpage');
  assert.equal(by.has('lost'), false, 'a card whose parent is not on the canvas is left out');
  assert.equal(by.has('a1'), false);
});

test('a task outside the cascade is in the focus by the nearest node above it: its sector or its page', () => {
  // Pages are marked, so tasks laid into a sector or a page stay out of the cascade itself.
  const nodes: CanvasNode[] = [
    { id: 'app', kind: 'sector', name: 'Aplikace', parentId: null, env: 'Produkce' },
    { id: 'home', kind: 'node', name: 'Přehled', parentId: 'app', page: true },
    { id: 'extra', kind: 'sector', name: 'Doplnění', parentId: null },
    { id: 'task-s', kind: 'node', name: 'Úkol v sektoru', parentId: 'extra' },
    { id: 'task-p', kind: 'node', name: 'Úkol na stránce', parentId: 'home' },
    { id: 'loose', kind: 'node', name: 'Bez sektoru', parentId: null },
  ];
  const scope = buildScope(nodes);
  const placed = placeCards(scope, nodes, ['task-s', 'task-p', 'loose', 'home']);
  assert.deepEqual([...placed], [['task-s', 'extra'], ['task-p', 'home'], ['loose', null], ['home', 'home']]);
  const card = (id: string) => ({ id, placedIn: placed.get(id) ?? undefined, unplaced: placed.get(id) === null });
  const onHome = toggleFocus(scope, [], 'home', true);
  assert.equal(cardInFocus(scope, onHome, card('task-p')), true, 'a task on the page in focus is taken');
  assert.equal(cardInFocus(scope, onHome, card('task-s')), false, 'a task in another sector is not');
  const both = toggleFocus(scope, onHome, 'extra', true);
  assert.equal(cardInFocus(scope, both, card('task-s')), true, 'switching its sector on takes it in');
  assert.equal(cardInFocus(scope, onHome, card('loose')), true, 'an unplaced card no switch can turn off');
});

test('switching on takes everything above along, off everything below; the deepest on is the focus', () => {
  const scope = buildScope(NODES);
  let focus = toggleFocus(scope, [], 'namiru', true);
  assert.deepEqual(focus.sort(), ['devapp', 'env:Vývoj', 'namiru', 'oracle'].sort());
  assert.deepEqual(focusLeaves(scope, focus), ['namiru']);
  assert.equal(focusLine(scope, focus), 'Vývoj › Aplikace (app.tajemstviopory.dev) › Oracle › Na míru');
  // Isolated to the subpage: its page's sibling and the other environment are out.
  assert.equal(inFocus(scope, focus, 'namiru'), true);
  assert.equal(inFocus(scope, focus, 'chat'), false);
  assert.equal(inFocus(scope, focus, 'app'), false);
  // Off at the page: the subpage under it goes too, and the domain is the focus.
  focus = toggleFocus(scope, focus, 'oracle', false);
  assert.deepEqual(focusLeaves(scope, focus), ['devapp']);
  assert.equal(inFocus(scope, focus, 'chat'), true);
  // Nothing on is the whole project; a node gone from the architecture is dropped.
  assert.equal(inFocus(scope, [], 'app'), true);
  assert.deepEqual(cleanFocus(scope, ['nope']), []);
  assert.equal(focusLine(scope, []), '');
});

test('the planner is told to stay in the focus, and nothing extra with none', () => {
  const vars = { goal: 'Fix the animation', file: 'f.md', base: 'http://o', project: 'p', workspace: 'w' };
  const told = fillPrompt(PROMPTS['planning.opora'].text, { ...vars, focus: 'Stay inside: Vývoj › Aplikace' });
  assert.match(told, /Stay inside: Vývoj › Aplikace/);
  // It works through Opora on the project it's given, without searching the repository for it.
  const named = fillPrompt(PROMPTS['planning.opora'].text, { ...vars, name: 'Tajemství opory', focus: '' });
  assert.match(named, /project Tajemství opory \(p\), workspace w/);
  assert.match(named, /Never search the repository/);
  assert.match(named, /in frontier/);
  assert.doesNotMatch(named, /\{\{\w+\}\}/);
  const whole = fillPrompt(PROMPTS['planning.opora'].text, { ...vars, focus: '' });
  assert.doesNotMatch(whole, /\{\{focus\}\}|Stay inside/);
  assert.match(fillPrompt(PROMPTS['planning.router'].text, { ...vars, focus: 'Stay inside: X' }), /Stay inside: X/);
});

test('what agents do on the canvas is told in words, a refused write too', () => {
  assert.equal(describeActivity('POST', '/api/desktop-v3/lease', 200), 'si bere kartu');
  assert.equal(describeActivity('POST', '/api/canvas-plan', 200), 'rozvrhl karty');
  assert.equal(describeActivity('POST', '/api/desktop-v3/lease', 409), 'si bere kartu (odmítnuto, 409)');
  assert.equal(describeActivity('DELETE', '/api/odd', 200), 'DELETE odd');
});

test('a worker fetching a card walks from its desk to the 🛰️ screen outside the cell’s glass and back, never into the room', () => {
  assert.ok(!inPlanningRoom(...BOARD_PICKUP));
  assert.ok(BOARD_PICKUP[1] < PLANNING_ROOM.minZ, 'on the outside of the north glass');
  const nav = officeNav(0);
  for (const desk of DESKS.filter((d) => !d.room && !d.planner && !d.station && !d.beanbag && !d.wing).slice(0, 6)) {
    const there = nav.wayFrom(desk, BOARD_PICKUP);
    const back = nav.wayTo(BOARD_PICKUP, desk);
    assert.deepEqual(there.at(-1), BOARD_PICKUP, `${desk.id} gets to the screen`);
    assert.ok(back.length > 1);
    assert.ok([...there, ...back].every(([x, z]) => !inPlanningRoom(x, z)), `${desk.id} stays out of the room`);
  }
});

/** An Opora with the cut-down architecture, its cards free, and an activity log. */
async function fakeOpora(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-scope-'));
  const view = NODES.map((n) => ({ id: n.id, kind: n.kind, name: n.name, parentId: n.parentId, ...(n.env ? { site: { environments: [{ name: n.env, host: n.host }] } } : {}) }));
  const cards: { id: string; name: string; pipeline: { profile: string } }[] = NODES.filter((n) => n.kind === 'node').map((n) => ({ id: n.id, name: n.name, pipeline: { profile: 'code' } }));
  let orchestrator: { by: string; owner?: string } | undefined;
  const executions = new Map<string, Record<string, unknown>>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (data: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (url.pathname === '/api/oporahub/executions/context') return send({ available: true, acceptedHead: 'a'.repeat(40), contextVersion: 'ctx' });
      if (url.pathname === '/api/oporahub/executions/claim') {
        const lease = { ...body, executionId: 'ex-' + body.nodeId, token: 'tok', epoch: 1, acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64), assignment: { contextVersion: 'ctx', documents: {} }, state: 'running', serverNow: Date.now() / 1000, expiresAt: Date.now() / 1000 + 900 };
        executions.set(lease.executionId, lease); return send(lease);
      }
      if (url.pathname.startsWith('/api/oporahub/executions/ex-')) return send(executions.get(url.pathname.split('/')[4]));
      if (url.pathname === '/') return send({});
      if (url.pathname === '/api/bootstrap') return send({ projects: [{ id: 'p1', name: 'Tajemství opory', sourcePath: dir }] });
      if (url.pathname === '/api/project-workspaces') return send({ workspaces: [{ id: 'main', label: 'main' }] });
      if (url.pathname === '/api/view') return send({ graph: { nodes: [...view, ...cards.filter((c) => !view.some((n) => n.id === c.id)).map((c) => ({ id: c.id, kind: 'node', name: c.name, parentId: 'oracle' }))] } });
      if (url.pathname === '/api/desktop-v3/frontier') return send({ frontier: url.searchParams.get('nodeId') ? cards : [] });
      if (url.pathname === '/api/activity-log') return send({ entries: [{ id: 7, at: new Date().toISOString(), actor: 'agent', agent: 'planner-1', method: 'POST', path: '/api/canvas-plan', nodeIds: ['namiru'], status: 200 }] });
      if (url.pathname === '/api/desktop-v3/lease') return send({ token: 'tok', expiresAt: '2030-01-01T00:00:00Z' });
      send({ status: 'ok' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const workers: WorkerInfo[] = [];
  let state: OporaState | undefined;
  const floor: BridgeFloor = {
    id: 'cell',
    dir,
    list: () => workers,
    stop: async id => { const worker = workers.find(w => w.id === id); if (worker) worker.status = 'exited'; },
    seat(deskId, by, prompt) {
      const w = { id: `w${workers.length}`, deskId, kind: 'agent', prompt, name: `Worker ${workers.length}`, status: 'working', createdBy: by } as WorkerInfo;
      workers.push(w);
      return w;
    },
    desks: () => ['desk-1', 'desk-2', 'desk-3'],
    deskOccupied: (d) => workers.some((w) => w.deskId === d),
    labels: () => ({}),
    orchestrator: () => orchestrator,
  };
  const make = () => new OporaBridge(floor, dir, { update: (s) => void (state = s), toast: () => undefined, prompt: (id) => PROMPTS[id].text }, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const bridges: OporaBridge[] = [];
  t.after(() => {
    bridges.forEach((b) => b.shutdown());
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    workers,
    cards,
    orchestrate: (who: { by: string; owner?: string } | undefined) => void (orchestrator = who),
    state: () => state!,
    async open() {
      const b = make();
      bridges.push(b);
      await b.poll();
      return b;
    },
  };
}

test('the cell takes only cards in its focus, by hand and on the autopilot, and keeps the focus across a restart', async (t) => {
  const f = await fakeOpora(t);
  const bridge = await f.open();
  assert.equal(f.state().scope.length, 8, '2 environments, 3 domains, 3 pages and subpages');
  assert.equal(bridge.switchFocus('namiru', true, false, 'Ana'), undefined);
  assert.match(bridge.switchFocus('nope', true, false, 'Ana')!, /isn’t in the project’s architecture/);
  assert.deepEqual(focusLeaves(f.state().scope, f.state().focus), ['namiru']);
  assert.match((await bridge.take('chat', 'Ana'))!, /outside what the cell works on/);
  bridge.setAutopilot(true, 3, 'Ana');
  await new Promise((r) => setTimeout(r, 50));
  await bridge.poll();
  // Orphan's parent isn't on the canvas: unplaced, so no switch turns it off (cardInFocus).
  assert.deepEqual(f.workers.map((w) => w.prompt?.match(/; card: ([^.]+)\./)?.[1]), ['namiru', 'lost']);
  assert.equal(bridge.focusLine(), 'Vývoj › Aplikace (app.tajemstviopory.dev) › Oracle › Na míru');
  bridge.shutdown();
  const again = await f.open();
  assert.equal(again.focusLine(), 'Vývoj › Aplikace (app.tajemstviopory.dev) › Oracle › Na míru');
});

test('a focus that left the architecture takes nothing, rather than the whole project', async (t) => {
  const f = await fakeOpora(t);
  const bridge = await f.open();
  bridge.switchFocus('namiru', true, true, 'Ana');
  // As if Na míru, Oracle and the dev domain were removed from the canvas.
  (bridge as unknown as { focus: string[] }).focus = ['gone-1', 'gone-2'];
  assert.match((await bridge.take('chat', 'Ana'))!, /isn’t in the project’s architecture any more/);
  bridge.setAutopilot(true, 3, 'Ana');
  await new Promise((r) => setTimeout(r, 50));
  await bridge.poll();
  assert.equal(f.workers.length, 0);
  assert.match(f.state().error ?? '', /switchboard/);
  // The whole project again, by hand: then it takes.
  assert.equal(bridge.switchFocus(null, false, false, 'Ana'), undefined);
  assert.equal(await bridge.take('chat', 'Ana'), undefined);
});

test('cards the orchestrator lays out go to their department at once, and cards that were there before stay put', async (t) => {
  const f = await fakeOpora(t);
  const bridge = await f.open();
  assert.equal(f.state().handOut, true, 'on by default');
  // Ready cards that were on the canvas before the orchestrator sat down aren't its.
  f.orchestrate({ by: 'Ana', owner: 'acct-ana' });
  await bridge.poll();
  assert.equal(f.workers.length, 0);
  // It lays out two cards under Oracle: both are handed out, on Ana's plan.
  f.cards.push({ id: 'anim', name: 'Fix the Na míru animation', pipeline: { profile: 'design' } }, { id: 'api', name: 'Stream the answer', pipeline: { profile: 'code' } });
  await bridge.poll();
  assert.deepEqual(f.workers.map((w) => [w.prompt?.match(/; card: ([^.]+)\./)?.[1], w.createdBy]), [['anim', 'Ana'], ['api', 'Ana']]);
  assert.deepEqual(f.state().handOutWaiting, []);
  // With the orchestrator gone, a new card waits for a person (or the autopilot).
  f.orchestrate(undefined);
  f.cards.push({ id: 'later', name: 'Later card', pipeline: { profile: 'code' } });
  await bridge.poll();
  assert.equal(f.workers.length, 2);
});

test('with hand-out off, the orchestrator’s cards wait for a person', async (t) => {
  const f = await fakeOpora(t);
  const bridge = await f.open();
  bridge.setHandOut(false, 'Ana');
  f.orchestrate({ by: 'Ana' });
  f.cards.push({ id: 'anim', name: 'Fix the animation', pipeline: { profile: 'design' } });
  await bridge.poll();
  assert.equal(f.workers.length, 0);
});

test('what the agents did on the canvas comes along for the live board', async (t) => {
  const f = await fakeOpora(t);
  const bridge = await f.open();
  await (bridge as unknown as { live: { read(): Promise<void> } }).live.read();
  assert.deepEqual(
    f.state().activity.map((e) => [e.agent, e.what, e.nodeIds]),
    [['planner-1', 'rozvrhl karty', ['namiru']]],
  );
});

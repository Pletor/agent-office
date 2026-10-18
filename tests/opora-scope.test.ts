import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OporaBridge, type BridgeFloor } from '../src/server/opora/bridge.js';
import { describeActivity } from '../src/server/opora/live.js';
import { buildScope, cleanFocus, focusLeaves, focusLine, inFocus, toggleFocus, type CanvasNode } from '../src/shared/opora-scope.js';
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

test('a worker fetching a card walks from the planning room’s board out of its door to its desk', () => {
  assert.ok(inPlanningRoom(...BOARD_PICKUP));
  const desk = DESKS.find((d) => !d.room && !d.planner && !d.station && !d.beanbag && !d.wing)!;
  const way = officeNav(0).wayTo(BOARD_PICKUP, desk);
  assert.ok(way.length > 2);
  // Out through the doorway in the east glass, not through the glass.
  const R = PLANNING_ROOM;
  const out = way.findIndex((p) => !inPlanningRoom(p[0], p[1]));
  assert.ok(out > 0);
  const [x0, z0] = way[out - 1];
  const [x1, z1] = way[out];
  const t = (R.maxX - x0) / (x1 - x0);
  const z = z0 + t * (z1 - z0);
  assert.ok(x1 > R.maxX - 0.01 && z > R.door.z0 && z < R.door.z1, `leaves at z=${z.toFixed(2)}`);
});

/** An Opora with the cut-down architecture, its cards free, and an activity log. */
async function fakeOpora(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-scope-'));
  const view = NODES.map((n) => ({ id: n.id, kind: n.kind, name: n.name, parentId: n.parentId, ...(n.env ? { site: { environments: [{ name: n.env, host: n.host }] } } : {}) }));
  const cards = NODES.filter((n) => n.kind === 'node').map((n) => ({ id: n.id, name: n.name, pipeline: { profile: 'code' } }));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (data: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    req.resume();
    req.on('end', () => {
      if (url.pathname === '/') return send({});
      if (url.pathname === '/api/bootstrap') return send({ projects: [{ id: 'p1', name: 'Tajemství opory', sourcePath: dir }] });
      if (url.pathname === '/api/project-workspaces') return send({ workspaces: [{ id: 'main', label: 'main' }] });
      if (url.pathname === '/api/view') return send({ graph: { nodes: view } });
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
    seat(deskId, by, prompt) {
      const w = { id: `w${workers.length}`, deskId, kind: 'agent', prompt, name: `Worker ${workers.length}`, status: 'working', createdBy: by } as WorkerInfo;
      workers.push(w);
      return w;
    },
    desks: () => ['desk-1', 'desk-2', 'desk-3'],
    deskOccupied: (d) => workers.some((w) => w.deskId === d),
    labels: () => ({}),
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
  assert.deepEqual(f.workers.map((w) => w.prompt?.match(/"([^"]+)" in the sector/)?.[1]), ['Na míru']);
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

test('what the agents did on the canvas comes along for the live board', async (t) => {
  const f = await fakeOpora(t);
  const bridge = await f.open();
  await (bridge as unknown as { live: { read(): Promise<void> } }).live.read();
  assert.deepEqual(
    f.state().activity.map((e) => [e.agent, e.what, e.nodeIds]),
    [['planner-1', 'rozvrhl karty', ['namiru']]],
  );
});

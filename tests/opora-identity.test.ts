// Opora's identity contract as the office reads it (docs/opora-identity.md): every level of the
// hierarchy is a real Opora id, nested sectors keep their real parent, and a focus switched on in one
// project or workspace never carries over to another that happens to use the same node ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ancestry, buildScope, inFocus, toggleFocus, type CanvasNode } from '../src/shared/opora-scope.js';
import { areaOf, focusIntact, oporaKey, OPORA_IDENTITY_VERSION, OPORA_LEVELS, parseOporaKey, refuseForeign } from '../src/shared/opora-identity.js';
import { oporaHarnessTask } from '../src/shared/harness-cascade.js';
import { OporaBridge, type BridgeFloor } from '../src/server/opora/bridge.js';
import { PROMPTS } from '../src/shared/prompts.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

// The Harness plan as it sits on the canvas: a root sector (the application) › a page › layers ›
// sectors nested under each layer › their tasks, with an area beside a sector that is only visual.
const HARNESS: CanvasNode[] = [
  { id: 'office', kind: 'sector', name: 'Agent-office', parentId: null, env: 'Produkce', host: 'localhost:4600' },
  { id: 'library', kind: 'node', name: 'Knihovna Harness', parentId: 'office' },
  { id: 'docs', kind: 'node', name: 'Knihovna Docs', parentId: 'office' },
  { id: 'layer1', kind: 'node', name: '[vrstva 01] Model a propojení', parentId: 'library' },
  { id: 'layer5', kind: 'node', name: '[vrstva 05] Router', parentId: 'library' },
  // Nested sectors listed before their layer: the cascade takes any order.
  { id: 's011', kind: 'sector', name: '01.1 Identita a hierarchie', parentId: 'layer1' },
  { id: 's051', kind: 'sector', name: '05.1 Dva režimy', parentId: 'layer5' },
  { id: 'h01', kind: 'node', name: '[task] H01', parentId: 's011' },
  { id: 'h17', kind: 'node', name: '[task] H17', parentId: 's051' },
  { id: 'd1', kind: 'node', name: '[task] Docs card', parentId: 'docs' },
  { id: 'area1', kind: 'area', name: 'Oblast: Identita', parentId: 'layer1' },
];

test('nested sector under layer/page preserves ancestry and isolation', () => {
  const scope = buildScope(HARNESS);
  const by = new Map(scope.map((n) => [n.id, n]));
  // (a) The nested sector keeps its real parent: H01 sits under the page, so switching the page on takes it.
  assert.equal(by.get('s011')?.parentId, 'layer1', 'a nested sector is not torn out to a root domain');
  assert.deepEqual(ancestry(scope, 'h01'), ['h01', 's011', 'layer1', 'library', 'office', 'env:Produkce']);
  assert.equal(by.get('office')?.level, 'domain', 'only a sector without a parent is a root domain');
  assert.equal(scope.filter((n) => n.level === 'domain').length, 1);
  const page = toggleFocus(scope, [], 'library', true);
  assert.equal(inFocus(scope, page, 'h01'), true);
  // (b) A sibling page and another layer outside the focus stay outside.
  assert.equal(inFocus(scope, page, 'd1'), false);
  const layer = toggleFocus(scope, [], 'layer1', true);
  assert.equal(inFocus(scope, layer, 'h01'), true);
  assert.equal(inFocus(scope, layer, 'h17'), false);
  // An area is never a parent, so it is never a level of the cascade.
  assert.equal(by.has('area1'), false);
});

test('moving a sector under another page re-reads its ancestry, and a vanished parent drops its subtree', () => {
  const moved = HARNESS.map((n) => (n.id === 's011' ? { ...n, parentId: 'docs' } : n));
  const scope = buildScope(moved);
  const focus = toggleFocus(buildScope(HARNESS), [], 'library', true);
  // The focus on the library page no longer covers H01: it's under Docs now, not remapped back.
  assert.equal(inFocus(scope, focus, 'h01'), false);
  assert.deepEqual(ancestry(scope, 'h01').slice(0, 3), ['h01', 's011', 'docs']);
  // ...and the focus doesn't mean what it meant, so it isn't intact any more.
  assert.equal(focusIntact(buildScope(HARNESS), focus), true);
  assert.equal(focusIntact(scope, toggleFocus(buildScope(HARNESS), [], 's011', true)), false);
  // The layer gone from the canvas: its nested sector and task leave the architecture, not lifted to a root,
  // and a focus on the sector is broken rather than widened to the page that's left.
  const gone = buildScope(HARNESS.filter((n) => n.id !== 'layer1'));
  assert.equal(gone.some((n) => n.id === 's011' || n.id === 'h01'), false);
  assert.equal(focusIntact(gone, toggleFocus(buildScope(HARNESS), [], 's011', true)), false);
  assert.equal(focusIntact(gone, toggleFocus(buildScope(HARNESS), [], 'docs', true)), true, 'a focus elsewhere is untouched');
});

test('a parent cycle or a dangling parent is left out rather than guessed', () => {
  const scope = buildScope([
    ...HARNESS,
    { id: 'c1', kind: 'sector', name: 'Loop A', parentId: 'c2' },
    { id: 'c2', kind: 'node', name: 'Loop B', parentId: 'c1' },
    { id: 'orphan', kind: 'sector', name: 'Orphan', parentId: 'missing' },
    { id: 'in-area', kind: 'node', name: 'In an area', parentId: 'area1' },
  ]);
  for (const id of ['c1', 'c2', 'orphan', 'in-area']) assert.equal(scope.some((n) => n.id === id), false, id);
});

test('the canonical key holds the project and workspace, and another one is refused, not remapped', () => {
  assert.equal(OPORA_IDENTITY_VERSION, 1);
  assert.deepEqual([...OPORA_LEVELS], ['global', 'project', 'page', 'layer', 'area', 'sector', 'task']);
  const here = { project: 'p1', workspace: 'draft' };
  const key = oporaKey(here, 'h01');
  assert.equal(key, 'opora:p1:draft:h01');
  assert.equal(oporaHarnessTask('p1', 'draft', 'h01'), key, 'the Harness task id is the same key');
  assert.deepEqual(parseOporaKey(oporaKey({ project: 'a:b', workspace: 'w x' }, 'n')), { project: 'a:b', workspace: 'w x', nodeId: 'n' });
  for (const bad of ['opora:p1:draft', 'opora:p1::h01', 'x:p1:draft:h01', 'opora:%E0:w:n']) assert.equal(parseOporaKey(bad), undefined, bad);
  assert.equal(refuseForeign(here, key), undefined);
  assert.match(refuseForeign(here, oporaKey({ project: 'p2', workspace: 'draft' }, 'h01'))!, /another Opora project/);
  assert.match(refuseForeign(here, oporaKey({ project: 'p1', workspace: 'main' }, 'h01'))!, /another workspace/);
  assert.match(refuseForeign(here, 'h01')!, /Not an Opora key/);
});

test('an area is a node’s only when Opora says so, never from where it is drawn', () => {
  const nodes = [
    ...HARNESS,
    { id: 's012', kind: 'sector', name: '01.2', parentId: 'layer1', memberOf: 'area1' },
    { id: 's052', kind: 'sector', name: '05.2', parentId: 'layer5', memberOf: 'area1' },
    { id: 's053', kind: 'sector', name: '05.3', parentId: 'layer5', memberOf: 'h17' },
  ];
  assert.equal(areaOf(nodes, 's012'), 'area1');
  assert.equal(areaOf(nodes, 's011'), undefined, 'no memberOf, no area');
  assert.equal(areaOf(nodes, 's052'), undefined, 'an area under another parent is not its');
  assert.equal(areaOf(nodes, 's053'), undefined, 'only an area can hold members');
  assert.equal(areaOf(nodes, 'nope'), undefined);
});

/** One Opora project with two workspaces, and another project, all with the same node ids. */
async function twoPlaces(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-identity-'));
  const view = HARNESS.map((n) => ({ id: n.id, kind: n.kind, name: n.name, parentId: n.parentId, ...(n.env ? { site: { environments: [{ name: n.env, host: n.host }] } } : {}) }));
  const cards = HARNESS.filter((n) => n.name.startsWith('[task]')).map((n) => ({ id: n.id, name: n.name, pipeline: { profile: 'code' } }));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (data: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    req.resume();
    req.on('end', () => {
      if (url.pathname === '/api/bootstrap') return send({ projects: [{ id: 'p1', name: 'Agent office', sourcePath: dir }, { id: 'p2', name: 'Other', sourcePath: path.join(dir, 'other') }] });
      if (url.pathname === '/api/project-workspaces') return send({ workspaces: [{ id: 'main', label: 'main' }, { id: 'draft', label: 'draft' }] });
      if (url.pathname === '/api/view') return send({ graph: { nodes: view } });
      if (url.pathname === '/api/desktop-v3/frontier') return send({ frontier: url.searchParams.get('nodeId') ? cards : [] });
      if (url.pathname === '/api/desktop-v3/lease') return send({ token: 'tok', expiresAt: '2030-01-01T00:00:00Z' });
      send({ status: 'ok', entries: [] });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const workers: WorkerInfo[] = [];
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
    orchestrator: () => undefined,
  };
  const open = () => new OporaBridge(floor, dir, { update: () => undefined, toast: () => undefined, prompt: (id) => PROMPTS[id].text }, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const bridges = [open()];
  t.after(() => {
    for (const b of bridges) b.shutdown();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await bridges[0].poll();
  /** The office restarted: a new bridge on the same folder, from what the last one saved. */
  const restart = async () => {
    bridges.at(-1)!.shutdown();
    bridges.push(open());
    await bridges.at(-1)!.poll();
    return bridges.at(-1)!;
  };
  return { bridge: bridges[0], workers, restart };
}

test('a focus switched on in one workspace takes nothing in another with the same node ids', async (t) => {
  const { bridge, workers } = await twoPlaces(t);
  assert.equal(bridge.view().workspace, 'main');
  // The page switched on: H01, nested under it, is in the focus (R1: it used to be “outside what the cell works on”).
  assert.equal(bridge.switchFocus('library', true, true, 'Ana'), undefined);
  assert.equal(bridge.view().scope.find((n) => n.id === 's011')?.parentId, 'layer1');
  // In the draft workspace the same ids are other cards: the focus from main isn't carried over.
  assert.equal(bridge.useWorkspace('draft'), undefined);
  await bridge.poll();
  assert.match((await bridge.take('h01', 'Ana'))!, /switched on in another workspace/);
  assert.match(bridge.view().error ?? '', /another workspace/);
  assert.equal(workers.length, 0);
  // Switched on again there, it takes H01; a sibling page's card stays out.
  assert.equal(bridge.switchFocus('library', true, false, 'Ana'), undefined);
  assert.deepEqual(bridge.view().focus.sort(), ['env:Produkce', 'library', 'office']);
  assert.match((await bridge.take('d1', 'Ana'))!, /outside what the cell works on/);
  assert.equal(await bridge.take('h01', 'Ana'), undefined);
  assert.equal(workers.length, 1);
});

test('a focus switched on in one project is dropped when the floor is linked to another with the same node ids', async (t) => {
  const { bridge, workers } = await twoPlaces(t);
  assert.equal(bridge.view().project?.id, 'p1');
  assert.equal(bridge.switchFocus('layer5', true, true, 'Ana'), undefined);
  assert.match((await bridge.take('h01', 'Ana'))!, /outside what the cell works on/);
  // Another project: its h01 is another card, so p1's focus neither applies there nor blocks it.
  assert.equal(bridge.link('p2'), undefined);
  await bridge.poll();
  assert.equal(bridge.view().project?.id, 'p2');
  assert.deepEqual(bridge.view().focus, []);
  assert.equal(bridge.view().error, undefined);
  assert.equal(await bridge.take('h01', 'Ana'), undefined);
  assert.equal(workers.length, 1);
  // Linked back to p1, the old focus isn't revived either: the cell starts on the whole project.
  assert.match(bridge.link('p1')!, /The office is on 1 card/, 'a held card keeps the floor on its project');
});

test('where a focus was switched on survives a restart, so it is still refused in another workspace', async (t) => {
  const { bridge, workers, restart } = await twoPlaces(t);
  assert.equal(bridge.switchFocus('library', true, true, 'Ana'), undefined);
  assert.equal(bridge.useWorkspace('draft'), undefined);
  const again = await restart();
  assert.equal(again.view().workspace, 'draft');
  assert.match((await again.take('h01', 'Ana'))!, /switched on in another workspace/);
  assert.equal(workers.length, 0);
  // Back on the workspace it was switched on in, the same focus takes H01 again after the restart.
  assert.equal(again.useWorkspace('main'), undefined);
  await again.poll();
  assert.equal(await again.take('h01', 'Ana'), undefined);
  assert.equal(workers.length, 1);
});

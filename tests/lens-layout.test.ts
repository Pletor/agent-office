// The Lens diagram's layout (src/client/features/lens/layout.ts): pure, so no DOM here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutLens, K, type LensLayout } from '../src/client/features/lens/layout.ts';
import { lensGraph } from '../src/shared/opora-lens.ts';

const node = (id: string, lane: string, delta = 'added') => ({ id, label: id.toUpperCase(), kind: 'ui', delta, lane });
const pairs: [string, string, string][] = [
  ['insp', 'sec', 'otevře sekci'], ['sec', 'route', 'fetch'], ['route', 'floors', 'najde projekt'], ['route', 'reader', 'čte'], ['reader', 'review', 'PR + mapa'],
  ['reader', 'plan', 'plán'], ['reader', 'clean', 'ořízne'], ['route', 'sec', 'reply'], ['sec', 'dg', 'nakreslí'], ['dg', 'clean', 'import'], ['insp', 'review', 'přes dva řádky'],
];
const graph = lensGraph({
  kind: 'graph', title: 'T',
  lanes: [{ id: 'web', label: 'Web' }, { id: 'srv', label: 'Server' }, { id: 'ext', label: 'Opora' }],
  nodes: [node('insp', 'web', 'modified'), node('sec', 'web'), node('dg', 'web'), node('route', 'srv'), node('floors', 'srv', 'unchanged'), node('reader', 'srv'), node('clean', 'srv'), node('review', 'ext', 'unchanged'), node('plan', 'ext', 'unchanged')],
  edges: [
    ...pairs.map(([from, to, label], i) => ({ id: `e${i}`, from, to, label, kind: 'call', delta: from === 'route' && to === 'floors' ? 'unchanged' : 'added' })),
    { id: 'code', from: 'dg', to: 'insp', label: 'kód', kind: 'dependency', delta: 'unchanged', emphasis: 'muted' },
  ],
  flows: [{ title: 'F', steps: [{ from: 'reader', to: 'review' }, { from: 'sec', to: 'route' }] }],
})!;
const opts = { code: false, changed: false, files: false };

function check(L: LensLayout) {
  for (const e of L.edges) {
    assert.ok(e.d.startsWith('M') && e.pts.length >= 4, `edge ${e.e.from}→${e.e.to} has a path`);
    for (const [x, y] of e.pts) assert.ok(Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= L.W && y >= 0 && y <= L.H, 'inside the diagram');
  }
  // One track per edge per gap: no two first runs (where labels sit) share a track; tracks are a full TRACK apart.
  const ys = L.edges.map((e) => e.label.y).sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= K.TRACK - 0.01, 'labels never share a track');
  assert.equal(new Set(L.edges.map((e) => `${e.corridor}:${e.track}`)).size, L.edges.length);
  for (const a of L.nodes) for (const b of L.nodes) {
    if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'cards overlap');
  }
}

test('the layout: 3 columns from 370 px, 2 below, every edge with a path, labels on their own tracks', () => {
  const wide = layoutLens(graph, 400, opts);
  assert.equal(wide.cols, 3);
  assert.equal(wide.edges.length, 11, 'the code edge is off by default');
  assert.equal(wide.bands.length, 3);
  check(wide);
  const narrow = layoutLens(graph, 270, opts);
  assert.equal(narrow.cols, 2);
  check(narrow);
  assert.ok(narrow.nodes.every((n) => n.x + n.w <= 270));
  const code = layoutLens(graph, 400, { ...opts, code: true, files: true });
  assert.equal(code.edges.length, 12);
  assert.equal(code.nodes[0].h, K.CARD + K.FILE);
  check(code);
});

test('cards are ordered by the flows first, then the spec', () => {
  const L = layoutLens(graph, 400, opts);
  const order = (lane: string) => L.nodes.filter((n) => n.lane.id === lane).sort((a, b) => a.row - b.row || a.col - b.col).map((n) => n.n.id);
  assert.deepEqual(order('srv'), ['reader', 'route', 'floors', 'clean']);
  assert.deepEqual(order('web'), ['sec', 'insp', 'dg']);
});

test('the layout is deterministic', () => {
  for (const W of [300, 420]) assert.equal(JSON.stringify(layoutLens(graph, W, opts)), JSON.stringify(layoutLens(graph, W, opts)));
});

test('"Jen změny" keeps changed cards and the ends of changed edges', () => {
  const L = layoutLens(graph, 400, { ...opts, changed: true });
  const ids = new Set(L.nodes.map((n) => n.n.id));
  assert.ok(ids.has('review') && ids.has('plan'), 'ends of changed edges stay (as ghosts)');
  assert.ok(!ids.has('floors'), 'an unchanged card with only an unchanged edge goes');
  assert.equal(L.hidden, 1);
  assert.ok(L.nodes.find((n) => n.n.id === 'review')!.ghost);
  check(L);
});

test('an empty graph lays out to nothing, without failing', () => {
  const L = layoutLens({ title: 't', lanes: [], edges: [], flows: [], truncated: false }, 300, opts);
  assert.equal(L.nodes.length, 0);
  assert.equal(L.edges.length, 0);
});

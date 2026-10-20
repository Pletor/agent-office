import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessDeadEnd, harnessPath, harnessTarget, type HierarchyNode } from '../src/shared/harness-hierarchy.js';
import { oporaKey } from '../src/shared/opora-identity.js';

const place = { project: 'p', workspace: 'w' };
const k = (id: string) => oporaKey(place, id);
/** The Harness plan as Opora draws it: root sector › page › layer › (area beside) sector › task. */
const PLAN: HierarchyNode[] = [
  { id: 'root', kind: 'sector', name: 'Agent-office', parentId: null },
  { id: 'page', kind: 'node', name: 'Knihovna Harness', parentId: 'root' },
  { id: 'layer', kind: 'node', name: '[vrstva 01]', parentId: 'page' },
  { id: 'area', kind: 'area', name: 'Oblast: Identita', parentId: 'layer' },
  { id: 'area-elsewhere', kind: 'area', name: 'Oblast jinde', parentId: 'page' },
  { id: 'sector', kind: 'sector', name: '01.1', parentId: 'layer', memberOf: 'area' },
  { id: 'sector2', kind: 'sector', name: '01.2', parentId: 'layer', memberOf: 'area-elsewhere' },
  { id: 'h01', kind: 'node', name: 'H01', parentId: 'sector' },
  { id: 'h02', kind: 'node', name: 'H02', parentId: 'sector' },
  { id: 'sub', kind: 'node', name: 'Sub-card of H02', parentId: 'h02' },
  { id: 'h03', kind: 'node', name: 'H03', parentId: 'sector2' },
  { id: 'loose', kind: 'node', name: 'Card under the page', parentId: 'page' },
  { id: 'deep', kind: 'node', name: 'Extra level', parentId: 'layer' },
  { id: 'deep-sector', kind: 'sector', name: '01.9', parentId: 'deep' },
  { id: 'h99', kind: 'node', name: 'H99', parentId: 'deep-sector' },
  { id: 'orphan', kind: 'node', name: 'Orphan', parentId: 'gone' },
];

test('a task’s path goes down page › layer › area › sector › task, from the canvas’s real parents and memberOf', () => {
  assert.deepEqual(harnessPath(PLAN, place, 'h02'), [
    { level: 'page', node: k('page'), name: 'Knihovna Harness' },
    { level: 'layer', node: k('layer'), name: '[vrstva 01]' },
    { level: 'area', node: k('area'), name: 'Oblast: Identita' },
    { level: 'sector', node: k('sector'), name: '01.1' },
    { level: 'task', node: k('h02'), name: 'H02' },
  ]);
  // Siblings share everything above them and differ at the task.
  assert.deepEqual(harnessPath(PLAN, place, 'h01').slice(0, 4), harnessPath(PLAN, place, 'h02').slice(0, 4));
  assert.notDeepEqual(harnessPath(PLAN, place, 'h01')[4], harnessPath(PLAN, place, 'h02')[4]);
  assert.equal(harnessPath(PLAN, place, 'h02')[4].level, 'task', 'a card under a sector is the task even with a sub-card');
});

test('a card between the page and the layers is a dead end for a save; pages, layers, areas, sectors and cards are not', () => {
  const mid: HierarchyNode[] = [...PLAN, { id: 'mid', kind: 'node', name: 'Mid', parentId: 'page' }, { id: 'layer-b', kind: 'node', name: '[vrstva 02]', parentId: 'mid' }, { id: 'sector-b', kind: 'sector', name: '02.1', parentId: 'layer-b' }, { id: 'h20', kind: 'node', name: 'H20', parentId: 'sector-b' }];
  assert.match(harnessDeadEnd(mid, 'mid')!, /no task's path goes through it/);
  assert.deepEqual(harnessPath(mid, place, 'mid').map((p) => p.level), ['page', 'layer'], 'addressed by itself it looks like a layer, which is why the save must be refused');
  assert.deepEqual(harnessPath(mid, place, 'h20').map((p) => [p.level, p.node]), [['page', k('page')], ['layer', k('layer-b')], ['sector', k('sector-b')], ['task', k('h20')]], 'the task under it goes through the page and the real layer, never through Mid');
  for (const id of ['page', 'layer', 'area', 'sector', 'h02', 'sub', 'loose', 'deep', 'root', 'orphan', 'nope', 'layer-b']) assert.equal(harnessDeadEnd(mid, id), undefined, `${id} is reachable`);
  const leafUnderMid: HierarchyNode[] = [...mid, { id: 'leaf', kind: 'node', name: 'Leaf', parentId: 'mid' }];
  assert.equal(harnessDeadEnd(leafUnderMid, 'mid'), undefined, 'a leaf card right under it makes Mid its layer');
});

test('an area counts only when Opora says the sector is a member of it under the same parent', () => {
  const h03 = harnessPath(PLAN, place, 'h03');
  assert.deepEqual(h03.map((p) => p.level), ['page', 'layer', 'sector', 'task'], 'an area under another parent is not the sector’s');
  const member = PLAN.map((n) => (n.id === 'h02' ? { ...n, memberOf: 'x' } : n));
  assert.deepEqual(harnessPath(member, place, 'h02').map((p) => p.level), ['page', 'layer', 'area', 'sector', 'task'], 'the sector’s area wins; a card’s bogus memberOf changes nothing');
});

test('nodes above the sector are the page and the layer; what’s between them has no level; a root sector is the project', () => {
  assert.deepEqual(harnessPath(PLAN, place, 'h99').map((p) => [p.level, p.node]), [['page', k('page')], ['layer', k('deep')], ['sector', k('deep-sector')], ['task', k('h99')]]);
  assert.deepEqual(harnessPath(PLAN, place, 'loose').map((p) => [p.level, p.node]), [['page', k('page')], ['task', k('loose')]], 'a card right under the page has no layer or sector');
  assert.deepEqual(harnessPath(PLAN, place, 'root'), [], 'a root sector adds nothing to the project level');
  assert.deepEqual(harnessPath(PLAN, place, 'page').map((p) => p.level), ['page'], 'a page addressed is a page, not a task');
  assert.deepEqual(harnessPath(PLAN, place, 'sector').map((p) => p.level), ['page', 'layer', 'area', 'sector']);
  assert.deepEqual(harnessPath(PLAN, place, 'area').map((p) => [p.level, p.node]), [['page', k('page')], ['layer', k('layer')], ['area', k('area')]], 'an area addressed by its key is its own area level');
  assert.deepEqual(harnessPath(PLAN, place, 'sub').map((p) => [p.level, p.node]), [['page', k('page')], ['layer', k('layer')], ['area', k('area')], ['sector', k('sector')], ['task', k('sub')]], 'a card under a card under the sector is the task; the card between has no level');
  const cards = [{ id: 's', kind: 'sector', name: 'Shop', parentId: null }, { id: 'c', kind: 'node', name: 'Cart', parentId: 's' }];
  assert.deepEqual(harnessPath(cards, place, 'c'), [{ level: 'task', node: k('c'), name: 'Cart' }], 'a card under a root sector is a task of the project');
});

test('a node the canvas does not have, or whose parent is gone, is a task on its own, and a cycle stops', () => {
  assert.deepEqual(harnessPath(PLAN, place, 'nope'), [{ level: 'task', node: k('nope') }]);
  assert.deepEqual(harnessPath(PLAN, place, 'orphan'), [{ level: 'task', node: k('orphan'), name: 'Orphan' }]);
  const loop = [{ id: 'a', kind: 'node', name: 'A', parentId: 'b' }, { id: 'b', kind: 'node', name: 'B', parentId: 'a' }];
  assert.deepEqual(harnessPath(loop, place, 'a').map((p) => p.level), ['page', 'layer'], 'each has a child, so neither is a task');
});

test('what a caller addresses: a key of this place is placed on the canvas, a foreign key is refused, a custom id is a task', () => {
  assert.deepEqual(harnessTarget(PLAN, place, k('h02')).map((p) => p.level), ['page', 'layer', 'area', 'sector', 'task']);
  assert.deepEqual(harnessTarget(PLAN, place, 'custom-task'), [{ level: 'task', node: 'custom-task' }]);
  assert.deepEqual(harnessTarget(PLAN, place, ''), []);
  assert.throws(() => harnessTarget(PLAN, place, oporaKey({ project: 'q', workspace: 'w' }, 'h02')), /another Opora project/);
  assert.throws(() => harnessTarget(PLAN, place, oporaKey({ project: 'p', workspace: 'draft' }, 'h02')), /another workspace/);
  assert.deepEqual(harnessTarget(PLAN, undefined, k('h02')), [{ level: 'task', node: k('h02') }], 'with no linked project a key is a task id, as before');
});

test('a root sector is the project’s domain: its own area membership gives its cards no area, while an area nobody is a member of is still its own area', () => {
  const canvas: HierarchyNode[] = [
    { id: 'root', kind: 'sector', name: 'Shop', parentId: null, memberOf: 'root-area' },
    { id: 'root-area', kind: 'area', name: 'Root area', parentId: null },
    { id: 'card', kind: 'node', name: 'Card', parentId: 'root' },
    { id: 'page', kind: 'node', name: 'Page', parentId: 'root' },
    { id: 'orphan-area', kind: 'area', name: 'Orphan area', parentId: 'page' },
    { id: 'sector', kind: 'sector', name: 'Sector', parentId: 'page' },
    { id: 'h1', kind: 'node', name: 'H1', parentId: 'sector' },
  ];
  assert.deepEqual(harnessPath(canvas, place, 'card'), [{ level: 'task', node: k('card'), name: 'Card' }], 'a card under a root sector has only the project above it: the root sector’s memberOf sets no area');
  assert.deepEqual(harnessPath(canvas, place, 'h1').map((p) => p.level), ['page', 'sector', 'task'], 'a sector that is a member of nothing has no area, whatever the root sector is a member of');
  assert.deepEqual(harnessPath(canvas, place, 'orphan-area'), [{ level: 'page', node: k('page'), name: 'Page' }, { level: 'area', node: k('orphan-area'), name: 'Orphan area' }], 'an area without members is the area of its own path, so a layer can be saved there before any sector joins it');
  assert.deepEqual(harnessPath(canvas, place, 'root'), [], 'the root sector itself is the project');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHarnessCanvas, type GeometryNode } from '../src/shared/harness-canvas.js';
import { harnessPath } from '../src/shared/harness-hierarchy.js';
import { HarnessProfiles } from '../src/server/harness/profiles.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const node = (id: string, kind: GeometryNode['kind'], parentId: string | null, extra: Partial<GeometryNode> = {}): GeometryNode => ({ id, kind, parentId, name: id, x: 0, y: 0, ...extra });
const place = { project: 'p', workspace: 'w' };
function graph() {
  return [node('domain', 'sector', null), node('page', 'node', 'domain'), node('layer', 'node', 'page'),
    node('area', 'area', 'layer', { size: { w: 800, h: 600 } }), node('sector', 'sector', 'layer', { memberOf: 'area' }), node('card', 'node', 'sector')];
}
test('the original seven-level resolver uses current canonical Canvas area membership', () => {
  const nodes = parseHarnessCanvas({ graph: { nodes: graph() } });
  const chain = harnessPath(nodes, place, 'card');
  assert.deepEqual(chain.map(n => n.level), ['page', 'layer', 'area', 'sector', 'task']);
  assert.deepEqual(chain.map(n => n.node), ['page', 'layer', 'area', 'sector', 'card'].map(id => 'opora:p:w:' + id));
});
test('explicit membership survives layout changes and missing membership never guesses from geometry', () => {
  const rows = graph();
  rows.find(n => n.id === 'sector')!.x = 9000;
  assert.equal(parseHarnessCanvas({ graph: { nodes: rows } }).find(n => n.id === 'sector')!.memberOf, 'area');
  delete rows.find(n => n.id === 'sector')!.memberOf;
  rows.find(n => n.id === 'sector')!.x = 0;
  assert.equal(parseHarnessCanvas({ graph: { nodes: rows } }).find(n => n.id === 'sector')!.memberOf, undefined);
  assert.equal(harnessPath(parseHarnessCanvas({ graph: { nodes: rows } }), place, 'card').some(n => n.level === 'area'), false);
});
test('invalid explicit memberships fail closed instead of falling back to geometry', () => {
  for (const target of ['missing', 'card', 'sector', null, 3, '']) {
    const rows = graph();
    (rows.find(n => n.id === 'sector')! as unknown as Record<string, unknown>).memberOf = target;
    assert.throws(() => parseHarnessCanvas({ graph: { nodes: rows } }));
  }
  const rows = graph(); rows.find(n => n.id === 'area')!.parentId = 'page';
  assert.throws(() => parseHarnessCanvas({ graph: { nodes: rows } }));
  const areas = graph(); areas.find(n => n.id === 'area')!.memberOf = 'area';
  assert.throws(() => parseHarnessCanvas({ graph: { nodes: areas } }));
});
test('comments do not reclassify a task; broken parents, cycles and duplicate IDs fail closed', () => {
  const single = node('task', 'node', null);
  const parsed = parseHarnessCanvas({ graph: { nodes: [single, { id: 'note', kind: 'comment', parentId: 'task' }] } });
  assert.deepEqual(harnessPath(parsed, place, 'task').map(n => n.level), ['task']);
  for (const nodes of [[single, single], [{ ...single, parentId: 'missing' }], [{ ...single, parentId: 'task' }]]) {
    assert.throws(() => parseHarnessCanvas({ graph: { nodes } }));
  }
});
test('all seven scopes preserve origins, isolate siblings, disable and restore inheritance', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-hierarchy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new HarnessProfiles(dir), chain = harnessPath(parseHarnessCanvas({ graph: { nodes: graph() } }), place, 'card');
  let view = await store.save('/repo', [], 'global', { quality: { resource: 'guide:testing' } }, 0);
  view = await store.save('/repo', [], 'repository', { language: { value: 'cs' } }, view.revision);
  for (const item of chain) view = await store.save('/repo', chain.slice(0, chain.indexOf(item) + 1), item.level, { [item.level]: { value: item.node } }, view.revision);
  assert.equal(view.effective.page.scope, 'page'); assert.equal(view.effective.area.node, 'opora:p:w:area');
  assert.equal(Object.keys(view.layers).length, 7);
  view = await store.save('/repo', chain, 'task', { quality: null }, view.revision);
  assert.equal(view.effective.quality.binding, null);
  assert.equal(store.view('/repo', 'other').effective.page, undefined);
  view = await store.save('/repo', chain, 'task', {}, view.revision);
  assert.equal(view.effective.quality.scope, 'global');
  assert.equal(new HarnessProfiles(dir).view('/repo', chain).revision, view.revision);
});
test('an explicit v1 store lifts a former task assignment without discarding legacy bytes', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-lift-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new HarnessProfiles(dir);
  await store.save('/repo', 'opora:p:w:page', 'task', { quality: { resource: 'guide:testing' } }, 0);
  const file = path.join(dir, 'harness-profiles.json');
  const raw = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8')); raw.version = 1;
  delete raw.legacyTasks; writeFileSync(file, JSON.stringify(raw));
  const chain = harnessPath(parseHarnessCanvas({ graph: { nodes: graph() } }), place, 'card');
  assert.equal(store.view('/repo', chain).effective.quality.scope, 'page');
  await store.save('/repo', chain, 'page', { quality: null }, raw.revision);
  assert.equal(store.view('/repo', chain).effective.quality.scope, 'page');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessProfiles, HARNESS_STORE_VERSION, parseHarnessLayer } from '../src/server/harness/profiles.js';
import { harnessHandoff, harnessPlannerBrief } from '../src/server/harness/handoff.js';
import { HARNESS_LEVELS, harnessLevel, oporaHarnessTask, resolveHarness, type HarnessLevel, type HarnessPath } from '../src/shared/harness-cascade.js';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-cascade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new HarnessProfiles(dir) };
}
/** The way down to a task through every level, each node keyed like Opora does (project p, workspace w). */
const key = (id: string) => oporaHarnessTask('p', 'w', id);
const PATH: HarnessPath = [
  { level: 'page', node: key('page1') },
  { level: 'layer', node: key('layer1') },
  { level: 'area', node: key('area1') },
  { level: 'sector', node: key('sector1') },
  { level: 'task', node: key('task1') },
];
/** The same way down, to a sibling at `level` (another node there, the same nodes above it). */
function sibling(level: HarnessLevel): HarnessPath {
  const at = PATH.findIndex((p) => p.level === level);
  return PATH.map((p, i) => (i < at ? p : { level: p.level, node: key(p.level + '-other') }));
}

test('global → repository → task replaces a slot; absent inherits and null disables (the 3-level form keeps working)', (t) => {
  const { store } = fixture(t);
  store.save('/repo', '', 'global', { color: { value: 'red' }, tools: { resource: 'guide:tools' } }, 0);
  store.save('/repo', '', 'repository', { color: { value: 'blue' } }, 1);
  const result = store.save('/repo', 'one', 'task', { color: { value: 'green' }, tools: null }, 2);
  assert.deepEqual(result.effective.color, { binding: { value: 'green' }, scope: 'task', node: 'one' });
  assert.deepEqual(result.effective.tools, { binding: null, scope: 'task', node: 'one' });
  assert.equal(store.view('/repo', 'two').effective.color.scope, 'project', 'repository is the project level');
  assert.deepEqual(store.view('/repo', 'two').layers.project, { color: { value: 'blue' } });
  assert.equal(store.view('/other', 'one').effective.color.scope, 'global');
  const restored = store.save('/repo', 'one', 'task', {}, 3);
  assert.equal(restored.effective.tools.scope, 'global');
  assert.deepEqual(restored.effective.color.binding, { value: 'blue' });
  assert.equal(harnessLevel('repository'), 'project');
  assert.equal(harnessLevel('floor'), undefined);
});

test('every level of global → project → page → layer → area → sector → task replaces, inherits or disables a slot', (t) => {
  const { store } = fixture(t);
  // Each level sets its own colour; the levels below see it until one of them sets its own.
  let revision = 0;
  for (const level of HARNESS_LEVELS) store.save('/repo', PATH, level, { [level]: { value: level }, color: { value: level } }, revision++);
  const view = store.view('/repo', PATH);
  assert.deepEqual(view.path, PATH);
  for (const level of HARNESS_LEVELS) {
    assert.deepEqual(view.layers[level], { [level]: { value: level }, color: { value: level } }, `${level}'s own view has only what it set`);
    const expected = level === 'global' || level === 'project' ? { binding: { value: level }, scope: level } : { binding: { value: level }, scope: level, node: PATH.find((p) => p.level === level)!.node };
    assert.deepEqual(view.effective[level], expected, `${level}'s slot comes from ${level} with its provenance`);
  }
  assert.deepEqual(view.effective.color, { binding: { value: 'task' }, scope: 'task', node: key('task1') }, 'the deepest level wins');
  // Table: remove each level's colour from the bottom up; the next level up shows through. Then null disables at that level.
  const table: { clear: HarnessLevel; expectScope: HarnessLevel }[] = [
    { clear: 'task', expectScope: 'sector' },
    { clear: 'sector', expectScope: 'area' },
    { clear: 'area', expectScope: 'layer' },
    { clear: 'layer', expectScope: 'page' },
    { clear: 'page', expectScope: 'project' },
    { clear: 'project', expectScope: 'global' },
  ];
  for (const row of table) {
    const after = store.save('/repo', PATH, row.clear, { [row.clear]: { value: row.clear } }, revision++);
    assert.equal(after.effective.color.scope, row.expectScope, `clearing color at ${row.clear} reveals ${row.expectScope}`);
    assert.deepEqual(after.effective.color.binding, { value: row.expectScope });
    const disabled = store.save('/repo', PATH, row.clear, { [row.clear]: { value: row.clear }, color: null }, revision++);
    assert.deepEqual(disabled.effective.color, { binding: null, scope: row.clear, ...(row.clear === 'project' ? {} : { node: PATH.find((p) => p.level === row.clear)!.node }) }, `null at ${row.clear} disables the slot`);
    store.save('/repo', PATH, row.clear, { [row.clear]: { value: row.clear } }, revision++);
  }
  // An empty layer takes the level out entirely: everything inherits again.
  const reset = store.save('/repo', PATH, 'global', {}, revision++);
  assert.equal(reset.effective.global, undefined);
  assert.deepEqual(reset.layers.global, {});
  assert.equal(store.view('/repo', PATH).revision, revision);
});

test('siblings are isolated at every level: another node at a level sees nothing the first one set', (t) => {
  const { store } = fixture(t);
  let revision = 0;
  for (const level of HARNESS_LEVELS) store.save('/repo', PATH, level, { color: { value: level } }, revision++);
  for (const level of ['page', 'layer', 'area', 'sector', 'task'] as const) {
    const other = store.view('/repo', sibling(level));
    const above = HARNESS_LEVELS[HARNESS_LEVELS.indexOf(level) - 1];
    assert.equal(other.effective.color.scope, above, `a sibling ${level} inherits from ${above}, not from its sibling`);
    for (const below of HARNESS_LEVELS.slice(HARNESS_LEVELS.indexOf(level))) assert.deepEqual(other.layers[below], {}, `${below} own view of the sibling path is empty`);
  }
  // The same node ids in another project or workspace are other nodes, and another checkout is another project.
  const elsewhere: HarnessPath = PATH.map((p) => ({ level: p.level, node: oporaHarnessTask('p', 'draft', p.node.split(':').pop()!) }));
  assert.equal(store.view('/repo', elsewhere).effective.color.scope, 'project');
  assert.equal(store.view('/other', PATH).effective.color.scope, 'global');
  // A level the path doesn't go through can't be saved to, and a save never spills into another level's key.
  assert.throws(() => store.save('/repo', [{ level: 'task', node: 't' }], 'sector', { x: { value: 1 } }, revision), /no sector above it/);
  assert.throws(() => store.save('/repo', '', 'task', { x: { value: 1 } }, revision), /task ID/);
  assert.throws(() => store.save('/repo', PATH, 'floor', {}, revision), /Choose a level/);
});

test('one revision for every level: a concurrent edit at another level is rejected until reloaded', (t) => {
  const { store, dir } = fixture(t);
  const other = new HarnessProfiles(dir);
  const a = store.view('/repo', PATH);
  const b = other.view('/repo', sibling('task'));
  assert.equal(a.revision, b.revision);
  store.save('/repo', PATH, 'sector', { color: { value: 'sector' } }, a.revision);
  assert.throws(() => other.save('/repo', sibling('task'), 'task', { color: { value: 'mine' } }, b.revision), (err: Error & { status: number }) => err.status === 409 && /changed elsewhere/.test(err.message));
  assert.deepEqual(other.view('/repo', sibling('task')).layers.task, {}, 'the stale save wrote nothing');
  const reloaded = other.view('/repo', sibling('task'));
  assert.equal(reloaded.effective.color.scope, 'sector', 'the sibling task sees the shared sector');
  other.save('/repo', sibling('task'), 'task', { color: { value: 'mine' } }, reloaded.revision);
  assert.equal(store.view('/repo', PATH).revision, 2);
  const audit = store.audit();
  assert.equal(audit.length, 2);
  assert.deepEqual(audit[0], { ...audit[0], revision: 2, level: 'task', node: key('task-other'), slots: ['color'] });
  assert.deepEqual(audit[1], { ...audit[1], revision: 1, level: 'sector', node: key('sector1'), slots: ['color'] });
  assert.match(audit[0].at, /^\d{4}-\d\d-\d\dT/);
});

test('profiles survive restart; stale revisions and invalid layers never overwrite', (t) => {
  const { store, dir } = fixture(t);
  store.save('/repo', '', 'global', { language: { value: 'cs' } }, 0);
  store.save('/repo', PATH, 'area', { language: { value: 'en' } }, 1, 'tester');
  const restarted = new HarnessProfiles(dir);
  assert.equal(restarted.view('/repo').revision, 2);
  assert.deepEqual(restarted.view('/repo', PATH).effective.language, { binding: { value: 'en' }, scope: 'area', node: key('area1') });
  assert.equal(restarted.audit()[0].by, 'tester');
  assert.throws(() => restarted.save('/repo', '', 'global', {}, 0), /changed elsewhere/);
  assert.throws(() => restarted.save('/repo', '', 'task', {}, 2), /task ID/);
  for (const value of [[], null, { a: { value: {} } }, { a: { value: 'x', resource: 'y' } }, JSON.parse('{"__proto__":null}')]) assert.throws(() => parseHarnessLayer(value));
  assert.equal(restarted.view('/repo').revision, 2);
  writeFileSync(path.join(dir, 'harness-profiles.json'), 'broken');
  assert.throws(() => restarted.save('/repo', '', 'global', {}, 2), /not been overwritten/);
  writeFileSync(path.join(dir, 'harness-profiles.json'), JSON.stringify({ version: 99, revision: 0, layers: {} }));
  assert.throws(() => restarted.view('/repo'), /unreadable/);
});

/** How the 3-level store (version 1) read its file: the revision, and the layers it knows the keys of. */
function v1Read(file: string) {
  const data = JSON.parse(readFileSync(file, 'utf8')) as { revision: number; layers: Record<string, unknown> };
  assert.ok(Number.isSafeInteger(data.revision) && data.revision >= 0 && data.layers && typeof data.layers === 'object');
  for (const layer of Object.values(data.layers)) parseHarnessLayer(layer);
  return data;
}

test('a 3-level store loads unchanged, and the hierarchy store rolls back to it: old keys byte-identical, new ones dormant', (t) => {
  const { store, dir } = fixture(t);
  const file = path.join(dir, 'harness-profiles.json');
  // What the version 1 store wrote: no version, no audit, these three key shapes.
  const probe = new HarnessProfiles(dir);
  probe.save('/repo', key('task1'), 'global', { color: { value: 'red' }, tools: { resource: 'guide:tools' } }, 0);
  probe.save('/repo', key('task1'), 'repository', { color: { value: 'blue' } }, 1);
  probe.save('/repo', key('task1'), 'task', { color: { value: 'green' } }, 2);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  const v1 = { revision: written.revision, layers: written.layers };
  assert.deepEqual(Object.keys(v1.layers).map((k) => k.split(':')[0]).sort(), ['global', 'repo', 'task']);
  writeFileSync(file, JSON.stringify(v1, null, 2));
  // 1. Loads as it is, with the same effective result the 3-level store gave.
  const legacy = store.view('/repo', key('task1'));
  assert.equal(legacy.revision, 3);
  assert.deepEqual(legacy.effective.color, { binding: { value: 'green' }, scope: 'task', node: key('task1') });
  assert.deepEqual(legacy.effective.tools, { binding: { resource: 'guide:tools' }, scope: 'global' });
  assert.deepEqual(store.view('/repo', PATH).effective.color.binding, { value: 'green' }, 'the same task reached down the hierarchy finds its old layer');
  assert.deepEqual(store.audit(), []);
  // 2. Saving at a new level migrates: version 2, audit, a node: key; the old keys are untouched.
  store.save('/repo', PATH, 'sector', { color: { value: 'sector' } }, 3);
  const v2 = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(v2.version, HARNESS_STORE_VERSION);
  assert.equal(v2.revision, 4);
  for (const [k, layer] of Object.entries(v1.layers)) assert.deepEqual(v2.layers[k], layer, `old key ${k} is byte-identical`);
  assert.deepEqual(Object.keys(v2.layers).filter((k) => !(k in v1.layers)).map((k) => k.split(':')[0]), ['node']);
  assert.equal(store.view('/repo', PATH).effective.color.scope, 'task', 'the task still wins over its sector');
  assert.equal(store.view('/repo', sibling('task')).effective.color.scope, 'sector');
  // 3. Rollback: the version 1 reader takes the version 2 file as it is, sees the three levels it knows and ignores the rest.
  const back = v1Read(file);
  assert.equal(back.revision, 4);
  for (const [k, layer] of Object.entries(v1.layers)) assert.deepEqual(back.layers[k], layer);
  const threeLevels = resolveHarness({ global: back.layers.global as never, project: back.layers[Object.keys(v1.layers).find((k) => k.startsWith('repo:'))!] as never, task: back.layers[Object.keys(v1.layers).find((k) => k.startsWith('task:'))!] as never });
  assert.deepEqual(threeLevels.color.binding, { value: 'green' });
  // 4. A version 1 save (replace one key, bump the revision, drop nothing) keeps the dormant node: layer for a later upgrade.
  const nodeKey = Object.keys(v2.layers).find((k) => k.startsWith('node:'))!;
  writeFileSync(file, JSON.stringify({ ...back, revision: back.revision + 1, layers: { ...back.layers, global: { color: { value: 'violet' } } } }, null, 2));
  const upgraded = new HarnessProfiles(dir).view('/repo', sibling('task'));
  assert.equal(upgraded.revision, 5);
  assert.deepEqual(upgraded.effective.color, { binding: { value: 'sector' }, scope: 'sector', node: nodeKey.split(':').slice(2).join(':') });
});

test('task IDs isolate projects, workspaces and separator-containing IDs', () => {
  const ids = [['p', 'w', 'c'], ['q', 'w', 'c'], ['p', 'other', 'c'], ['p:w', 'x', 'c'], ['p', 'w:x', 'c']].map(([p, w, c]) => oporaHarnessTask(p, w, c));
  assert.equal(new Set(ids).size, ids.length);
});

test('handoff contains resolved content and provenance, freezes snapshot, blocks missing resources', async (t) => {
  const { store, dir } = fixture(t);
  store.save(dir, '', 'global', { rules: { resource: 'guide:rules' }, language: { value: 'en' } }, 0);
  store.save(dir, 'task', 'task', { language: { value: 'cs' } }, 1);
  const snapshot = await harnessHandoff(dir, dir, 'task', false);
  assert.match(snapshot, /Snapshot SHA-256: [a-f0-9]{64}/);
  assert.match(snapshot, /Resolved Harness \(global → project → page → layer → area → sector → task\)/);
  assert.match(snapshot, /"value": "cs"/);
  assert.doesNotMatch(snapshot, /"value": "en"/);
  assert.match(snapshot, /Rules and instruction precedence/);
  assert.match(snapshot, /"scope": "task"/);
  store.save(dir, 'task', 'task', { language: { value: 'fr' } }, 2);
  assert.match(snapshot, /"value": "cs"/);
  assert.notEqual(await harnessHandoff(dir, dir, 'task', false), snapshot);
  // A global change after the handoff doesn't reach the seated worker's snapshot either.
  const seated = await harnessHandoff(dir, dir, 'task', false);
  store.save(dir, '', 'global', { rules: { resource: 'guide:rules' }, language: { value: 'en' }, extra: { value: 'later' } }, 3);
  assert.doesNotMatch(seated, /"later"/);
  assert.match(await harnessHandoff(dir, dir, 'task', false), /"later"/);
  store.save(dir, '', 'repository', { missing: { resource: 'missing' } }, 4);
  await assert.rejects(harnessHandoff(dir, dir, 'task', false), /unavailable/);
});

test('a handoff down the hierarchy names the path and each slot’s origin', async (t) => {
  const { store, dir } = fixture(t);
  store.save(dir, PATH, 'layer', { language: { value: 'cs' } }, 0);
  store.save(dir, PATH, 'sector', { tone: { value: 'terse' } }, 1);
  const snapshot = await harnessHandoff(dir, dir, PATH, false);
  assert.match(snapshot, new RegExp(`"task": "${key('task1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(snapshot, /"level": "sector"/);
  assert.match(snapshot, /"scope": "layer"/);
  assert.match(snapshot, new RegExp(`"node": "${key('layer1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
});

test('only Opora planning prompts get assignment instructions', () => {
  assert.match(harnessPlannerBrief('original', 'planning.opora'), /office-harness --assign/);
  assert.match(harnessPlannerBrief('original', 'planning.opora'), /--node NODE_ID/);
  assert.match(harnessPlannerBrief('original', 'planning.router'), /Global configuration is administrator-owned/);
  assert.equal(harnessPlannerBrief('original', 'planning.plan'), 'original');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HarnessProfiles, HARNESS_STORE_VERSION, parseHarnessLayer } from '../src/server/harness/profiles.js';
import { harnessHandoff, harnessPlannerBrief } from '../src/server/harness/handoff.js';
import { HARNESS_LEVELS, harnessLevel, oporaHarnessTask, type HarnessLevel, type HarnessPath } from '../src/shared/harness-cascade.js';
import { HarnessProfilesV1 } from './fixtures/harness-profiles-v1.js';

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
const status = (code: number, message: RegExp) => (err: Error & { status: number }) => err.status === code && message.test(err.message);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('global → repository → task replaces a slot; absent inherits and null disables (the 3-level form keeps working)', async (t) => {
  const { store } = fixture(t);
  await store.save('/repo', '', 'global', { color: { value: 'red' }, tools: { resource: 'guide:tools' } }, 0);
  await store.save('/repo', '', 'repository', { color: { value: 'blue' } }, 1);
  const result = await store.save('/repo', 'one', 'task', { color: { value: 'green' }, tools: null }, 2);
  assert.deepEqual(result.effective.color, { binding: { value: 'green' }, scope: 'task', node: 'one' });
  assert.deepEqual(result.effective.tools, { binding: null, scope: 'task', node: 'one' });
  assert.equal(store.view('/repo', 'two').effective.color.scope, 'project', 'repository is the project level');
  assert.deepEqual(store.view('/repo', 'two').layers.project, { color: { value: 'blue' } });
  assert.equal(store.view('/other', 'one').effective.color.scope, 'global');
  const restored = await store.save('/repo', 'one', 'task', {}, 3);
  assert.equal(restored.effective.tools.scope, 'global');
  assert.deepEqual(restored.effective.color.binding, { value: 'blue' });
  assert.equal(harnessLevel('repository'), 'project');
  assert.equal(harnessLevel('floor'), undefined);
});

test('every level of global → project → page → layer → area → sector → task replaces, inherits or disables a slot', async (t) => {
  const { store } = fixture(t);
  // Each level sets its own colour; the levels below see it until one of them sets its own.
  let revision = 0;
  for (const level of HARNESS_LEVELS) await store.save('/repo', PATH, level, { [level]: { value: level }, color: { value: level } }, revision++);
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
    const after = await store.save('/repo', PATH, row.clear, { [row.clear]: { value: row.clear } }, revision++);
    assert.equal(after.effective.color.scope, row.expectScope, `clearing color at ${row.clear} reveals ${row.expectScope}`);
    assert.deepEqual(after.effective.color.binding, { value: row.expectScope });
    const disabled = await store.save('/repo', PATH, row.clear, { [row.clear]: { value: row.clear }, color: null }, revision++);
    assert.deepEqual(disabled.effective.color, { binding: null, scope: row.clear, ...(row.clear === 'project' ? {} : { node: PATH.find((p) => p.level === row.clear)!.node }) }, `null at ${row.clear} disables the slot`);
    await store.save('/repo', PATH, row.clear, { [row.clear]: { value: row.clear } }, revision++);
  }
  // An empty layer takes the level out entirely: everything inherits again.
  const reset = await store.save('/repo', PATH, 'global', {}, revision++);
  assert.equal(reset.effective.global, undefined);
  assert.deepEqual(reset.layers.global, {});
  assert.equal(store.view('/repo', PATH).revision, revision);
});

test('provenance carries the node’s name when the path knows it', async (t) => {
  const { store } = fixture(t);
  const named: HarnessPath = PATH.map((p) => ({ ...p, name: p.level.toUpperCase() }));
  await store.save('/repo', named, 'sector', { color: { value: 'teal' } }, 0);
  assert.deepEqual(store.view('/repo', named).effective.color, { binding: { value: 'teal' }, scope: 'sector', node: key('sector1'), nodeName: 'SECTOR' });
  assert.deepEqual(store.view('/repo', PATH).effective.color, { binding: { value: 'teal' }, scope: 'sector', node: key('sector1') }, 'the same layer read through an unnamed path has no name to give');
});

test('siblings are isolated at every level: another node at a level sees nothing the first one set', async (t) => {
  const { store } = fixture(t);
  let revision = 0;
  for (const level of HARNESS_LEVELS) await store.save('/repo', PATH, level, { color: { value: level } }, revision++);
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
  await assert.rejects(store.save('/repo', [{ level: 'task', node: 't' }], 'sector', { x: { value: 1 } }, revision), /no sector above it/);
  await assert.rejects(store.save('/repo', '', 'task', { x: { value: 1 } }, revision), /task ID/);
  await assert.rejects(store.save('/repo', PATH, 'floor', {}, revision), /Choose a level/);
});

test('one revision for every level: a concurrent edit at another level is rejected until reloaded', async (t) => {
  const { store, dir } = fixture(t);
  const other = new HarnessProfiles(dir);
  const a = store.view('/repo', PATH);
  const b = other.view('/repo', sibling('task'));
  assert.equal(a.revision, b.revision);
  await store.save('/repo', PATH, 'sector', { color: { value: 'sector' } }, a.revision);
  await assert.rejects(other.save('/repo', sibling('task'), 'task', { color: { value: 'mine' } }, b.revision), status(409, /changed elsewhere/));
  assert.deepEqual(other.view('/repo', sibling('task')).layers.task, {}, 'the stale save wrote nothing');
  const reloaded = other.view('/repo', sibling('task'));
  assert.equal(reloaded.effective.color.scope, 'sector', 'the sibling task sees the shared sector');
  await other.save('/repo', sibling('task'), 'task', { color: { value: 'mine' } }, reloaded.revision);
  assert.equal(store.view('/repo', PATH).revision, 2);
  const audit = store.audit();
  assert.equal(audit.length, 2);
  assert.deepEqual(audit[0], { ...audit[0], revision: 2, level: 'task', node: key('task-other'), slots: ['color'] });
  assert.deepEqual(audit[1], { ...audit[1], revision: 1, level: 'sector', node: key('sector1'), slots: ['color'] });
  assert.match(audit[0].at, /^\d{4}-\d\d-\d\dT/);
  assert.match(audit[0].repo!, /^[a-f0-9]{64}$/, 'a save below global records its repository');
});

test('two office processes saving on one data directory lose none of the saves the store accepted', async (t) => {
  const { store, dir } = fixture(t);
  const saver = path.join(import.meta.dirname, 'fixtures', 'harness-saver.ts');
  const run = (name: string) => promisify(execFile)(process.execPath, ['--import', 'tsx', saver, dir, name, '50'], { cwd: path.join(import.meta.dirname, '..'), timeout: 110_000 });
  const [a, b] = await Promise.all([run('alpha'), run('beta')]);
  const accepted = [...JSON.parse(a.stdout) as string[], ...JSON.parse(b.stdout) as string[]];
  assert.equal(accepted.length, 100, 'every save was accepted in the end, after its 409s');
  const final = store.view('/repo');
  assert.equal(final.revision, 100, 'one revision per accepted save: none was overwritten by a stale write');
  for (const slot of accepted) assert.ok(slot in final.layers.global || slot in final.layers.project, `${slot} is in the saved layer`);
  assert.equal(Object.keys(final.layers.global).length + Object.keys(final.layers.project).length, 100);
  assert.equal(store.audit(200).length, 100);
});

test('a lock another process left behind is taken over once it is stale, and waited for while it is fresh', async (t) => {
  const { store, dir } = fixture(t);
  const lock = path.join(dir, 'harness-profiles.json.lock');
  writeFileSync(lock, '1');
  const old = Date.now() / 1000 - 60;
  utimesSync(lock, old, old);
  await store.save('/repo', '', 'global', { color: { value: 'red' } }, 0);
  assert.equal(store.view('/repo').revision, 1, 'a stale lock does not block the save');
  writeFileSync(lock, '1');
  const started = Date.now();
  await assert.rejects(store.save('/repo', '', 'global', { color: { value: 'blue' } }, 1), status(503, /Another office is saving/));
  assert.ok(Date.now() - started >= 2000, 'a fresh lock is waited for, briefly');
  assert.equal(store.view('/repo').revision, 1);
});

test('profiles survive restart; stale revisions and invalid layers never overwrite', async (t) => {
  const { store, dir } = fixture(t);
  await store.save('/repo', '', 'global', { language: { value: 'cs' } }, 0);
  await store.save('/repo', PATH, 'area', { language: { value: 'en' } }, 1, 'tester');
  const restarted = new HarnessProfiles(dir);
  assert.equal(restarted.view('/repo').revision, 2);
  assert.deepEqual(restarted.view('/repo', PATH).effective.language, { binding: { value: 'en' }, scope: 'area', node: key('area1') });
  assert.equal(restarted.audit()[0].by, 'tester');
  await assert.rejects(restarted.save('/repo', '', 'global', {}, 0), /changed elsewhere/);
  await assert.rejects(restarted.save('/repo', '', 'task', {}, 2), /task ID/);
  for (const value of [[], null, { a: { value: {} } }, { a: { value: 'x', resource: 'y' } }, JSON.parse('{"__proto__":null}')]) assert.throws(() => parseHarnessLayer(value));
  assert.equal(restarted.view('/repo').revision, 2);
  writeFileSync(path.join(dir, 'harness-profiles.json'), 'broken');
  await assert.rejects(restarted.save('/repo', '', 'global', {}, 2), /not been overwritten/);
  writeFileSync(path.join(dir, 'harness-profiles.json'), JSON.stringify({ version: 99, revision: 0, layers: {} }));
  assert.throws(() => restarted.view('/repo'), /unreadable/);
});

test('the audit a repository reads is its own; global saves and other repositories’ are for administrators', async (t) => {
  const { store } = fixture(t);
  await store.save('/repo-a', '', 'global', { color: { value: 'red' } }, 0, 'admin');
  await store.save('/repo-a', PATH, 'sector', { color: { value: 'a' } }, 1, 'account:ana');
  await store.save('/repo-b', PATH, 'sector', { color: { value: 'b' } }, 2, 'account:bob');
  assert.deepEqual(store.audit(20, '/repo-a', false).map((a) => a.by), ['account:ana'], 'a worker of repo A sees its repository’s saves only');
  assert.deepEqual(store.audit(20, '/repo-b', false).map((a) => a.by), ['account:bob']);
  assert.deepEqual(store.audit(20, '/repo-a', true).map((a) => a.by), ['account:bob', 'account:ana', 'admin'], 'an administrator sees everything');
  assert.deepEqual(store.audit().map((a) => a.by), ['account:bob', 'account:ana', 'admin']);
});

test('a 3-level store loads unchanged, and the hierarchy store rolls back to it: the real version 1 code reads what version 2 wrote', async (t) => {
  const { store, dir } = fixture(t);
  const file = path.join(dir, 'harness-profiles.json');
  // Written by the version 1 store itself (tests/fixtures/harness-profiles-v1.ts): no version, no audit, three key shapes.
  const old = new HarnessProfilesV1(dir);
  old.save('/repo', key('task1'), 'global', { color: { value: 'red' }, tools: { resource: 'guide:tools' } }, 0);
  old.save('/repo', key('task1'), 'repository', { color: { value: 'blue' } }, 1);
  old.save('/repo', key('task1'), 'task', { color: { value: 'green' } }, 2);
  const v1 = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(v1).sort(), ['layers', 'revision']);
  assert.deepEqual(Object.keys(v1.layers).map((k) => k.split(':')[0]).sort(), ['global', 'repo', 'task']);
  // 1. Loads as it is, with the same effective result the 3-level store gave.
  const legacy = store.view('/repo', key('task1'));
  assert.equal(legacy.revision, 3);
  assert.deepEqual(legacy.effective.color, { binding: { value: 'green' }, scope: 'task', node: key('task1') });
  assert.deepEqual(legacy.effective.tools, { binding: { resource: 'guide:tools' }, scope: 'global' });
  assert.deepEqual(store.view('/repo', PATH).effective.color.binding, { value: 'green' }, 'the same task reached down the hierarchy finds its old layer');
  assert.deepEqual(store.audit(), []);
  // 2. Saving at a new level migrates: version 2, audit, a node: key; the old keys are untouched.
  await store.save('/repo', PATH, 'sector', { color: { value: 'sector' } }, 3);
  const v2 = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(v2.version, HARNESS_STORE_VERSION);
  assert.equal(v2.revision, 4);
  for (const [k, layer] of Object.entries(v1.layers)) assert.deepEqual(v2.layers[k], layer, `old key ${k} is byte-identical`);
  assert.deepEqual(Object.keys(v2.layers).filter((k) => !(k in v1.layers)).map((k) => k.split(':')[0]), ['node']);
  assert.deepEqual(v2.legacyTasks, Object.keys(v1.layers).filter((k) => k.startsWith('task:')), 'the task: keys version 1 wrote are remembered as the ones that may be a higher level');
  assert.equal(store.view('/repo', PATH).effective.color.scope, 'task', 'the task still wins over its sector');
  assert.equal(store.view('/repo', sibling('task')).effective.color.scope, 'sector');
  // 3. Rollback: the version 1 store takes the version 2 file as it is, sees the three levels it knows and ignores the rest.
  const back = old.view('/repo', key('task1'));
  assert.equal(back.revision, 4);
  assert.deepEqual(back.effective.color, { binding: { value: 'green' }, scope: 'task' });
  assert.deepEqual(back.effective.tools, { binding: { resource: 'guide:tools' }, scope: 'global' });
  assert.equal(old.view('/repo', key('task-other')).effective.color.scope, 'repository', 'the sector layer is dormant for the old code');
  // 4. A version 1 save keeps the dormant node: layer, version, audit and legacyTasks for a later upgrade.
  old.save('/repo', '', 'global', { color: { value: 'violet' } }, 4);
  const afterOld = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(afterOld.version, HARNESS_STORE_VERSION);
  assert.equal(afterOld.audit.length, 1);
  assert.deepEqual(afterOld.legacyTasks, v2.legacyTasks);
  const nodeKey = Object.keys(v2.layers).find((k) => k.startsWith('node:'))!;
  assert.deepEqual(afterOld.layers[nodeKey], { color: { value: 'sector' } });
  const upgraded = new HarnessProfiles(dir).view('/repo', sibling('task'));
  assert.equal(upgraded.revision, 5);
  assert.deepEqual(upgraded.effective.color, { binding: { value: 'sector' }, scope: 'sector', node: nodeKey.split(':').slice(2).join(':') });
  assert.deepEqual(upgraded.layers.global, { color: { value: 'violet' } });
});

test('a task layer the 3-level store gave a node that is a sector today is read at the sector; its next save writes the node key and keeps the old one', async (t) => {
  const { store, dir } = fixture(t);
  const old = new HarnessProfilesV1(dir);
  old.save('/repo', key('sector1'), 'task', { color: { value: 'teal' }, tone: { value: 'terse' } }, 0);
  const sectorPath = PATH.filter((p) => p.level !== 'task');
  const seen = store.view('/repo', sectorPath);
  assert.deepEqual(seen.layers.sector, { color: { value: 'teal' }, tone: { value: 'terse' } }, 'the old task layer is the sector\'s own view');
  assert.deepEqual(store.view('/repo', PATH).effective.color, { binding: { value: 'teal' }, scope: 'sector', node: key('sector1') }, 'and the cards under it inherit it');
  assert.deepEqual(store.view('/repo', sibling('sector')).layers.sector, {}, 'a sibling sector sees nothing of it');
  // An unrelated save upgrades the file first: the lift survives it, because the key is listed as version 1's.
  await store.save('/repo', '', 'global', { color: { value: 'red' } }, 1);
  assert.deepEqual(store.view('/repo', PATH).effective.color.scope, 'sector', 'still lifted after the store became version 2');
  await store.save('/repo', sectorPath, 'sector', { color: { value: 'teal' } }, 2);
  const file = JSON.parse(readFileSync(path.join(dir, 'harness-profiles.json'), 'utf8'));
  assert.deepEqual(Object.keys(file.layers).map((k) => k.split(':')[0]).sort(), ['global', 'node', 'task'], 'the node key is written and the task key stays');
  assert.deepEqual(file.layers[Object.keys(file.layers).find((k) => k.startsWith('task:'))!], { color: { value: 'teal' }, tone: { value: 'terse' } }, 'the task key is as version 1 wrote it');
  assert.equal(file.legacyTasks, undefined, 'the key is no longer one to lift');
  assert.deepEqual(store.view('/repo', PATH).effective.color.scope, 'sector');
  assert.equal(store.view('/repo', PATH).effective.tone, undefined, 'the save replaced the whole layer, as every save does; the old key is not read any more');
  // Rollback after the migration: the version 1 office still sees the layer as it was before the save, not the edit.
  assert.deepEqual(old.view('/repo', key('sector1')).layers.task, { color: { value: 'teal' }, tone: { value: 'terse' } });
  // Taking the node: layer away does not bring the old key back to life.
  await store.save('/repo', sectorPath, 'sector', {}, 3);
  assert.equal(store.view('/repo', PATH).effective.color.scope, 'global');
  // Audit entries that aren't ones are dropped on read, never crash a view.
  writeFileSync(path.join(dir, 'harness-profiles.json'), JSON.stringify({ ...file, audit: [...file.audit, { at: 1 }, 'x', null] }));
  assert.equal(store.audit().length, file.audit.length);
});

test('a task: key version 2 wrote stays the card’s task layer: a leaf card that gains a child does not hand it down as a layer', async (t) => {
  const { store } = fixture(t);
  // The card is a leaf under the page today: a task.
  const leaf: HarnessPath = [{ level: 'page', node: key('page1') }, { level: 'task', node: key('card') }];
  await store.save('/repo', leaf, 'task', { color: { value: 'green' } }, 0);
  assert.equal(store.view('/repo', leaf).effective.color.scope, 'task');
  // Tomorrow the canvas gives it a child: the card is a layer now, its child the task.
  const widened: HarnessPath = [{ level: 'page', node: key('page1') }, { level: 'layer', node: key('card') }, { level: 'task', node: key('child') }];
  const child = store.view('/repo', widened);
  assert.deepEqual(child.layers.layer, {}, 'the former leaf’s task layer is not the layer’s own view');
  assert.equal(child.effective.color, undefined, 'the child inherits nothing from it');
  assert.deepEqual(store.view('/repo', leaf).layers.task, { color: { value: 'green' } }, 'the card’s task layer is still there for the card itself');
  // Only a version 1 file lifts a task: key, and only the keys it had.
  const { dir } = fixture(t);
  const old = new HarnessProfilesV1(dir), fresh = new HarnessProfiles(dir);
  old.save('/repo', key('card'), 'task', { color: { value: 'green' } }, 0);
  assert.equal(fresh.view('/repo', widened).effective.color.scope, 'layer', 'a version 1 task: key is lifted');
  await fresh.save('/repo', leaf, 'task', { color: { value: 'lime' } }, 1);
  await fresh.save('/repo', [{ level: 'page', node: key('page1') }, { level: 'task', node: key('card2') }], 'task', { color: { value: 'olive' } }, 2);
  assert.equal(fresh.view('/repo', widened).effective.color.scope, 'layer', 'the version 1 key is still the one to lift, even after the card’s own task layer was saved again');
  assert.equal(fresh.view('/repo', [{ level: 'page', node: key('page1') }, { level: 'layer', node: key('card2') }, { level: 'task', node: key('child') }]).effective.color, undefined, 'a key version 2 wrote is never lifted');
});

test('task IDs isolate projects, workspaces and separator-containing IDs', () => {
  const ids = [['p', 'w', 'c'], ['q', 'w', 'c'], ['p', 'other', 'c'], ['p:w', 'x', 'c'], ['p', 'w:x', 'c']].map(([p, w, c]) => oporaHarnessTask(p, w, c));
  assert.equal(new Set(ids).size, ids.length);
});

test('handoff contains resolved content and provenance, freezes snapshot, blocks missing resources', async (t) => {
  const { store, dir } = fixture(t);
  await store.save(dir, '', 'global', { rules: { resource: 'guide:rules' }, language: { value: 'en' } }, 0);
  await store.save(dir, 'task', 'task', { language: { value: 'cs' } }, 1);
  const snapshot = await harnessHandoff(dir, dir, 'task', false);
  assert.match(snapshot, /Snapshot SHA-256: [a-f0-9]{64}/);
  assert.match(snapshot, /Resolved Harness \(global → project → page → layer → area → sector → task\)/);
  assert.match(snapshot, /"value": "cs"/);
  assert.doesNotMatch(snapshot, /"value": "en"/);
  assert.match(snapshot, /Rules and instruction precedence/);
  assert.match(snapshot, /"scope": "task"/);
  assert.match(snapshot, /"task": "task",\n\s+"level": "task"/);
  await store.save(dir, 'task', 'task', { language: { value: 'fr' } }, 2);
  assert.notEqual(await harnessHandoff(dir, dir, 'task', false), snapshot);
  // A later global change is in the next handoff and not in an earlier one (the seated worker's prompt is checked in tests/opora.test.ts).
  await store.save(dir, '', 'global', { rules: { resource: 'guide:rules' }, language: { value: 'en' }, extra: { value: 'later' } }, 3);
  assert.match(await harnessHandoff(dir, dir, 'task', false), /"later"/);
  await store.save(dir, '', 'repository', { missing: { resource: 'missing' } }, 4);
  await assert.rejects(harnessHandoff(dir, dir, 'task', false), /unavailable/);
});

test('a handoff down the hierarchy names the path, what was dispatched and each slot’s origin', async (t) => {
  const { store, dir } = fixture(t);
  await store.save(dir, PATH, 'layer', { language: { value: 'cs' } }, 0);
  await store.save(dir, PATH, 'sector', { tone: { value: 'terse' } }, 1);
  const snapshot = await harnessHandoff(dir, dir, PATH, false);
  assert.match(snapshot, new RegExp(`"task": "${escape(key('task1'))}",\\n\\s+"level": "task"`));
  assert.match(snapshot, /"scope": "layer"/);
  assert.match(snapshot, new RegExp(`"node": "${escape(key('layer1'))}"`));
  // A sector handed out whole is the manifest's target, with its level, never an empty task.
  const sector = await harnessHandoff(dir, dir, PATH.filter((p) => p.level !== 'task'), false);
  assert.match(sector, new RegExp(`"task": "${escape(key('sector1'))}",\\n\\s+"level": "sector"`));
  assert.doesNotMatch(sector, /"task": ""/);
});

test('only Opora planning prompts get assignment instructions', () => {
  assert.match(harnessPlannerBrief('original', 'planning.opora'), /office-harness --assign/);
  assert.match(harnessPlannerBrief('original', 'planning.opora'), /--node NODE_ID/);
  assert.match(harnessPlannerBrief('original', 'planning.router'), /Global configuration is administrator-owned/);
  assert.equal(harnessPlannerBrief('original', 'planning.plan'), 'original');
});

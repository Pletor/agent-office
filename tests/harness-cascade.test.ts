import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessProfiles, parseHarnessLayer } from '../src/server/harness/profiles.js';
import { harnessHandoff, harnessPlannerBrief } from '../src/server/harness/handoff.js';
import { oporaHarnessTask } from '../src/shared/harness-cascade.js';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-cascade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new HarnessProfiles(dir) };
}
test('global → repository → task replaces a slot; absent inherits and null disables', (t) => {
  const { store } = fixture(t);
  store.save('/repo', '', 'global', { color: { value: 'red' }, tools: { resource: 'guide:tools' } }, 0);
  store.save('/repo', '', 'repository', { color: { value: 'blue' } }, 1);
  const result = store.save('/repo', 'one', 'task', { color: { value: 'green' }, tools: null }, 2);
  assert.deepEqual(result.effective.color, { binding: { value: 'green' }, scope: 'task' });
  assert.deepEqual(result.effective.tools, { binding: null, scope: 'task' });
  assert.equal(store.view('/repo', 'two').effective.color.scope, 'repository');
  assert.equal(store.view('/other', 'one').effective.color.scope, 'global');
  const restored = store.save('/repo', 'one', 'task', {}, 3);
  assert.equal(restored.effective.tools.scope, 'global');
  assert.deepEqual(restored.effective.color.binding, { value: 'blue' });
});
test('profiles survive restart; stale revisions and invalid layers never overwrite', (t) => {
  const { store, dir } = fixture(t);
  store.save('/repo', '', 'global', { language: { value: 'cs' } }, 0);
  const restarted = new HarnessProfiles(dir);
  assert.equal(restarted.view('/repo').revision, 1);
  assert.throws(() => restarted.save('/repo', '', 'global', {}, 0), /changed elsewhere/);
  assert.throws(() => restarted.save('/repo', '', 'task', {}, 1), /task ID/);
  for (const value of [[], null, { a: { value: {} } }, { a: { value: 'x', resource: 'y' } }, JSON.parse('{"__proto__":null}')]) assert.throws(() => parseHarnessLayer(value));
  assert.equal(restarted.view('/repo').revision, 1);
  writeFileSync(path.join(dir, 'harness-profiles.json'), 'broken');
  assert.throws(() => restarted.save('/repo', '', 'global', {}, 1), /not been overwritten/);
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
  assert.match(snapshot, /"value": "cs"/);
  assert.doesNotMatch(snapshot, /"value": "en"/);
  assert.match(snapshot, /Rules and instruction precedence/);
  assert.match(snapshot, /"scope": "task"/);
  store.save(dir, 'task', 'task', { language: { value: 'fr' } }, 2);
  assert.match(snapshot, /"value": "cs"/);
  assert.notEqual(await harnessHandoff(dir, dir, 'task', false), snapshot);
  store.save(dir, '', 'repository', { missing: { resource: 'missing' } }, 3);
  await assert.rejects(harnessHandoff(dir, dir, 'task', false), /unavailable/);
});
test('only Opora planning prompts get assignment instructions', () => {
  assert.match(harnessPlannerBrief('original', 'planning.opora'), /office-harness --assign/);
  assert.match(harnessPlannerBrief('original', 'planning.router'), /Global configuration is administrator-owned/);
  assert.equal(harnessPlannerBrief('original', 'planning.plan'), 'original');
});

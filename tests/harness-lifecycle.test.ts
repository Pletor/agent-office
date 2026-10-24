import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessProfiles } from '../src/server/harness/profiles.js';
import { advanceLifecycle, parseLifecycle, type LifecycleEvidence, type ToolVersion } from '../src/server/harness/lifecycle.js';

const scope = { peer: 'http://127.0.0.1:8740', project: 'p', workspace: 'w', problem: 'testing:node' };
const version = (name: string): ToolVersion => ({ id: 'script:' + name, digest: name.repeat(64), category: 'scripts', requires: ['command:node'] });
const a = version('a'), b = version('b'), c = version('c');
const proof = (v: ToolVersion, baseline = a, eligible = true): LifecycleEvidence => ({ scope, version: v, baseline,
  eligible, policyDigest: 'd'.repeat(64), evidenceDigest: (eligible ? 'e' : 'f').repeat(64) });
function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-lifecycle-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return { dir, store: new HarnessProfiles(dir) };
}

test('durable promotion and fresh rollback preserve manual layers and survive restart', async t => {
  const { dir, store } = setup(t);
  await store.save('/repo', '', 'repository', { selected: { resource: 'guide:testing' }, blocked: null }, 0);
  let result = await store.advanceTool('/repo', scope, 1, 'promote', async () => ({ current: proof(a) }));
  result = await store.advanceTool('/repo', scope, result.revision, 'promote', async previous => {
    assert.deepEqual(previous?.active, a); return { current: proof(b, a) };
  });
  assert.deepEqual(new HarnessProfiles(dir).lifecycle('/repo', scope).state?.previous, a);
  result = await store.advanceTool('/repo', scope, result.revision, 'reconcile', async () => ({ current: proof(b, a, false), fallback: proof(a) }));
  assert.equal(result.state.status, 'stable'); assert.deepEqual(result.state.active, a);
  assert.equal(result.state.previous, null); assert.equal(result.state.audit.at(-1)?.action, 'rollback');
  assert.equal(result.state.audit.at(-1)?.evidenceDigest, proof(a).evidenceDigest);
  assert.equal(result.state.audit.at(-1)?.triggerEvidenceDigest, proof(b, a, false).evidenceDigest);
  assert.equal(result.state.audit.at(-1)?.policyDigest, proof(a).policyDigest);
  assert.deepEqual(store.view('/repo').layers.repository, { selected: { resource: 'guide:testing' }, blocked: null });
  await store.save('/repo', '', 'repository', { manual: { value: true } }, result.revision);
  assert.deepEqual(store.lifecycle('/repo', scope).state, result.state);
  assert.equal(store.lifecycle('/neighbor', scope).state, undefined);
  assert.equal(store.lifecycle('/repo', { ...scope, workspace: 'other' }).state, undefined);
});

test('unknown current evidence suspends and unverified fallback never restores stable status', async t => {
  const { store } = setup(t);
  await store.advanceTool('/repo', scope, 0, 'promote', async () => ({ current: proof(a) }));
  await store.advanceTool('/repo', scope, 1, 'promote', async () => ({ current: proof(b) }));
  const result = await store.advanceTool('/repo', scope, 2, 'reconcile', async () => ({ current: proof(b, a, false), fallback: proof(a, a, false) }));
  assert.equal(result.state.status, 'suspended'); assert.deepEqual(result.state.active, b);
  await assert.rejects(store.advanceTool('/repo', scope, 3, 'promote', async () => ({ current: proof(c, b) })));
});

test('authority failure or changed revision publishes nothing and does not call a stale reader', async t => {
  const { dir, store } = setup(t);
  await store.advanceTool('/repo', scope, 0, 'promote', async () => ({ current: proof(a) }));
  const bytes = readFileSync(path.join(dir, 'harness-profiles.json'), 'utf8');
  await assert.rejects(store.advanceTool('/repo', scope, 0, 'promote', async () => { assert.fail('stale reader called'); }));
  await assert.rejects(store.advanceTool('/repo', scope, 1, 'promote', async () => { throw new Error('lease expired'); }));
  assert.equal(readFileSync(path.join(dir, 'harness-profiles.json'), 'utf8'), bytes);
});

test('execution authority is fenced again at publication after evidence was read', async t => {
  const { store } = setup(t); let checks = 0;
  await assert.rejects(store.advanceTool('/repo', scope, 0, 'promote', async () => ({ current: proof(a),
    assertCurrent: () => { if (++checks > 1) throw new Error('execution withdrawn'); } })), /execution withdrawn/);
  assert.ok(checks >= 2); assert.equal(store.lifecycle('/repo', scope).revision, 0);
  assert.equal(store.lifecycle('/repo', scope).state, undefined);
});

test('two store writers cannot publish lifecycle and manual edits on the same revision', async t => {
  const { dir, store } = setup(t);
  const other = new HarnessProfiles(dir);
  const results = await Promise.allSettled([
    store.advanceTool('/repo', scope, 0, 'promote', async () => ({ current: proof(a) })),
    other.save('/repo', '', 'repository', { manual: { value: true } }, 0),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(store.view('/repo').revision, 1);
});

test('first lifecycle publication migrates v1 task markers without changing layer bytes', async t => {
  const { dir, store } = setup(t);
  const layers = { 'task:old-repo:old-node': { selected: { resource: 'guide:testing' } } };
  writeFileSync(path.join(dir, 'harness-profiles.json'), JSON.stringify({ revision: 7, layers }));
  await store.advanceTool('/repo', scope, 7, 'promote', async () => ({ current: proof(a) }));
  const stored = JSON.parse(readFileSync(path.join(dir, 'harness-profiles.json'), 'utf8'));
  assert.equal(stored.version, 2); assert.deepEqual(stored.layers, layers);
  assert.deepEqual(stored.legacyTasks, Object.keys(layers));
});

test('foreign evidence, baseline drift, capability expansion and unrelated rollback fail closed', () => {
  const first = advanceLifecycle(scope, undefined, { current: proof(a) }, 'promote');
  for (const current of [proof(b, c), { ...proof(b), scope: { ...scope, project: 'other' } },
    proof({ ...b, requires: ['command:node', 'network:any'] }), proof(b, a, false)]) {
    assert.throws(() => advanceLifecycle(scope, first, { current }, 'promote'));
  }
  const second = advanceLifecycle(scope, first, { current: proof(b) }, 'promote');
  assert.throws(() => advanceLifecycle(scope, second, { current: proof(b, a, false), fallback: proof(c) }, 'reconcile'));
  assert.throws(() => advanceLifecycle(scope, second, { current: proof(a) }, 'reconcile'));
});

test('native verification sources survive restart, suspension and exact predecessor rollback', async t => {
  const { dir, store } = setup(t);
  const sourceA = { verificationId: 'native-a', reportDigest: 'a'.repeat(64) };
  const sourceB = { verificationId: 'native-b', reportDigest: 'b'.repeat(64) };
  await store.advanceTool('/repo', scope, 0, 'promote', async () => ({ current: { ...proof(a), source: sourceA } }));
  await store.advanceTool('/repo', scope, 1, 'promote', async () => ({ current: { ...proof(b), source: sourceB } }));
  const stored = new HarnessProfiles(dir).lifecycle('/repo', scope).state!;
  assert.deepEqual(stored.source, sourceB); assert.deepEqual(stored.previousSource, sourceA);
  await store.advanceTool('/repo', scope, 2, 'reconcile', async () => ({ current: proof(b, a, false) }));
  const suspended = store.lifecycle('/repo', scope).state!;
  assert.equal(suspended.status, 'suspended'); assert.deepEqual(suspended.source, sourceB);
  assert.deepEqual(suspended.previousSource, sourceA);
  const refreshedSourceA = { ...sourceA, reportDigest: 'c'.repeat(64) };
  const result = await store.advanceTool('/repo', scope, 3, 'reconcile', async () => ({ current: proof(b, a, false),
    fallback: { ...proof(a), source: refreshedSourceA } }));
  assert.deepEqual(result.state.source, refreshedSourceA); assert.equal(result.state.previousSource, undefined);
  assert.equal(result.state.audit.at(-1)?.action, 'rollback');
  sourceA.reportDigest = 'd'.repeat(64);
  assert.deepEqual(new HarnessProfiles(dir).lifecycle('/repo', scope).state?.source, refreshedSourceA);
});

test('legacy lifecycle remains readable but malformed or orphaned sources are refused', () => {
  const legacy = advanceLifecycle(scope, undefined, { current: proof(a) }, 'promote');
  assert.equal(parseLifecycle(legacy).source, undefined);
  for (const source of [{ verificationId: 'ok\n', reportDigest: 'a'.repeat(64) },
    { verificationId: 'ok', reportDigest: 'a'.repeat(64) + '\n' },
    { verificationId: 'ok', reportDigest: 'a'.repeat(64), token: 'private' }, null]) {
    assert.throws(() => advanceLifecycle(scope, undefined, { current: { ...proof(a), source } as LifecycleEvidence }, 'promote'));
  }
  assert.throws(() => parseLifecycle({ ...legacy, previousSource: { verificationId: 'orphan', reportDigest: 'a'.repeat(64) } }));
});

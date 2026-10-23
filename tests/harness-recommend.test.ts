import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { HarnessLibrary, harnessSources } from '../src/server/harness/catalog.js';
import { recommendHarness, toolVersion } from '../src/server/harness/recommend.js';
import { nativeHistory, parseNativeHistory } from '../src/server/harness/native-outcomes.js';
import { parseToolbox } from '../src/server/harness/toolbox.js';
import { resolveHarness, type HarnessProfile } from '../src/shared/harness-cascade.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
test('configuration identity matches the independent Canvas Python canonical JSON fixture', () => {
  assert.equal(toolVersion('rule:quality', 'rules', 'b'.repeat(64), ['command:npm']), 'a8d79673974d61c7c701b7018a1f6e386048ad786c2ff6a14d449b4ab5313ba9');
});
async function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-recommend-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'scripts'));
  for (const name of ['a', 'b', 'c']) writeFileSync(path.join(dir, 'scripts', name + '.mjs'), 'export const name = ' + JSON.stringify(name));
  const resources = ['a', 'b', 'c'].map((name, i) => ({ path: 'scripts/' + name + '.mjs', problems: ['ts.references'], requires: ['command:node'], priority: 100 - i }));
  const saveManifest = () => writeFileSync(path.join(dir, 'toolbox.json'), JSON.stringify({ schema: 'harness.toolbox/1', resources }));
  saveManifest();
  const library = new HarnessLibrary([{ name: 'Project / .harness', dir }]), catalog = await library.list();
  const id = (name: string) => catalog.entries.find(entry => entry.path === 'scripts/' + name + '.mjs')!.id;
  return { dir, library, id, resources, saveManifest };
}
function history(rows: unknown[]) {
  return parseNativeHistory({ schema: 'harness.learning/1', authority: 'native-outbox-projection', scope: { project: 'p', workspace: 'w', nodeId: null }, limited: false, cohorts: rows }, 'p', 'w');
}
function cohort(resource: string, content: string, pass = 5, fail = 0, tier = 'verified', requires = ['command:node']) {
  return { resource, digest: sha(content), versionDigest: toolVersion(resource, 'scripts', sha(content), requires), problem: 'ts.references', tier,
    signal: 'acceptance', tasks: Math.min(pass + fail, 3), rate: { pass, fail, unknown: 0, executions: pass + fail, percent: 999 } };
}
function profile(global = {}, repository = {}, task = {}): HarnessProfile {
  const layers = { global, repository, task }; return { revision: 3, layers, effective: resolveHarness(layers) };
}

test('unknown history adds at most one tool candidate and preserves exact pinned content and requirements', async t => {
  const f = await fixture(t), result = await recommendHarness(f.library, 'ts.references', ['command:node']);
  assert.deepEqual(result.selected, ['guide:instructions', 'guide:testing', f.id('a')]);
  assert.equal(result.history.status, 'unavailable'); assert.equal(result.promotionAllowed, false);
  assert.equal(result.candidates.find(entry => entry.id === f.id('a'))!.verified, null);
  assert.deepEqual(result.kit!.resources.find(entry => entry.resource === f.id('a'))!.requires, ['command:node']);
  assert.match(result.capabilityEvidence, /caller-declared/);
});
test('insufficient requirements omit optional candidates and block an explicit assignment without silently replacing it', async t => {
  const f = await fixture(t);
  const result = await recommendHarness(f.library, 'ts.references', []);
  assert.equal(result.selected.includes(f.id('a')), false);
  assert.equal(result.proposalStatus, 'reference-only'); assert.deepEqual(result.unresolvedCandidateRequirements, ['command:node']);
  const explicit = await recommendHarness(f.library, 'ts.references', [], profile({ work: { resource: f.id('a') } }));
  assert.equal(explicit.kit, null); assert.equal(explicit.constraints[0].reason, 'missing-declared-capabilities');
});
test('native verified evidence outranks priority; self reports and other versions cannot manufacture observed success', async t => {
  const f = await fixture(t), b = await f.library.read(f.id('b'));
  const rows = history([cohort(f.id('b'), b!.text), cohort(f.id('a'), 'old content'), cohort(f.id('c'), (await f.library.read(f.id('c')))!.text, 100, 0, 'reported')]);
  const result = await recommendHarness(f.library, 'ts.references', ['command:node'], undefined, rows);
  assert.equal(result.candidates.find(entry => entry.id === f.id('b'))!.state, 'observed-success');
  assert.equal(result.candidates.find(entry => entry.id === f.id('b'))!.verified!.percent, 100, 'untrusted percent field is recomputed');
  assert.equal(result.candidates.find(entry => entry.id === f.id('a'))!.verified, null);
  assert.equal(result.candidates.find(entry => entry.id === f.id('c'))!.state, 'candidate');
  assert.deepEqual(result.selected.slice(2), [f.id('b'), f.id('a')]);
  f.resources[1].requires = ['command:npm']; f.saveManifest();
  const changed = await recommendHarness(f.library, 'ts.references', ['command:npm', 'command:node'], undefined, rows);
  assert.equal(changed.candidates.find(entry => entry.id === f.id('b'))!.verified, null, 'requirements change isolates the configuration cohort');
});
test('disabled inheritance and administrator auto-off policy survive recommendation', async t => {
  const f = await fixture(t);
  const inherited = profile({ quality: { resource: f.id('a') } }, { quality: null });
  const result = await recommendHarness(f.library, 'ts.references', ['command:node'], inherited);
  assert.equal(result.selected.includes(f.id('a')), false); assert.ok(result.selected.includes(f.id('b')));
  const off = await recommendHarness(f.library, 'ts.references', ['command:node'], profile({ 'settings.harness.auto': { value: false } }));
  assert.deepEqual(off.selected, []); assert.equal(off.kit!.resources[0].resource, 'profile:settings');
  assert.match(off.kit!.resources[0].content, /not permissions/);
});
test('low observed success suppresses automatic selection but never silently erases an explicit policy choice', async t => {
  const f = await fixture(t), text = (await f.library.read(f.id('a')))!.text;
  const rows = history([cohort(f.id('a'), text, 0, 4)]);
  const result = await recommendHarness(f.library, 'ts.references', ['command:node'], undefined, rows);
  assert.equal(result.selected.includes(f.id('a')), false);
  const explicit = await recommendHarness(f.library, 'ts.references', ['command:node'], profile({ work: { resource: f.id('a') } }), rows);
  assert.ok(explicit.selected.includes(f.id('a'))); assert.equal(explicit.candidates[0].state, 'low-observed-success');
});
test('a policy changed during preparation is rejected instead of pinning mismatched metadata', async t => {
  const f = await fixture(t), original = f.library.read.bind(f.library); let changed = false;
  t.mock.method(f.library, 'read', async (id: string) => {
    const value = await original(id);
    if (id === f.id('a') && !changed) { changed = true; f.resources[0].requires = ['command:other']; f.saveManifest(); }
    return value;
  });
  await assert.rejects(recommendHarness(f.library, 'ts.references', ['command:node']), /Toolbox changed/);
});

test('linked regression reports suppress automatic reuse and warn without erasing explicit choices', async t => {
  const f = await fixture(t), content = (await f.library.read(f.id('a')))!.text;
  const guardrails = { source: 'native-review-eval-cases', affectedExecutions: 1, incidentReportExecutions: 1, revertedExecutions: 1, productionExposure: 'unknown', causalAttribution: false };
  const rows = history([{ ...cohort(f.id('a'), content), guardrails }]);
  const result = await recommendHarness(f.library, 'ts.references', ['command:node'], undefined, rows);
  assert.equal(result.selected.includes(f.id('a')), false);
  const candidate = result.candidates.find(entry => entry.id === f.id('a'))!;
  assert.equal(candidate.state, 'regression-review-needed'); assert.equal(candidate.observed, false);
  assert.equal(candidate.verified!.percent, 100, 'acceptance rates are never rewritten as causal failure');
  const explicit = await recommendHarness(f.library, 'ts.references', ['command:node'], profile({ work: { resource: f.id('a') } }), rows);
  assert.ok(explicit.selected.includes(f.id('a'))); assert.equal(explicit.warnings[0].resource, f.id('a')); assert.ok(explicit.kit);
  for (const patch of [{ affectedExecutions: 0 }, { affectedExecutions: 6 }, { incidentReportExecutions: -1 }, { causalAttribution: true }, { productionExposure: 'verified' }]) {
    assert.throws(() => history([{ ...cohort(f.id('a'), content), guardrails: { ...guardrails, ...patch } }]));
  }
});
test('manifests cannot assert verification, escape a source, or duplicate a path', () => {
  const item = { path: 'scripts/a.mjs', problems: ['x'], requires: [], priority: 0 };
  for (const resources of [[{ ...item, verified: true }], [{ ...item, path: '../private.md' }], [item, item]]) assert.throws(() => parseToolbox({ schema: 'harness.toolbox/1', resources }));
});
test('native history scope, authority, denominator and wire budget are independently checked', async () => {
  assert.throws(() => parseNativeHistory({ schema: 'harness.learning/1', authority: 'offline-untrusted' }, 'p', 'w'));
  const row = cohort('a', 'text'); row.rate.executions = 100;
  assert.throws(() => history([row]));
  const value = await nativeHistory('http://configured.test', 'p', 'w', async (url, init) => {
    assert.equal(new URL(String(url)).hostname, 'configured.test'); assert.equal(init!.redirect, 'error');
    return new Response('x'.repeat(256 * 1024 + 1), { status: 200 });
  });
  assert.equal(value.status, 'unavailable'); assert.deepEqual(value.cohorts, []);
});
test('explicit shared publication is visible across floors while machine resources and credentials stay private', async t => {
  const f = await fixture(t), shared = path.join(f.dir, 'scripts'), machine = path.join(f.dir, 'machine');
  mkdirSync(machine); writeFileSync(path.join(machine, 'private.md'), 'machine-only'); writeFileSync(path.join(shared, '.env'), 'not published');
  const env = { AGENT_OFFICE_SHARED_HARNESS_DIR: shared, AGENT_OFFICE_HARNESS_DIR: machine };
  const first = await new HarnessLibrary(harnessSources(path.join(f.dir, 'first'), false, env)).list();
  const second = await new HarnessLibrary(harnessSources(path.join(f.dir, 'second'), false, env)).list();
  const entry = first.entries.find(entry => entry.source === 'Shared harness' && entry.path === 'a.mjs')!;
  assert.equal(second.entries.find(other => other.path === 'a.mjs')!.id, entry.id);
  assert.ok(!first.entries.some(entry => entry.path.includes('.env') || entry.source.includes('machine')));
});

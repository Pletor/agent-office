import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { HarnessLibrary, harnessSources } from '../src/server/harness/catalog.js';
import { recommendHarness } from '../src/server/harness/recommend.js';
import { parseToolbox } from '../src/server/harness/toolbox.js';
import { resolveHarness, type HarnessProfile } from '../src/shared/harness-cascade.js';
import type { SharedEvidence } from '../src/server/harness/native-shared.js';
import type { FixtureQuarantine } from '../src/server/harness/native-verifier.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function profile(global = {}, repository = {}, task = {}): HarnessProfile {
  const layers = { global, repository, task }; return { revision: 3, layers, effective: resolveHarness(layers) };
}
function availableHistory() {
  return { status: 'available' as const, limited: false, cohorts: [], reason: 'native-outbox-projection' };
}
function completeFixtures(quarantine: FixtureQuarantine = { complete: true, unboundFailures: 0, cohorts: [] }) {
  return { status: 'available' as const, limited: false, unknown: 0, evaluations: [], quarantine };
}

async function sharedFixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-shared-recommend-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project', '.harness'), shared = path.join(root, 'shared');
  mkdirSync(path.join(project, 'scripts'), { recursive: true }); mkdirSync(path.join(shared, 'scripts'), { recursive: true });
  const projectText = 'export const source = "project"';
  const sharedText = 'export const source = "shared"';
  writeFileSync(path.join(project, 'scripts', 'project.mjs'), projectText);
  writeFileSync(path.join(shared, 'scripts', 'shared.mjs'), sharedText);
  writeFileSync(path.join(project, 'toolbox.json'), JSON.stringify({ schema: 'harness.toolbox/1', resources: [
    { path: 'scripts/project.mjs', problems: ['ts.references'], requires: ['command:node'], priority: 100 },
  ] }));
  writeFileSync(path.join(shared, 'toolbox.json'), JSON.stringify({ schema: 'harness.toolbox/2', resources: [
    { path: 'scripts/shared.mjs', problems: ['ts.references'], requires: ['command:node'], priority: -100, publication: 'team.shared' },
  ] }));
  const library = new HarnessLibrary(harnessSources(path.join(root, 'project'), false, { AGENT_OFFICE_SHARED_HARNESS_DIR: shared }));
  const catalog = await library.list();
  const idFor = (source: string, file: string) => {
    const entry = catalog.entries.find(item => item.source === source && item.path === file);
    assert.ok(entry, `catalog contains ${source} ${file}`);
    return entry.id;
  };
  return { library, project, projectId: idFor('Project / .harness', 'scripts/project.mjs'), sharedId: idFor('Shared harness', 'scripts/shared.mjs'), projectText, sharedText };
}
const eligible = (): SharedEvidence => ({ status: 'eligible', publication: 'team.shared', projects: 3, images: 2, evidenceDigest: 'a'.repeat(64) });

test('eligible v2 shared source gets the single unknown slot despite lower priority, without creating local evidence', async t => {
  const f = await sharedFixture(t), result = await recommendHarness(f.library, 'ts.references', ['command:node'], undefined,
    availableHistory(), undefined, completeFixtures(), undefined, async () => eligible());
  assert.deepEqual(result.selected.slice(2), [f.sharedId]);
  assert.equal(result.selection.find(s => s.resource === f.sharedId)?.reason, 'shared-fixture-exploration');
  assert.equal(result.selected.filter(id => id === f.projectId || id === f.sharedId).length, 1);
  const candidate = result.candidates.find(item => item.id === f.sharedId)!;
  assert.equal(candidate.shared?.status, 'eligible'); assert.equal(candidate.observed, false);
  assert.equal(candidate.verified, null); assert.equal(candidate.tasks, 0);
  assert.equal(result.promotionAllowed, false);
  assert.equal(result.kit!.resources.find(item => item.resource === f.sharedId)!.content, f.sharedText);
});

test('shared unavailable or ineligible suppresses automatic use and warns while preserving explicit policy', async t => {
  const f = await sharedFixture(t);
  for (const evidence of [
    { status: 'unavailable', publication: 'team.shared', reason: 'peer-down' } as const,
    { status: 'ineligible', publication: 'team.shared', reason: 'shared-evidence-ineligible' } as const,
  ]) {
    const reader = async () => evidence;
    const automatic = await recommendHarness(f.library, 'ts.references', ['command:node'], undefined, availableHistory(), undefined, completeFixtures(), undefined, reader);
    assert.ok(!automatic.selected.includes(f.sharedId));
    const explicit = await recommendHarness(f.library, 'ts.references', ['command:node'], profile({ work: { resource: f.sharedId } }), availableHistory(), undefined, completeFixtures(), undefined, reader);
    assert.ok(explicit.selected.includes(f.sharedId));
    assert.ok(explicit.warnings.some(warning => warning.resource === f.sharedId && warning.reason === 'shared-revalidation-needed' && warning.preserved === 'explicit'));
  }
});

test('automatic selection gates for auto-off, capabilities, quarantine, lifecycle block, and unknown local history win', async t => {
  const f = await sharedFixture(t), reader = async () => eligible();
  const blocked = { status: 'unavailable' as const, revision: 2, blocked: [{ id: f.sharedId, digest: sha(f.sharedText), category: 'scripts', requires: ['command:node'] }], reason: 'reassessment-unavailable' };
  const cases = [
    { name: 'auto-off', capabilities: ['command:node'], profile: profile({ 'settings.harness.auto': { value: false } }), history: availableHistory(), fixtures: completeFixtures() },
    { name: 'missing capability', capabilities: [], profile: undefined, history: availableHistory(), fixtures: completeFixtures() },
    { name: 'incomplete quarantine', capabilities: ['command:node'], profile: undefined, history: availableHistory(), fixtures: completeFixtures({ complete: false, unboundFailures: 1, cohorts: [] }) },
    { name: 'local exact-version failure', capabilities: ['command:node'], profile: undefined, history: availableHistory(), fixtures: completeFixtures({ complete: true, unboundFailures: 0, cohorts: [{ problem: 'ts.references', candidate: { id: f.sharedId, digest: sha(f.sharedText) }, verificationId: 'failed-local-trial' }] }) },
    { name: 'lifecycle block', capabilities: ['command:node'], profile: undefined, history: availableHistory(), fixtures: completeFixtures(), lifecycle: blocked },
    { name: 'unknown local history', capabilities: ['command:node'], profile: undefined, history: { status: 'unavailable' as const, limited: false, cohorts: [], reason: 'peer-down' }, fixtures: completeFixtures() },
  ];
  for (const item of cases) {
    const result = await recommendHarness(f.library, 'ts.references', item.capabilities, item.profile, item.history, undefined, item.fixtures, item.lifecycle, reader);
    assert.ok(!result.selected.includes(f.sharedId), item.name);
  }
});

test('toolbox v2 publications are shared-source only while legacy v1 descriptors remain valid', async t => {
  const legacy = { path: 'scripts/a.mjs', problems: ['ts.references'], requires: ['command:node'], priority: 10 };
  assert.deepEqual(parseToolbox({ schema: 'harness.toolbox/1', resources: [legacy] }), [{ ...legacy }]);
  assert.deepEqual(parseToolbox({ schema: 'harness.toolbox/2', resources: [{ ...legacy, publication: 'team.shared' }] })[0].publication, 'team.shared');
  assert.throws(() => parseToolbox({ schema: 'harness.toolbox/2', resources: [legacy] }));
  const f = await sharedFixture(t);
  writeFileSync(path.join(f.project, 'toolbox.json'), JSON.stringify({ schema: 'harness.toolbox/2', resources: [{ ...legacy, path: 'scripts/project.mjs', publication: 'team.shared' }] }));
  await assert.rejects(recommendHarness(f.library, 'ts.references', ['command:node']), /intentionally shared/);
});

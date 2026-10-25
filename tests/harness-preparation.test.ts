import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256 } from '../src/server/harness/invoke-node.js';
import { prepareAccepted } from '../src/server/harness/prepare-accepted.js';

const resource = (category = 'scripts', requires = ['command:node']) => ({ resource: 'script:one', category,
  content: "throw new Error('Resource contents must never run during preparation')", digest: '', requires });
function fixture(category?: string, requires?: string[]) {
  const r = resource(category, requires); r.digest = sha256(r.content);
  return { execution: { executionId: 'execution-1', epoch: 1, project: 'p', workspace: 'w', nodeId: 'n',
    acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64) }, kit: { schema: 'harness.kit/1', resources: [r] } };
}

test('preparation probes actual worker Node without executing accepted contents and cleans scratch', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prepare-test-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const value = fixture(), before = JSON.stringify(value);
  const report = await prepareAccepted(async () => value, dir, { tempRoot: dir });
  assert.equal(report.ready, true); assert.equal(report.scope, 'worker-process');
  assert.equal(report.resources[0].state, 'prepared'); assert.equal(report.probe?.outcome, 'pass');
  assert.equal(report.resourceContentsExecuted, false); assert.equal(report.permissionsGranted, false);
  assert.equal(report.independentlyVerified, false); assert.equal(report.promotionAllowed, false);
  assert.equal(JSON.stringify(value), before); assert.deepEqual(await readdir(dir), []);
  assert.ok(!JSON.stringify(report).includes('Resource contents must never'));
});

test('context-only readiness does not claim executable adapter support or ignore requirements', async () => {
  for (const category of ['instructions', 'skills', 'rules', 'memory', 'testing', 'operations']) {
    const report = await prepareAccepted(async () => fixture(category, []), process.cwd());
    assert.equal(report.ready, true); assert.equal(report.resources[0].mode, 'context'); assert.equal(report.probe, null);
  }
  for (const [category, requires] of [['mcp', []], ['plugins', []], ['permissions', []], ['hooks', []], ['tools', []],
    ['commands', []], ['scripts', ['command:node', 'network:any']], ['rules', ['command:npm']]] as [string, string[]][]) {
    const report = await prepareAccepted(async () => fixture(category, requires), process.cwd());
    assert.equal(report.ready, false); assert.equal(report.resources[0].state, 'unsupported'); assert.equal(report.probe, null);
  }
});

test('stale or unavailable execution cannot produce prepared resources', async () => {
  const value = fixture('rules', []); let calls = 0;
  const stale = await prepareAccepted(async () => ++calls === 1 ? value : { ...value, execution: { ...value.execution, epoch: 2 } }, process.cwd());
  assert.equal(stale.ready, false); assert.equal(stale.authorityCurrentAtCompletion, false);
  assert.equal(stale.resources[0].state, 'unavailable');
  calls = 0;
  const missing = await prepareAccepted(async () => { if (++calls > 1) throw new Error('offline'); return value; }, process.cwd());
  assert.equal(missing.ready, false);
});

test('tampered digests, duplicate resources and malformed declarations fail before preparation', async () => {
  for (const mutation of [(r: ReturnType<typeof resource>) => { r.digest = 'f'.repeat(64); },
    (r: ReturnType<typeof resource>) => { r.requires = ['command:node', 'command:node']; },
    (r: ReturnType<typeof resource>) => { r.category = 'invented'; }]) {
    const value = fixture(); mutation(value.kit.resources[0]);
    await assert.rejects(prepareAccepted(async () => value, process.cwd()));
  }
  const value = fixture(); value.kit.resources.push(value.kit.resources[0]);
  await assert.rejects(prepareAccepted(async () => value, process.cwd()));
});

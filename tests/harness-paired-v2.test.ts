import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { preparePair } from '../src/server/harness/paired-plan.js';
import { evaluatePair } from '../src/server/harness/paired-evaluation.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const plan = { schema: 'harness.paired-node/1', problem: 'typescript', baseline: 'script:base', candidate: 'script:next',
    cases: [{ id: 'case:one', args: [], expectedStdout: 'ok\n' }] };
  const resources = [
    { slot: 'testing.plan', resource: 'test:pair', category: 'testing', content: JSON.stringify(plan), requires: [] as string[] },
    { slot: 'scripts.base', resource: 'script:base', category: 'scripts', content: "console.log('bad')", requires: ['command:node'] },
    { slot: 'scripts.next', resource: 'script:next', category: 'scripts', content: "console.log('ok')", requires: ['command:node'] },
  ].map(r => ({ ...r, digest: sha(r.content) }));
  return { execution: { executionId: 'exec-1', epoch: 1, project: 'p', workspace: 'w', nodeId: 'n',
    acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64) }, kit: {
    schema: 'harness.kit/2', problems: ['evaluation:paired-node'], resources,
    selection: { schema: 'harness.selection/1', policy: 'harness.recommendation/1', problem: 'evaluation:paired-node',
      profileRevision: 1, declaredCapabilities: ['command:node'], evidence: 'caller-declared-selection',
      entries: resources.map((r, order) => ({ resource: r.resource, digest: r.digest, order, reason: 'explicit-assignment',
        versionDigest: sha(JSON.stringify({ category: r.category, digest: r.digest, requires: r.requires, resource: r.resource })),
        assignments: [{ slot: r.slot, scope: 'global', node: null }] })) } } };
}

test('paired v2 validates optional dependencies before any adapter call', async () => {
  const value = fixture(), before = structuredClone(value);
  const installed = existsSync(new URL('../src/server/harness/adapter-kit.ts', import.meta.url))
    && existsSync(new URL('../src/server/harness/accepted-kit.ts', import.meta.url));
  let calls = 0;
  const never = async () => { calls++; throw new Error('must not execute'); };
  if (!installed) {
    await assert.rejects(preparePair(value, 'test:pair'), /v2 validation is unavailable/);
    await assert.rejects(evaluatePair(async () => value, never, 'test:pair', process.cwd()), /v2 validation is unavailable/);
  } else {
    const prepared = await preparePair(value, 'test:pair');
    assert.equal(prepared.selectionDigest, sha(JSON.stringify(value.kit.selection)));
    const broken = structuredClone(value); broken.kit.selection.entries[0].versionDigest = '0'.repeat(64);
    await assert.rejects(preparePair(broken, 'test:pair'));
    await assert.rejects(evaluatePair(async () => broken, never, 'test:pair', process.cwd()));
    let reads = 0;
    const changed = structuredClone(value); changed.kit.selection.profileRevision++;
    const result = await evaluatePair(async () => ++reads === 1 ? value : changed,
      async read => { await read(); return never(); }, 'test:pair', process.cwd());
    assert.equal(result.status, 'incomplete'); assert.equal(result.observedInvocations, 0);
    assert.equal(result.authorityCurrentAtCompletion, false);
  }
  assert.equal(calls, 0); assert.deepEqual(value, before);
});

test('composed paired CLI runs pinned v2 baseline and candidate without promotion authority', async t => {
  if (!existsSync(new URL('../src/server/harness/accepted-kit.ts', import.meta.url))
    || !existsSync(new URL('../src/server/harness/adapter-kit.ts', import.meta.url))) {
    t.skip('Positive path requires composed accepted-kit and invocation modules'); return;
  }
  const value = fixture(), before = structuredClone(value);
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer isolated-hook');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const response = await promisify(execFile)(process.execPath, ['bin/office-harness.js', '--evaluate-pair', 'test:pair'], {
    timeout: 20_000, env: { ...process.env, AGENT_OFFICE_HOOK_URL: base, AGENT_OFFICE_WORKER_ID: 'worker', AGENT_OFFICE_HOOK_TOKEN: 'isolated-hook' },
  });
  const result = JSON.parse(response.stdout);
  assert.equal(result.status, 'complete'); assert.equal(result.observedInvocations, 2);
  assert.equal(result.baseline.fail, 1); assert.equal(result.candidate.pass, 1);
  assert.equal(result.comparison.improvements, 1); assert.equal(result.comparison.regressions, 0);
  assert.equal(result.independentlyVerified, false); assert.equal(result.promotionAllowed, false);
  assert.deepEqual(value, before);
});

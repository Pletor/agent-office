import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePairedHistory, parsePairedHistory } from '../src/server/harness/native-paired.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (letter: string) => letter.repeat(64);
function report() {
  const cases = [
    [['baseline', 'fail'], ['candidate', 'pass']],
    [['candidate', 'pass'], ['baseline', 'fail']],
    [['baseline', 'pass'], ['candidate', 'fail']],
  ] as const;
  let order = 0;
  const trials = cases.flatMap(([a, b], i) => [a, b].map(([side, outcome]) => {
    order++;
    return { case: `case-${i + 1}`, side, order, outcome, reason: outcome === 'pass' ? 'expected-output' : 'output-mismatch', invocationId: uuid(order) };
  }));
  return {
    schema: 'harness.paired-result/1', evaluationId: uuid(90), problem: 'numeric.identity', nativeProblem: 'evaluation:paired-node', evidence: 'worker-observed',
    independentlyVerified: false, causalContribution: false, promotionAllowed: false, tokens: null, cost: null,
    execution: { executionId: 'exec-1', epoch: 2, project: 'project-a', workspace: 'workspace-a', nodeId: 'node-a', acceptedRevision: 'a'.repeat(40), assignmentDigest: digest('b') },
    plan: { id: 'testing:compare', digest: digest('c') }, baseline: { id: 'script:baseline', digest: digest('d'), planned: 3, pass: 1, fail: 2, unknown: 0 },
    candidate: { id: 'script:candidate', digest: digest('e'), planned: 3, pass: 2, fail: 1, unknown: 0 },
    authorityCurrentAtCompletion: true, status: 'complete', plannedInvocations: 6, observedInvocations: 6,
    comparison: { improvements: 2, regressions: 1, incomparable: 0, passDifference: 1, conclusion: 'regression-on-fixtures' }, trials,
    // These fields are intentionally outside the public projection.
    stdout: 'private arbitrary stdout', args: ['--token', 'secret-value'],
  };
}
function history(r = report()) {
  return { schema: 'harness.paired-evaluations/1', authority: 'native-result-receipts', evidence: 'worker-reported',
    serverObserved: false, independentlyVerified: false, causalContribution: false, promotionAllowed: false,
    tokens: null, cost: null, scope: { project: 'project-a', workspace: 'workspace-a', nodeId: null },
    scannedReceipts: 1, receiptWindowLimited: false, invalidReceipts: 0, conflictingEvaluations: 0,
    evaluations: [{ sourceReceipt: 'receipt-1', report: r }] };
}
const clone = <T>(value: T): T => structuredClone(value);

test('paired history accepts consistent native evidence and returns only scoped version references', () => {
  const parsed = parsePairedHistory(history(), 'project-a', 'workspace-a');
  assert.equal(parsed.status, 'available');
  assert.deepEqual(parsed.evaluations[0], {
    executionId: 'exec-1', evaluationId: uuid(90), sourceReceipt: 'receipt-1', problem: 'numeric.identity',
    baseline: { id: 'script:baseline', digest: digest('d') }, candidate: { id: 'script:candidate', digest: digest('e') },
    plan: { id: 'testing:compare', digest: digest('c') }, improvements: 2, regressions: 1, unknownPairs: 0, status: 'complete',
  });
  assert.doesNotMatch(JSON.stringify(parsed), /private arbitrary stdout|secret-value|assignmentDigest|acceptedRevision/);
  assert.throws(() => parsePairedHistory(history(), 'foreign', 'workspace-a'));
  assert.throws(() => parsePairedHistory({ ...history(), scope: { project: 'project-a', workspace: 'foreign', nodeId: null } }, 'project-a', 'workspace-a'));
});

test('rejects forged pair summaries, trial structure, execution epoch, flags, and duplicate invocations', () => {
  const tamper = (edit: (r: ReturnType<typeof report>) => void) => { const r = report(); edit(r); assert.throws(() => parsePairedHistory(history(r), 'project-a', 'workspace-a')); };
  tamper(r => { r.comparison.improvements = 3; });
  tamper(r => { r.trials[0].order = 2; });
  tamper(r => { r.candidate.pass = 3; });
  tamper(r => { r.execution.epoch = 0; });
  tamper(r => { r.promotionAllowed = true; });
  tamper(r => { r.trials[1].invocationId = r.trials[0].invocationId; });
  tamper(r => { r.evaluationId = 'foreign-evaluation'; });
});

test('accepts internally consistent incomplete evidence as unknown, never as a pass', () => {
  const r = report();
  r.status = 'incomplete'; r.authorityCurrentAtCompletion = false; r.observedInvocations = 0;
  r.baseline.pass = 0; r.baseline.fail = 0; r.baseline.unknown = 3;
  r.candidate.pass = 0; r.candidate.fail = 0; r.candidate.unknown = 3;
  r.comparison = { improvements: 0, regressions: 0, incomparable: 3, passDifference: 0, conclusion: 'incomplete' };
  r.trials = r.trials.map(t => ({ ...t, outcome: 'unknown', reason: 'adapter-error-or-authority-unavailable', invocationId: null }));
  const parsed = parsePairedHistory(history(r), 'project-a', 'workspace-a');
  assert.equal(parsed.evaluations[0].unknownPairs, 3);
  assert.equal(parsed.evaluations[0].status, 'incomplete');
});

test('native lookup pins the paired endpoint and safely handles unavailable, redirects, invalid UTF-8, and oversized bodies', async () => {
  let requested = '';
  const good = await nativePairedHistory('http://127.0.0.1:1234/prefix', 'project-a', 'workspace-a', async (input, init) => {
    requested = String(input);
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('x-opora-actor'), 'agent; name=office-harness');
    return new Response(JSON.stringify(history()), { headers: { 'content-type': 'application/json' } });
  });
  assert.equal(good.status, 'available');
  const url = new URL(requested);
  assert.equal(url.pathname, '/api/oporahub/harness-paired-evaluations');
  assert.equal(url.searchParams.get('project'), 'project-a'); assert.equal(url.searchParams.get('workspace'), 'workspace-a');
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal((await nativePairedHistory('http://127.0.0.1', 'p', 'w', async () => new Response('', { status: 404 }))).reason, 'native-paired-unavailable');
  assert.equal((await nativePairedHistory('http://127.0.0.1', 'p', 'w', async () => { throw new Error('redirect rejected'); })).status, 'unavailable');
  assert.equal((await nativePairedHistory('http://127.0.0.1', 'p', 'w', async () => new Response(new Uint8Array([0xff])))).reason, 'native-paired-invalid-or-unreachable');
  assert.equal((await nativePairedHistory('http://127.0.0.1', 'p', 'w', async () => new Response(new Uint8Array(1024 * 1024 + 1)))).reason, 'native-paired-invalid-or-unreachable');
});

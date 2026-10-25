import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFixtureHistory, parseFixtureHistory } from '../src/server/harness/native-verifier.js';

const hash = (letter: string) => letter.repeat(64);
const id = '00000000000040008000000000000001';
const execution = {
  executionId: 'exec-1', epoch: 2, project: 'project-a', workspace: 'workspace-a', nodeId: 'node-a',
  acceptedRevision: 'a'.repeat(40), assignmentDigest: hash('b'),
};
function record(outcomes: Array<['pass' | 'fail', 'pass' | 'fail']> = [['pass', 'pass'], ['pass', 'pass']]) {
  const trials = outcomes.flatMap(([baseline, candidate], i) => {
    const first = i % 2 === 0 ? 'baseline' : 'candidate';
    return [first, first === 'baseline' ? 'candidate' : 'baseline'].map((side, j) => {
      const outcome = side === 'baseline' ? baseline : candidate;
      return { case: `case-${i + 1}`, side, order: i * 2 + j + 1, outcome,
        reason: outcome === 'pass' ? 'expected-output' : 'output-mismatch', exitCode: 0, outputDigest: hash('c') };
    });
  });
  const improvements = outcomes.filter(([b, c]) => b === 'fail' && c === 'pass').length;
  const regressions = outcomes.filter(([b, c]) => b === 'pass' && c === 'fail').length;
  const candidateFailed = outcomes.some(([, c]) => c === 'fail');
  return {
    id, domain: 'harness-fixtures', ...execution, plannedTrials: trials.length,
    trust: 'server-pending', sourceBinding: 'canvas-verified', currentEligibility: false, independentlyVerified: false,
    origin: { kind: 'harness-server-verifier', protocol: 'harness.server-fixtures/1', image: `node@sha256:${hash('d')}`,
      problem: 'evaluation:paired-node', execution: { ...execution },
      plan: { id: 'testing:compare', digest: hash('e') }, baseline: { id: 'script:baseline', digest: hash('f') },
      candidate: { id: 'script:candidate', digest: hash('1') } },
    report: { outcome: candidateFailed ? 'failed' : 'passed', trust: 'server-observed', sourceBinding: 'canvas-verified',
      currentEligibility: false, independentlyVerified: true, authorityCurrentAtCompletion: true,
      promotionAllowed: false, reportDigest: hash('2'), paired: { trials, complete: true, cleanupComplete: true,
        plannedTrials: trials.length, observedTrials: trials.length, unknownPairs: 0, improvements, regressions } },
  };
}
const history = (...requests: ReturnType<typeof record>[]) => ({ requests });
const clone = <T>(value: T): T => structuredClone(value);

test('projects server-observed exact fixture counts without execution details or promotion claims', () => {
  const pass = parseFixtureHistory(history(record()), 'project-a', 'workspace-a');
  assert.deepEqual(pass.evaluations[0], { verificationId: id, executionId: 'exec-1', problem: 'evaluation:paired-node',
    candidate: { id: 'script:candidate', digest: hash('1') }, baseline: { id: 'script:baseline', digest: hash('f') },
    plan: { id: 'testing:compare', digest: hash('e') }, improvements: 0, regressions: 0, candidateFailures: 0, cases: 2 });
  const regression = parseFixtureHistory(history(record([['pass', 'fail'], ['fail', 'pass']])), 'project-a', 'workspace-a');
  assert.equal(regression.evaluations[0].regressions, 1);
  assert.equal(regression.evaluations[0].improvements, 1);
  assert.equal(regression.unknown, 0);
  assert.equal(regression.evaluations[0].candidateFailures, 1);
  const bothFail = parseFixtureHistory(history(record([['fail', 'fail'], ['fail', 'pass']])), 'project-a', 'workspace-a');
  assert.equal(bothFail.evaluations[0].regressions, 0);
  assert.equal(bothFail.evaluations[0].candidateFailures, 1);
  assert.doesNotMatch(JSON.stringify(pass), /assignmentDigest|acceptedRevision|outputDigest|authorityCurrent|server-observed/);
});

test('rejects forged trust, scope, origin binding, inconsistent counts, and duplicate records', () => {
  const tamper = (edit: (q: ReturnType<typeof record>) => void) => {
    const q = record(); edit(q); assert.throws(() => parseFixtureHistory(history(q), 'project-a', 'workspace-a'));
  };
  tamper(q => { q.report!.trust = 'agent-reported'; });
  tamper(q => { q.project = 'foreign'; });
  tamper(q => { q.origin.execution.epoch = 3; });
  tamper(q => { q.report!.paired.regressions = 1; });
  tamper(q => { q.report!.promotionAllowed = true; });
  for (const [reason, exitCode] of [['nonzero-exit', 0], ['output-mismatch', 1]] as const) {
    const bad = record([['pass', 'fail'], ['pass', 'pass']]);
    Object.assign(bad.report!.paired.trials[1], { reason, exitCode });
    assert.throws(() => parseFixtureHistory(history(bad), 'project-a', 'workspace-a'));
  }
  const q = record(); assert.throws(() => parseFixtureHistory(history(q, clone(q)), 'project-a', 'workspace-a'));
  assert.throws(() => parseFixtureHistory(history(record()), 'foreign', 'workspace-a'));
});

test('missing problem is retained as unknown; pending and incomplete runs never count as evaluations', () => {
  const missing = record(); delete (missing.origin as { problem?: string }).problem;
  const pending = record(); pending.id = '00000000000040008000000000000002'; pending.report = null;
  const incomplete = record();
  incomplete.id = '00000000000040008000000000000003';
  incomplete.report = { outcome: 'inconclusive', trust: 'server-observed', sourceBinding: 'canvas-verified',
    currentEligibility: false, independentlyVerified: false, authorityCurrentAtCompletion: true,
    promotionAllowed: false, reportDigest: hash('3'), paired: { trials: [], complete: false, cleanupComplete: true } };
  const parsed = parseFixtureHistory(history(missing, pending, incomplete), 'project-a', 'workspace-a');
  assert.equal(parsed.evaluations.length, 0);
  assert.equal(parsed.unknown, 3);
});

test('bounded verifier-history fetch uses configured peer scope and handles absent, redirect, invalid UTF-8 and oversized peers', async () => {
  let requested = '';
  const good = await nativeFixtureHistory('http://127.0.0.1:1234/prefix', 'project-a', 'workspace-a', async (input, init) => {
    requested = String(input);
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.signal as AbortSignal).aborted, false);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-opora-actor'), 'agent; name=office-harness');
    assert.equal(headers.get('authorization'), null);
    return new Response(JSON.stringify(history(record())), { headers: { 'content-type': 'application/json' } });
  });
  assert.equal(good.status, 'available');
  const url = new URL(requested);
  assert.equal(url.pathname, '/api/oporahub/harness-verifier/requests');
  assert.equal(url.searchParams.get('project'), 'project-a');
  assert.equal(url.searchParams.get('workspace'), 'workspace-a');
  assert.equal((await nativeFixtureHistory('http://user:pass@127.0.0.1', 'p', 'w')).reason, 'invalid-configured-peer');
  assert.equal((await nativeFixtureHistory('http://127.0.0.1', 'p', 'w', async () => new Response('', { status: 404 }))).reason, 'native-fixture-unavailable');
  assert.equal((await nativeFixtureHistory('http://127.0.0.1', 'p', 'w', async () => { throw new Error('redirect rejected'); })).status, 'unavailable');
  assert.equal((await nativeFixtureHistory('http://127.0.0.1', 'p', 'w', async () => new Response(new Uint8Array([0xff])))).reason, 'native-fixture-invalid-or-unreachable');
  assert.equal((await nativeFixtureHistory('http://127.0.0.1', 'p', 'w', async () => new Response(new Uint8Array(1024 * 1024 + 1)))).reason, 'native-fixture-invalid-or-unreachable');
});


test('all-history quarantine survives an empty recent window and validates scope/completeness', () => {
  const quarantine = { schema: 'harness.fixture-quarantine/1', scope: { project: 'project-a', workspace: 'workspace-a' },
    complete: true, unboundFailures: 0, cohorts: [{ problem: 'numeric.identity',
      candidate: { id: 'script:candidate', digest: hash('1') }, verificationId: id }] };
  const parse = (q: unknown) => parseFixtureHistory({ requests: [], quarantine: q }, 'project-a', 'workspace-a');
  assert.equal(parse(quarantine).quarantine!.cohorts[0].verificationId, id);
  assert.equal(parse({ ...quarantine, complete: false, unboundFailures: 1 }).quarantine!.complete, false);
  for (const bad of [ { ...quarantine, unboundFailures: 1 }, { ...quarantine, complete: 'yes' },
    { ...quarantine, scope: { project: 'foreign', workspace: 'workspace-a' } },
    { ...quarantine, cohorts: [...quarantine.cohorts, ...quarantine.cohorts] },
    { ...quarantine, cohorts: [{ ...quarantine.cohorts[0], candidate: { id: 'script:candidate', digest: 'invalid' } }] } ]) {
    assert.throws(() => parse(bad));
  }
  assert.equal(parseFixtureHistory({ requests: [] }, 'project-a', 'workspace-a').quarantine, undefined);
});


test('validates scoped experiment capacity without treating it as reservation or permission', () => {
  const budget = { schema: 'harness.experiment-capacity/1', scope: { project: 'project-a', workspace: 'workspace-a' },
    status: 'available', limit: 2, admitted: 1, remaining: 1, capacityAvailable: true, reservation: false };
  const parse = (value: unknown) => parseFixtureHistory({ requests: [], budget: value }, 'project-a', 'workspace-a');
  assert.equal(parse(budget).budget?.remaining, 1);
  assert.equal(parse({ ...budget, admitted: 3, remaining: 0, capacityAvailable: false }).budget?.admitted, 3);
  assert.equal(parseFixtureHistory({ requests: [] }, 'project-a', 'workspace-a').budget, undefined);
  for (const change of [{ scope: { project: 'foreign', workspace: 'workspace-a' } }, { reservation: true },
    { admitted: -1 }, { admitted: 0.5 }, { limit: true }, { limit: 1001 }, { remaining: 2 },
    { capacityAvailable: false }, { status: 'disabled' }]) assert.throws(() => parse({ ...budget, ...change }));
  const disabled = { ...budget, status: 'disabled', limit: null, remaining: null, capacityAvailable: false };
  assert.equal(parse(disabled).budget?.status, 'disabled');
  assert.throws(() => parse({ ...disabled, capacityAvailable: true }));
});


test('native exploration preserves unknown and validates shared counter and five-percent boundary', () => {
  const budget = { schema: 'harness.experiment-capacity/1', scope: { project: 'project-a', workspace: 'workspace-a' },
    status: 'available', limit: 10, admitted: 1, remaining: 9, capacityAvailable: true, reservation: false };
  const exploration = { schema: 'harness.exploration-share/1', status: 'available', maxPercent: 5,
    baselineCards: 38, admitted: 1, remaining: 1, eligible: true, reservation: false, policyDigest: hash('a') };
  const parse = (value: unknown) => parseFixtureHistory({ requests: [], budget: { ...budget, exploration: value } }, 'project-a', 'workspace-a').budget?.exploration;
  assert.equal(parse(exploration)?.remaining, 1);
  assert.equal(parse({ ...exploration, baselineCards: 37, remaining: 0, eligible: false })?.eligible, false);
  assert.equal(parse(undefined), undefined);
  assert.equal(Object.hasOwn(parseFixtureHistory({ requests: [], budget }, 'project-a', 'workspace-a').budget!, 'exploration'), false);
  const unavailable = { schema: exploration.schema, status: 'unavailable', maxPercent: 5,
    baselineCards: null, admitted: null, remaining: null, eligible: false, reservation: false };
  assert.equal(parse(unavailable)?.status, 'unavailable');
  for (const change of [{ maxPercent: 6 }, { baselineCards: -1 }, { baselineCards: 38.5 },
    { baselineCards: Number.MAX_SAFE_INTEGER + 1 }, { admitted: 0 }, { remaining: 2 }, { eligible: false },
    { reservation: true }, { policyDigest: 'a'.repeat(64) + '\n' }, { status: 'ready' }]) {
    assert.throws(() => parse({ ...exploration, ...change }), /exploration/);
  }
  for (const change of [{ baselineCards: 0 }, { admitted: 0 }, { remaining: 0 }, { eligible: true }, { policyDigest: hash('b') }]) {
    assert.throws(() => parse({ ...unavailable, ...change }), /exploration/);
  }
  assert.equal('unexpected' in parse({ ...exploration, unexpected: 'discarded' })!, false);
});

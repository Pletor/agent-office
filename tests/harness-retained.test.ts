import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { readRetainedStability, validateRetainedStability } from '../src/server/harness/retained-stability.js';
import type { StabilityScope } from '../src/server/harness/stability-validation.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = (value: Record<string, unknown>) => hash(JSON.stringify(Object.fromEntries(Object.entries(value).sort())));
const scope: StabilityScope = { peer: 'https://canvas.example', project: 'draft', workspace: 'dev', problem: 'testing:node' };
const version = { id: 'script:candidate', digest: 'd'.repeat(64), category: 'scripts', requires: ['command:node'] };
const source = { verificationId: 'verification-01', reportDigest: 'c'.repeat(64) };

function assessment(eligible = true) {
  const policy = { project: scope.project, workspace: scope.workspace, approvedPlanDigests: ['b'.repeat(64)],
    minimumVerifiedOutcomes: 20, minimumVerifiedCards: 5, minimumCoveragePercent: 95 };
  const native = { schema: 'harness.retained-stability/1', authority: 'native-policy-assessment', executionAuthority: false,
    scope: { project: scope.project, workspace: scope.workspace, problem: scope.problem },
    execution: { executionId: 'exec_01', nodeId: 'card-01', epoch: 3, acceptedRevision: 'a'.repeat(40), assignmentDigest: 'e'.repeat(64) },
    candidate: { id: version.id, digest: version.digest }, baseline: { id: 'script:baseline', digest: 'f'.repeat(64) },
    plan: { id: 'testing:plan', digest: 'b'.repeat(64) }, policy, policyDigest: digest(policy), evidenceDigest: '9'.repeat(64),
    eligible, reasons: eligible ? [] : ['linked-regression'], promotionAllowed: false, reservation: false,
    evidenceBasis: { taskOutcomes: 'selected-kit-association', taskInvocationVerified: false,
      causalBenefitEstablished: false, directObservation: 'approved-fixture-cases-only' },
    cohort: eligible ? { executions: 20, verifiedPasses: 20, unknown: 0, verifiedCards: 5, coverage: 1,
      versionDigest: digest({ resource: version.id, category: version.category, digest: version.digest, requires: version.requires }), sourceDigest: '8'.repeat(64) } : null,
    guardrails: eligible ? { affectedExecutions: 0 } : { affectedExecutions: 1 },
    comparison: eligible ? { complete: true, reason: null, reports: [source, { verificationId: 'verification-02', reportDigest: '7'.repeat(64) }] }
      : { complete: false, reason: 'linked-regression', reports: [] },
    source: { kind: 'retained-native-verification', verificationId: source.verificationId,
      requestDigest: '6'.repeat(64), reportDigest: eligible ? source.reportDigest : null } };
  return native;
}

test('retained evidence validates without a current lease and returns only its exact positive source', () => {
  const value = assessment();
  const result = validateRetainedStability(value, scope, version, source);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.source, source);
  assert.equal('token' in result, false);
  assert.equal('assignment' in result, false);
});

test('retained assessment rejects scope, candidate, source, report, schema and authority poisoning', () => {
  const changes: Array<(value: any) => void> = [
    value => { value.scope.project = 'foreign'; },
    value => { value.scope.problem = 'other:problem'; },
    value => { value.candidate.digest = '0'.repeat(64); },
    value => { value.source.verificationId = 'other-verification'; },
    value => { value.source.reportDigest = '0'.repeat(64); },
    value => { value.comparison.reports[0].reportDigest = '0'.repeat(64); },
    value => { value.comparison.reports[0].verificationId = 'foreign/path'; },
    value => { value.schema = 'harness.stability-eligibility/1'; },
    value => { value.executionAuthority = true; },
    value => { value.evidenceBasis.causalBenefitEstablished = true; },
  ];
  for (const poison of changes) {
    const value = structuredClone(assessment()); poison(value);
    assert.throws(() => validateRetainedStability(value, scope, version, source));
  }
});

test('nominated verification must itself appear among the validated report proofs', () => {
  const value = assessment();
  value.comparison.reports = [{ verificationId: 'verification-02', reportDigest: '7'.repeat(64) }];
  assert.throws(() => validateRetainedStability(value, scope, version, source));
});

test('negative current policy assessment withdraws eligibility without carrying a source', () => {
  const result = validateRetainedStability(assessment(false), scope, version, source);
  assert.equal(result.eligible, false);
  assert.equal(result.source, undefined);
});

test('retained read posts only scoped verification identity and refuses redirects, oversize, and invalid JSON', async () => {
  let captured: { url: URL; init?: RequestInit } | undefined;
  const value = assessment();
  const ok = async (url: URL | RequestInfo, init?: RequestInit) => {
    captured = { url: new URL(String(url)), init };
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await readRetainedStability(scope, version, source, ok as typeof fetch);
  assert.equal(result.eligible, true);
  assert.equal(captured?.url.href, scope.peer + '/api/oporahub/harness-verifier/eligibility/retained');
  assert.equal(captured?.init?.method, 'POST');
  assert.equal(captured?.init?.redirect, 'error');
  assert.deepEqual(JSON.parse(String(captured?.init?.body)), {
    project: scope.project, workspace: scope.workspace, verificationId: source.verificationId,
  });
  assert.equal(new Headers(captured?.init?.headers).has('authorization'), false);

  await assert.rejects(readRetainedStability(scope, version, source, (async () => {
    throw new TypeError('redirect blocked');
  }) as typeof fetch));
  await assert.rejects(readRetainedStability(scope, version, source, (async () =>
    new Response('x'.repeat(256 * 1024 + 1), { status: 200 })) as typeof fetch));
  await assert.rejects(readRetainedStability(scope, version, source, (async () =>
    new Response('{invalid', { status: 200 })) as typeof fetch));
});

test('native retained endpoint redirect policy is enforced by fetch', async t => {
  const destination = http.createServer((_req, res) => { res.writeHead(302, { location: 'http://127.0.0.1/' }); res.end(); });
  await new Promise<void>(resolve => destination.listen(0, '127.0.0.1', resolve));
  t.after(() => { destination.closeAllConnections(); destination.close(); });
  const peer = 'http://127.0.0.1:' + (destination.address() as { port: number }).port;
  await assert.rejects(readRetainedStability({ ...scope, peer }, version, source));
});

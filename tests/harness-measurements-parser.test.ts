import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeInvocations, noInvocations, parseNativeInvocations, type InvocationScope } from '../src/server/harness/native-invocations.js';

const scope: InvocationScope = { project: 'p1', workspace: 'draft', nodeId: null };
const cohort = () => ({ resource: 'scripts:check', digest: 'a'.repeat(64), adapter: 'node-readonly/1', nodeVersion: 'v24.1.0',
  problem: 'typescript', invocations: 2, pass: 1, fail: 1, percent: 99, meanDurationMs: 12.5,
  outputBytes: 90, executions: 2, tasks: 2, latestSourceReceipt: 'receipt-1' });
const report = () => ({ schema: 'harness.invocations/1', scope, authority: 'native-result-receipts', evidence: 'worker-reported',
  serverObserved: false, independentlyVerified: false, causalContribution: false, promotionAllowed: false,
  coverage: 'bounded-newest-receipt-window; repeated calls are not independent trials', scannedReceipts: 2,
  limited: false, receiptWindowLimited: false, cohortsLimited: false, invalidReceipts: 0, conflictingInvocations: 0,
  tokens: null, cost: null, cohorts: [cohort()], secret: 'do not return' });
const parse = (value: unknown = report()) => parseNativeInvocations(value, scope);
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('parses worker-reported cohorts, recomputes rate and returns only safe fields', () => {
  const result = parse();
  assert.equal(result.status, 'available');
  assert.equal(result.cohorts[0].percent, 50);
  assert.equal(result.evidence, 'worker-reported');
  assert.equal(result.promotionAllowed, false);
  assert.match(result.coverage, /missing invocations unobserved/);
  assert.equal('secret' in result, false);
  assert.equal('coverage' in result.cohorts[0], false);
});

test('rejects bad scope, trust claims, counters, duplicates and non-finite durations', () => {
  const cases = [
    { ...report(), scope: { ...scope, workspace: 'other' } },
    { ...report(), promotionAllowed: true },
    { ...report(), evidence: 'verified' },
    { ...report(), scannedReceipts: 101 },
    { ...report(), invalidReceipts: 3 },
    { ...report(), conflictingInvocations: 3201 },
    { ...report(), limited: true },
    { ...report(), cohorts: [cohort(), cohort()] },
    { ...report(), cohorts: [{ ...cohort(), invocations: 3 }] },
    { ...report(), cohorts: [{ ...cohort(), meanDurationMs: Infinity }] },
    { ...report(), cohorts: [{ ...cohort(), outputBytes: 2 * 1024 ** 3 + 1 }] },
    { ...report(), cohorts: [{ ...cohort(), resource: 'scripts with spaces' }] },
    { ...report(), cohorts: [{ ...cohort(), problem: 'problem id' }] },
    { ...report(), cohorts: [{ ...cohort(), executions: 3 }] },
    { ...report(), conflictingInvocations: 65 },
  ];
  for (const value of cases) assert.throws(() => parse(value));
  assert.throws(() => parseNativeInvocations(report(), { ...scope, project: '' }));
});

test('unavailable result is explicitly non-verified and contains no cohorts', () => {
  const result = noInvocations('offline');
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.cohorts, []);
  assert.equal(result.evidence, 'worker-reported');
  assert.equal(result.independentlyVerified, false);
  assert.equal(result.promotionAllowed, false);
});

test('fetches exact scoped route with bounded request and no forwarded bearer token', async () => {
  let requested!: URL, init!: RequestInit;
  const result = await nativeInvocations('http://127.0.0.1:9000/base', scope, 'scripts:check', async (input, options) => {
    requested = new URL(String(input)); init = options!; return response(report());
  });
  assert.equal(result.status, 'available');
  assert.equal(requested.pathname, '/api/oporahub/harness-invocations');
  assert.equal(requested.searchParams.get('project'), 'p1');
  assert.equal(requested.searchParams.get('workspace'), 'draft');
  assert.equal(requested.searchParams.get('nodeId'), null);
  assert.equal(requested.searchParams.get('resource'), 'scripts:check');
  assert.equal(requested.searchParams.get('limit'), '100');
  assert.equal(init.redirect, 'error');
  assert.equal((init.headers as Record<string, string>).authorization, undefined);
  const wrongFilter = await nativeInvocations('http://127.0.0.1', scope, 'scripts:check', async () => response({
    ...report(), cohorts: [{ ...cohort(), resource: 'scripts:other' }],
  }));
  assert.equal(wrongFilter.status, 'unavailable');
});

test('untrusted, redirected, timed out and oversized endpoints fail closed without response text', async () => {
  const bad = await nativeInvocations('https://user:secret@example.test', scope);
  assert.equal(bad.status, 'unavailable');
  const failed = await nativeInvocations('http://127.0.0.1', scope, undefined, async () => { throw new Error('private body'); });
  assert.equal(failed.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(failed), /private body|secret/);
  const timeout = await nativeInvocations('http://127.0.0.1', scope, undefined, async (_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init?.signal?.aborted, false);
    throw new DOMException('private timeout detail', 'TimeoutError');
  });
  assert.equal(timeout.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(timeout), /private timeout detail/);
  const redirect = await nativeInvocations('http://127.0.0.1', scope, undefined, async (_url, init) => {
    assert.equal(init?.redirect, 'error'); throw new TypeError('redirect blocked');
  });
  assert.equal(redirect.status, 'unavailable');
  const oversize = await nativeInvocations('http://127.0.0.1', scope, undefined, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); controller.close(); },
  })));
  assert.equal(oversize.status, 'unavailable');
});

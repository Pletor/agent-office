import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOriginHistory } from '../src/shared/harness-origin-history.js';

export const originFixture = () => ({ schema: 'harness.origin-history/1', scope: { project: 'p', workspace: 'w', nodeId: null },
  window: { kind: 'newest-enrolled-executions', limit: 100, examined: 2, excluded: 0 }, limited: false, omittedCohortContributions: 0,
  promotionAllowed: false, causalContribution: false, invocationObserved: false,
  cohorts: [{ resource: 'guide:testing', digest: 'a'.repeat(64), versionDigest: 'b'.repeat(64), category: 'testing', problem: 'ts.references',
    tier: 'reported', origin: { scope: 'area', node: 'opora:p:w:area' }, tasks: 1,
    rate: { pass: 1, fail: 0, unknown: 1, executions: 2, interval95: [20.65, 100] } }] });

test('origin history whitelist preserves counts and limits without reflecting extra peer fields', () => {
  const input = originFixture();
  const result = parseOriginHistory({ ...input, privateCapability: 'not-forwarded' }, 'p', 'w');
  assert.deepEqual(result.cohorts, input.cohorts);
  assert.match(result.originEvidence, /not verified ancestry/);
  assert.match(result.association, /do not sum/);
  assert.ok(!JSON.stringify(result).includes('not-forwarded'));
  assert.throws(() => parseOriginHistory(input, 'foreign', 'w'));
  for (const mutate of [
    (v: any) => { v.promotionAllowed = true; }, (v: any) => { v.window.examined = 101; },
    (v: any) => { v.window.excluded = 3; }, (v: any) => { v.omittedCohortContributions = 2; },
    (v: any) => { v.cohorts.push(v.cohorts[0]); }, (v: any) => { v.cohorts[0].rate.executions = 1; },
    (v: any) => { v.cohorts[0].rate.pass = -1; }, (v: any) => { v.cohorts[0].tasks = 3; },
    (v: any) => { v.cohorts[0].origin.scope = 'global'; },
    (v: any) => { v.cohorts[0].rate.interval95 = [99, 2]; },
    (v: any) => { v.cohorts[0].category = 'invented'; },
  ]) {
    const bad = structuredClone(input); mutate(bad); assert.throws(() => parseOriginHistory(bad, 'p', 'w'));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSharedEvidence, sharedReader } from '../src/server/harness/native-shared.js';

const d = 'a'.repeat(64), e = 'b'.repeat(64), image1 = `node@sha256:${'c'.repeat(64)}`, image2 = `node@sha256:${'d'.repeat(64)}`;
const scope = { publication: 'pub-1', candidate: { id: 'kit-1', digest: d }, problem: 'problem-1' };
function payload(overrides: Record<string, unknown> = {}) {
  const sources = [
    { project: 'p1', workspace: 'w', verificationId: 'v1', reportDigest: d, evidenceDigest: e, image: image1 },
    { project: 'p2', workspace: 'w', verificationId: 'v2', reportDigest: d, evidenceDigest: e, image: image1 },
    { project: 'p3', workspace: 'w', verificationId: 'v3', reportDigest: d, evidenceDigest: e, image: image2 },
  ];
  return { schema: 'harness.shared-eligibility/1', authority: 'native-policy-assessment', publication: scope.publication,
    candidate: scope.candidate, problem: scope.problem, eligible: true, reasons: [], sources, verifiedProjects: 3, verifiedImages: 2,
    minimumProjects: 3, minimumImages: 2, environmentBasis: 'pinned-node-image-content', executionAuthority: false,
    promotionAllowed: false, reservation: false, evidenceBasis: { taskOutcomes: 'selected-kit-association', causalBenefitEstablished: false, directObservation: 'approved-fixture-cases-only' },
    evidenceDigest: d, policyDigest: e, ...overrides };
}

test('parses only normalized eligible shared evidence', () => {
  const result = parseSharedEvidence(payload(), scope.publication, scope.candidate, scope.problem);
  assert.equal(result.status, 'eligible'); assert.equal(result.projects, 3); assert.equal(result.images, 2);
  assert.equal('meaning' in result, false); assert.equal('candidate' in result, false);
});

test('rejects malformed, wrong-scope, unsupported authority and inconsistent counts', () => {
  for (const raw of [null, payload({ authority: 'other' }), payload({ candidate: { id: 'wrong', digest: d } }), payload({ verifiedProjects: 2 }), payload({ executionAuthority: true })])
    assert.throws(() => parseSharedEvidence(raw, scope.publication, scope.candidate, scope.problem));
});

test('allows ineligible evidence only with a reason', () => {
  const raw = payload({ eligible: false, reasons: ['fewer-than-three-projects'], verifiedProjects: 3 });
  assert.equal(parseSharedEvidence(raw, scope.publication, scope.candidate, scope.problem).status, 'ineligible');
  assert.throws(() => parseSharedEvidence(payload({ eligible: false }), scope.publication, scope.candidate, scope.problem));
});

test('posts only the publication to the configured origin, rejects redirects, and caches transport response', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const reader = sharedReader('https://example.test/path?secret=x', async (input, init) => {
    calls.push({ url: String(input), init: init! });
    return new Response(JSON.stringify(payload()), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const a = await reader(scope.publication, scope.candidate, scope.problem);
  const b = await reader(scope.publication, scope.candidate, 'wrong-problem');
  assert.equal(a.status, 'eligible'); assert.equal(b.status, 'unavailable'); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/api/oporahub/harness-verifier/eligibility/shared');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { publication: scope.publication });
  assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].init.credentials, 'omit');
  assert.equal((calls[0].init.headers as Record<string, string>)['X-Opora-Actor'], 'agent; name=office-harness');
  assert.equal(JSON.stringify(calls[0].init).includes('secret'), false);
});

test('hides remote errors and bounds distinct publications', async () => {
  let calls = 0;
  const reader = sharedReader('http://peer.test', async () => { calls++; throw new Error('remote secret'); });
  assert.deepEqual(await reader('pub', scope.candidate, scope.problem), { status: 'unavailable', publication: 'pub', reason: 'shared-evidence-unavailable' });
  for (let i = 0; i < 8; i++) await reader(`p${i}`, scope.candidate, scope.problem);
  assert.equal((await reader('ninth', scope.candidate, scope.problem)).status, 'unavailable');
  assert.equal(calls, 8);
});

test('does not accept duplicate sources, same-image evidence or malformed identities as diversity', () => {
  const original = payload();
  for (const sources of [
    [original.sources[0], original.sources[0], original.sources[2]],
    original.sources.map(s => ({ ...s, image: image1 })),
    original.sources.map(s => ({ ...s, project: 'same' })),
    original.sources.map(s => ({ ...s, verificationId: s.verificationId + '\n' })),
    original.sources.map(s => ({ ...s, reportDigest: d + '\n' })),
  ]) assert.throws(() => parseSharedEvidence(payload({ sources }), scope.publication, scope.candidate, scope.problem));
});

test('rejects oversized and invalid UTF-8 responses and credentialed peer URLs', async () => {
  for (const body of ['x'.repeat(256 * 1024 + 1), new Uint8Array([0xff])]) {
    const reader = sharedReader('http://peer.test', async () => new Response(body));
    assert.equal((await reader(scope.publication, scope.candidate, scope.problem)).status, 'unavailable');
  }
  let calls = 0;
  const reader = sharedReader('http://user:password@peer.test', async () => { calls++; return new Response('{}'); });
  assert.equal((await reader(scope.publication, scope.candidate, scope.problem)).status, 'unavailable');
  assert.equal(calls, 0);
});

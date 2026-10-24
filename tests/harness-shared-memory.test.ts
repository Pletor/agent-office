import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecutionClient, type ExecutionLease } from '../src/server/opora/execution-client.js';
import { ExecutionController } from '../src/server/opora/execution-controller.js';
import { executionPrompt } from '../src/server/opora/execution-prompt.js';
import { officeHarness } from '../src/server/harness/api.js';
import type { Ctx } from '../src/server/office/context.js';
import { budgetLease } from './support/opora-budget.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const entry = (resource: string, content: string) => ({ slot: resource.replace(':', '.'), resource, content,
  category: 'scripts', digest: hash(content), requires: ['command:node'] });
const listen = async (server: http.Server) => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + (server.address() as { port: number }).port; };

test('shared memory CLI uses native public evidence bound to the exact accepted Node resource', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-shared-memory-')), data = path.join(root, '.agent-office');
  const a = entry('script:a', 'accepted A'), b = entry('script:b', 'accepted B');
  const kit = { schema: 'harness.kit/1', problems: ['numeric.identity'], resources: [a, b] };
  const lease: ExecutionLease = { ...budgetLease(), contextProtocolVersion: 2,
    assignment: { contextProtocolVersion: 2, contextVersion: 'f'.repeat(64), documents: [{ nodeId: 'card', fields: { harness: kit } }] },
    contextValidation: { contextProtocolVersion: 2, originAcceptedRevision: 'a'.repeat(40), checkedAcceptedRevision: 'a'.repeat(40),
      acceptedRevisionsChecked: 1, liveTransitionsChecked: 0, acceptedScopeUnchanged: true, liveScopeUnchanged: true } };
  const seen: Array<{ url: string; body: any; headers: http.IncomingHttpHeaders }> = [];
  let eligibility: any, memory: any, publicationAck: any, beforeReply = () => {};
  const native = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); seen.push({ url: req.url!, body, headers: req.headers });
    assert.deepEqual(Object.keys(body), ['publication']);
    assert.equal(JSON.stringify(body).includes('PRIVATE-token'), false);
    assert.equal(body.publication, 'pub:lesson');
    if (req.url === '/api/oporahub/harness-verifier/eligibility/shared') { beforeReply(); res.end(JSON.stringify(eligibility)); }
    else if (req.url === '/api/oporahub/harness-shared-memory/publish' || req.url === '/api/oporahub/harness-shared-memory/recall') {
      res.end(JSON.stringify(req.url.endsWith('/publish') ? publicationAck : memory));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  const nativeBase = await listen(native);
  const controller = new ExecutionController(new ExecutionClient(nativeBase, 'test'), () => {}, () => {}, () => 0);
  controller.watch('worker', lease, 60_000); executionPrompt(data, nativeBase, 'test', lease);
  const floor = { dir: root, opora: { executions: { controller } }, workers: {
    authenticate: (id: string, token: string) => id === 'worker' && token === 'hook-key' ? { id } : undefined } };
  const ctx = { cfg: { dataDir: data }, workerFloor: () => floor } as unknown as Ctx;
  const office = http.createServer((req, res) => void officeHarness(ctx, req, res, new URL(req.url!, 'http://local')));
  const base = await listen(office);
  t.after(() => { controller.shutdown(); for (const server of [office, native]) { server.close(); server.closeAllConnections(); }
    rmSync(root, { recursive: true, force: true }); });

  const candidate = { id: b.resource, digest: b.digest };
  const proof: any = { publication: 'pub:lesson', candidate, problem: 'numeric.identity', policyDigest: '1'.repeat(64),
    evidenceDigest: '2'.repeat(64), environmentBasis: 'pinned-node-image-content',
    evidenceBasis: { taskOutcomes: 'selected-kit-association', causalBenefitEstablished: false, directObservation: 'approved-fixture-cases-only' },
    sources: [
      { project: 'p1', workspace: 'w1', verificationId: 'v1', reportDigest: '3'.repeat(64), evidenceDigest: '4'.repeat(64), image: 'node@sha256:' + '5'.repeat(64) },
      { project: 'p2', workspace: 'w2', verificationId: 'v2', reportDigest: '6'.repeat(64), evidenceDigest: '7'.repeat(64), image: 'node@sha256:' + '5'.repeat(64) },
      { project: 'p3', workspace: 'w3', verificationId: 'v3', reportDigest: '8'.repeat(64), evidenceDigest: '9'.repeat(64), image: 'node@sha256:' + 'a'.repeat(64) },
    ], verifiedProjects: 3, verifiedImages: 2 };
  const eligible = () => ({ schema: 'harness.shared-eligibility/1', authority: 'native-policy-assessment', eligible: true,
    minimumProjects: 3, minimumImages: 2, reasons: [], executionAuthority: false, promotionAllowed: false, reservation: false, ...structuredClone(proof) });
  eligibility = eligible();
  const lesson = { schema: 'harness.shared-memory/1', ...proof, lessonDigest: 'b'.repeat(64), productionOutcome: 'unknown',
    promotionAllowed: false, executionAuthority: false };
  memory = { schema: 'harness.shared-memory/1', publication: 'pub:lesson', status: 'verified-readback', lesson,
    executionAuthority: false, promotionAllowed: false };
  publicationAck = { schema: 'harness.shared-memory/1', publication: 'pub:lesson', state: 'pending',
    lessonDigest: 'c'.repeat(64), promotionAllowed: false };
  const run = async (...args: string[]) => promisify(execFile)(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', "import('./bin/harness-remote.js').then(m=>m.remoteHarness(process.argv.slice(1)))", '--', ...args],
    { env: { ...process.env, AGENT_OFFICE_HOOK_URL: base, AGENT_OFFICE_WORKER_ID: 'worker', AGENT_OFFICE_HOOK_TOKEN: 'hook-key' }, timeout: 20_000 });

  const recalled = await run('--recall-shared', 'pub:lesson', '--resource', 'script:b');
  const output = JSON.parse(recalled.stdout);
  assert.equal(output.status, 'verified-readback'); assert.equal(memory.lesson.productionOutcome, 'unknown');
  assert.equal(output.lesson.lessonDigest, memory.lesson.lessonDigest);
  assert.equal(output.executionAuthority, false); assert.equal(output.promotionAllowed, false);
  assert.doesNotMatch(recalled.stdout + recalled.stderr, /PRIVATE-token|hook-key/);
  const published = await run('--publish-shared', 'pub:lesson', '--resource', 'script:b');
  assert.equal(JSON.parse(published.stdout).state, 'pending');
  assert.equal(seen.filter(v => v.url.endsWith('/publish')).length, 1);
  assert.deepEqual(lease.assignment.documents, [{ nodeId: 'card', fields: { harness: kit } }]);
  assert(seen.every(v => !JSON.stringify(v.body).includes('hook-key') && !JSON.stringify(v.body).includes('PRIVATE-token')));
  assert(seen.every(v => v.headers.authorization === undefined && !JSON.stringify(v.headers).includes('PRIVATE-token')));

  for (const poison of [
    (v: any) => { v.candidate.digest = '0'.repeat(64); },
    (v: any) => { v.candidate.id = 'script:a'; },
    (v: any) => { v.problem = 'foreign.problem'; },
    (v: any) => { v.verifiedProjects = 2; },
    (v: any) => { v.sources[2].image = v.sources[0].image; v.verifiedImages = 1; },
    (v: any) => { v.executionAuthority = true; },
    (v: any) => { v.eligible = false; v.reasons = ['source-withdrawn']; },
  ]) {
    eligibility = eligible(); poison(eligibility);
    const count = seen.filter(v => v.url.endsWith('/publish')).length;
    await assert.rejects(run('--publish-shared', 'pub:lesson', '--resource', 'script:b'));
    assert.equal(seen.filter(v => v.url.endsWith('/publish')).length, count);
  }
  eligibility = eligible();
  assert.equal(JSON.parse((await run('--recall-shared', 'pub:lesson', '--resource', 'script:b')).stdout).status, 'verified-readback', 'poison cases must not mutate later valid evidence');
  memory.lesson = { ...lesson, productionOutcome: 'success' };
  await assert.rejects(run('--recall-shared', 'pub:lesson', '--resource', 'script:b'));
  memory.lesson = lesson;
  await assert.rejects(run('--publish-shared', 'pub:lesson', '--resource', 'script:a'));
  await assert.rejects(run('--publish-shared', 'pub:lesson', '--resource', 'script:b', '--task', 'task:neighbor'));
  assert.equal((await fetch(base + '/office/harness?worker=worker&shared-memory=pub%3Alesson&resource=script%3Ab', {
    method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{"operation":"publish"}' })).status, 401);
  const before = seen.filter(v => v.url.endsWith('/publish')).length;
  beforeReply = () => controller.forget('worker');
  await assert.rejects(run('--publish-shared', 'pub:lesson', '--resource', 'script:b'));
  assert.equal(seen.filter(v => v.url.endsWith('/publish')).length, before);
  assert.deepEqual(lease.assignment.documents, [{ nodeId: 'card', fields: { harness: kit } }]);
});

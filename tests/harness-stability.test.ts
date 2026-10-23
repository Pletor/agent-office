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
import { HarnessProfiles } from '../src/server/harness/profiles.js';
import type { Ctx } from '../src/server/office/context.js';
import { budgetLease } from './support/opora-budget.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const digest = (v: Record<string, unknown>) => hash(JSON.stringify(Object.fromEntries(Object.entries(v).sort())));
const entry = (resource: string, content: string, category = 'scripts') => ({ slot: resource.replace(':', '.'), resource,
  content, category, digest: hash(content), requires: category === 'scripts' ? ['command:node'] : [] });
const listen = async (server: http.Server) => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + (server.address() as { port: number }).port; };

test('worker lifecycle uses native current evidence and optional store, never caller observations', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-stability-')), data = path.join(root, '.agent-office');
  let responseValue: any, beforeReply = () => {}, requests = 0, writes = 0;
  const native = http.createServer(async (req, res) => {
    requests++; assert.equal(req.url, '/api/oporahub/harness-verifier/eligibility');
    assert.equal(req.method, 'POST');
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); assert.equal(body.token, 'PRIVATE-token');
    assert.deepEqual(Object.keys(body).sort(), ['epoch', 'executionId', 'plan', 'project', 'token', 'workspace']);
    beforeReply(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(responseValue));
  });
  const nativeBase = await listen(native), a = entry('script:a', 'a'), b = entry('script:b', 'b');
  const plan = entry('testing:plan', JSON.stringify({ schema: 'harness.paired-node/1', problem: 'testing:node',
    baseline: a.resource, candidate: b.resource, cases: [{ id: 'case:one', args: [], expectedStdout: 'ok' }] }), 'testing');
  const kit = { schema: 'harness.kit/1', problems: ['evaluation:paired-node'], resources: [a, b, plan] };
  const lease: ExecutionLease = { ...budgetLease(), contextProtocolVersion: 2,
    assignment: { contextProtocolVersion: 2, contextVersion: 'f'.repeat(64), documents: [{ nodeId: 'card', fields: { harness: kit } }] },
    contextValidation: { contextProtocolVersion: 2, originAcceptedRevision: 'a'.repeat(40), checkedAcceptedRevision: 'a'.repeat(40),
      acceptedRevisionsChecked: 1, liveTransitionsChecked: 0, acceptedScopeUnchanged: true, liveScopeUnchanged: true } };
  const controller = new ExecutionController(new ExecutionClient(nativeBase, 'test'), () => {}, () => {}, () => 0);
  controller.watch('worker', lease, 60_000); executionPrompt(data, nativeBase, 'test', lease);
  const floor = { dir: root, opora: { executions: { controller } }, workers: {
    authenticate: (id: string, token: string) => id === 'worker' && token === 'hook-key' ? { id } : undefined } };
  const ctx = { cfg: { dataDir: data }, workerFloor: () => floor } as unknown as Ctx;
  const office = http.createServer((req, res) => void officeHarness(ctx, req, res, new URL(req.url!, 'http://local')));
  const base = await listen(office), proto = HarnessProfiles.prototype as any;
  const names = ['toolLifecycleProtocol', 'lifecycle', 'advanceTool'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(proto, name));
  t.after(() => {
    names.forEach((name, i) => { if (originals[i]) Object.defineProperty(proto, name, originals[i]!); else delete proto[name]; });
    controller.shutdown(); for (const server of [office, native]) { server.close(); server.closeAllConnections(); }
    rmSync(root, { recursive: true, force: true });
  });
  const call = (body?: unknown, token = 'hook-key', extra = '') => fetch(base + '/office/harness?worker=worker&stability=testing:plan' + extra,
    { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await call(undefined, 'wrong')).status, 401); assert.equal(requests, 0);
  assert.equal((await call(undefined, 'hook-key', '&task=neighbor')).status, 400);
  // Independent PR lacks the optional store. A composed run installs the real one separately.
  if (!('advanceTool' in proto)) { assert.equal((await call()).status, 409); assert.equal(requests, 0); }
  proto.toolLifecycleProtocol = 1;
  proto.lifecycle = () => ({ revision: writes });
  proto.advanceTool = async (_repo: unknown, _scope: unknown, revision: number, _operation: string, read: () => Promise<any>) => {
    assert.equal(revision, writes);
    const checks = await read(); checks.assertCurrent();
    assert.equal(checks.current.eligible, true); writes++;
    return { revision: writes, state: { active: checks.current.version } };
  };
  const policy = { project: lease.project, workspace: lease.workspace, approvedPlanDigests: [plan.digest],
    minimumVerifiedOutcomes: 20, minimumVerifiedCards: 5, minimumCoveragePercent: 95 };
  const valid = { schema: 'harness.stability-eligibility/1', authority: 'native-policy-assessment',
    scope: { project: lease.project, workspace: lease.workspace, problem: 'testing:node' },
    execution: { executionId: lease.executionId, nodeId: lease.nodeId, epoch: lease.epoch, acceptedRevision: lease.acceptedRevision, assignmentDigest: lease.assignmentDigest },
    candidate: { id: b.resource, digest: b.digest }, baseline: { id: a.resource, digest: a.digest }, plan: { id: plan.resource, digest: plan.digest },
    policy, policyDigest: digest(policy), evidenceDigest: 'e'.repeat(64), eligible: true, reasons: [], promotionAllowed: false, reservation: false,
    cohort: { executions: 20, verifiedPasses: 20, unknown: 0, verifiedCards: 5, coverage: 1,
      versionDigest: digest({ resource: b.resource, category: b.category, digest: b.digest, requires: b.requires }), sourceDigest: 'f'.repeat(64) },
    guardrails: { affectedExecutions: 0 }, comparison: { complete: true, reason: null, reports: [{ verificationId: 'check', reportDigest: 'c'.repeat(64) }] },
    evidenceBasis: { taskOutcomes: 'selected-kit-association', taskInvocationVerified: false, causalBenefitEstablished: false, directObservation: 'approved-fixture-cases-only' } };
  responseValue = valid;
  const status = await call(); assert.equal(status.status, 200);
  assert.equal((await status.json()).assessment.eligible, true);
  assert.equal((await call({ operation: 'promote', revision: 0, eligible: true })).status, 400);
  const cli = await promisify(execFile)(process.execPath, ['bin/office-harness.js', '--promote-tool', 'testing:plan', '--revision', '0'], {
    env: { ...process.env, AGENT_OFFICE_HOOK_URL: base, AGENT_OFFICE_WORKER_ID: 'worker', AGENT_OFFICE_HOOK_TOKEN: 'hook-key' }, timeout: 20_000 });
  assert.equal(JSON.parse(cli.stdout).revision, 1); assert.equal(writes, 1);
  assert.doesNotMatch(cli.stdout + cli.stderr, /PRIVATE-token|hook-key/);
  for (const poison of [
    (v: any) => { v.scope.project = 'foreign'; }, (v: any) => { v.execution.epoch++; },
    (v: any) => { v.candidate.digest = '0'.repeat(64); }, (v: any) => { v.cohort.verifiedPasses = 19; },
    (v: any) => { v.guardrails.affectedExecutions = 1; }, (v: any) => { v.policyDigest = '0'.repeat(64); },
    (v: any) => { v.evidenceBasis.causalBenefitEstablished = true; }, (v: any) => { v.promotionAllowed = true; },
    (v: any) => { v.debug = 'PRIVATE-token'; },
  ]) {
    responseValue = structuredClone(valid); poison(responseValue);
    assert.equal((await call({ operation: 'promote', revision: 1 })).status, 409); assert.equal(writes, 1);
  }
  responseValue = valid; beforeReply = () => controller.forget('worker');
  assert.equal((await call({ operation: 'promote', revision: 1 })).status, 409); assert.equal(writes, 1);
  assert.deepEqual(lease.assignment.documents, [{ nodeId: 'card', fields: { harness: kit } }]);
});

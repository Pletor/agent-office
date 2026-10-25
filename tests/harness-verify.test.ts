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
const entry = (resource: string, content: string, category = 'scripts') => ({ slot: resource.replace(':', '.'), resource,
  content, category, digest: hash(content), requires: category === 'scripts' ? ['command:node'] : [] });
const listen = async (server: http.Server) => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + (server.address() as { port: number }).port; };

test('a worker asks Canvas to rerun its accepted paired plan; it sees the outcome, never the execution token', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-verify-')), data = path.join(root, '.agent-office');
  let responseValue: any, requests = 0;
  const native = http.createServer(async (req, res) => {
    requests++; assert.equal(req.url, '/api/oporahub/harness-verifier/requests'); assert.equal(req.method, 'POST');
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); assert.equal(body.token, 'PRIVATE-token');
    assert.deepEqual(Object.keys(body).sort(), ['epoch', 'executionId', 'plan', 'project', 'token', 'workspace']);
    assert.deepEqual(body.plan, { id: plan.resource, digest: plan.digest });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(responseValue));
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
  const base = await listen(office);
  t.after(() => {
    controller.shutdown(); for (const server of [office, native]) { server.close(); server.closeAllConnections(); }
    rmSync(root, { recursive: true, force: true });
  });
  const call = (target = 'testing:plan', method = 'POST', token = 'hook-key', extra = '') =>
    fetch(base + '/office/harness?worker=worker&verify=' + target + extra,
      { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
  assert.equal((await call('testing:plan', 'POST', 'wrong')).status, 401);
  assert.equal((await call('testing:plan', 'GET')).status, 405);
  assert.equal((await call('testing:plan', 'POST', 'hook-key', '&task=neighbor')).status, 400);
  assert.equal((await call('script:a')).status, 409, 'only an accepted paired plan can be verified');
  assert.equal(requests, 0);

  const report = { outcome: 'passed', reportDigest: 'd'.repeat(64), independentlyVerified: true, promotionAllowed: false,
    paired: { observedTrials: 2, improvements: 1, regressions: 0 }, trust: 'server-observed' };
  const record = { id: 'e'.repeat(32), executionId: lease.executionId, epoch: lease.epoch, plannedTrials: 2,
    origin: { kind: 'harness-server-verifier', plan: { id: plan.resource, digest: plan.digest } }, report };
  responseValue = record;
  const cli = await promisify(execFile)(process.execPath, ['bin/office-harness.js', '--verify-pair', 'testing:plan'], {
    env: { ...process.env, AGENT_OFFICE_HOOK_URL: base, AGENT_OFFICE_WORKER_ID: 'worker', AGENT_OFFICE_HOOK_TOKEN: 'hook-key' }, timeout: 20_000 });
  const view = JSON.parse(cli.stdout);
  assert.equal(view.status, 'reported'); assert.equal(view.outcome, 'passed'); assert.equal(view.independentlyVerified, true);
  assert.deepEqual(view.paired, { observedTrials: 2, improvements: 1, regressions: 0 });
  assert.equal(view.promotionAllowed, false);
  assert.equal(view.executionId, undefined, 'the execution binding stays private');
  assert.doesNotMatch(cli.stdout + cli.stderr, /PRIVATE-token|hook-key/);

  responseValue = { ...record, report: { ...report, outcome: 'inconclusive', independentlyVerified: false } };
  assert.equal((await (await call()).json()).independentlyVerified, false);
  responseValue = { ...record, report: null };
  assert.equal((await (await call()).json()).status, 'pending');
  responseValue = { ...record, report: null, recoveryRequired: true };
  assert.equal((await (await call()).json()).status, 'recovery-required');
  for (const poison of [
    (v: any) => { v.origin.plan.digest = '0'.repeat(64); }, (v: any) => { v.origin.kind = 'other'; },
    (v: any) => { v.report.promotionAllowed = true; }, (v: any) => { v.report.outcome = 'great'; },
    (v: any) => { v.debug = 'PRIVATE-token'; },
  ]) {
    responseValue = structuredClone(record); poison(responseValue);
    assert.equal((await call()).status, 409);
  }
  responseValue = record; controller.forget('worker');
  assert.equal((await call()).status, 409, 'an ended execution cannot request verification');
  assert.deepEqual(lease.assignment.documents, [{ nodeId: 'card', fields: { harness: kit } }]);
});

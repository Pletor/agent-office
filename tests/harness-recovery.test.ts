import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecutionClient, type ExecutionLease } from '../src/server/opora/execution-client.js';
import { ExecutionController } from '../src/server/opora/execution-controller.js';
import { executionPrompt } from '../src/server/opora/execution-prompt.js';
import { officeHarness } from '../src/server/harness/api.js';
import type { Ctx } from '../src/server/office/context.js';
import { budgetLease } from './support/opora-budget.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const tool = (content: string, resource = 'script:tool') => ({ slot: resource === 'script:tool' ? 'scripts.tool' : 'rules.other',
  resource, category: 'scripts', content, digest: hash(content), requires: ['command:node'] });
const listen = async (server: http.Server) => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + (server.address() as { port: number }).port; };

test('recovery CLI uses private current grant and validates exact proposal without authority expansion', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-recovery-')), data = path.join(root, '.agent-office');
  let requests = 0, mode = 'normal', beforeReply = () => {};
  let responseValue: any;
  const native = http.createServer(async (req, res) => {
    requests++;
    assert.equal(req.url, '/api/oporahub/harness-recovery');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['x-opora-actor'], 'agent; name=test');
    let text = ''; for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    assert.equal(request.token, 'PRIVATE-token'); assert.equal(request.resource, 'script:tool');
    assert.equal(request.sourceExecutionId, 'earlier-run'); assert.equal(request.executionId, 'execution-1');
    beforeReply();
    if (mode === 'missing') { res.writeHead(404); res.end('private diagnostic'); return; }
    res.setHeader('content-type', 'application/json');
    const body = JSON.stringify(responseValue);
    res.end(mode === 'large' ? 'x'.repeat(128 * 1024 + 1) : mode === 'escaped' ? body.replaceAll('PRIVATE-token', '\\u0050RIVATE-token') : body);
  });
  const nativeBase = await listen(native);
  const currentKit = { schema: 'harness.kit/1', problems: ['tool.run'], resources: [tool('new candidate'), tool('keep me', 'script:other')] };
  const lease: ExecutionLease = { ...budgetLease(), contextProtocolVersion: 2,
    assignment: { contextProtocolVersion: 2, contextVersion: 'f'.repeat(64), documents: [{ nodeId: 'card', fields: { harness: currentKit } }] },
    contextValidation: { contextProtocolVersion: 2, originAcceptedRevision: 'a'.repeat(40), checkedAcceptedRevision: 'a'.repeat(40),
      acceptedRevisionsChecked: 1, liveTransitionsChecked: 0, acceptedScopeUnchanged: true, liveScopeUnchanged: true } };
  const controller = new ExecutionController(new ExecutionClient(nativeBase, 'test'), () => {}, () => {}, () => 0);
  controller.watch('worker', lease, 60_000);
  executionPrompt(data, nativeBase, 'test', lease);
  const floor = { dir: root, opora: { executions: { controller } }, workers: {
    authenticate: (id: string, token: string) => id === 'worker' && token === 'hook-key' ? { id } : undefined } };
  const ctx = { workerFloor: () => floor } as unknown as Ctx;
  const office = http.createServer((req, res) => void officeHarness(ctx, req, res, new URL(req.url!, 'http://local')));
  const base = await listen(office);
  t.after(() => { controller.shutdown(); for (const server of [office, native]) { server.close(); server.closeAllConnections(); }
    rmSync(root, { recursive: true, force: true }); });
  const old = tool('previous accepted content');
  const proposal = { schema: 'harness.recovery-proposal/1', scope: { project: lease.project, workspace: lease.workspace, nodeId: lease.nodeId },
    executionId: lease.executionId, epoch: lease.epoch, assignmentDigest: lease.assignmentDigest, acceptedRevision: lease.acceptedRevision,
    source: { executionId: 'earlier-run', resource: old.resource, digest: old.digest, assignmentDigest: 'e'.repeat(64), acceptedRevision: 'c'.repeat(40),
      versionDigest: hash(JSON.stringify({ category: old.category, digest: old.digest, requires: old.requires, resource: old.resource })) },
    evidence: { verifiedOutcome: 'unknown', sourceEvent: 1, fixtureHistory: 'unavailable' },
    kit: { ...currentKit, resources: [old, currentKit.resources[1]] }, requiresAcceptance: true, promotionAllowed: false };
  responseValue = structuredClone(proposal);
  const call = (token = 'hook-key', extra = '') => fetch(base + '/office/harness?worker=worker&recover=script:tool&from=earlier-run' + extra,
    { headers: { authorization: 'Bearer ' + token } });
  assert.equal((await call('wrong')).status, 401); assert.equal(requests, 0);
  assert.equal((await call('hook-key', '&task=other')).status, 400); assert.equal(requests, 0);
  const response = await call(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json(); assert.deepEqual(result.kit, proposal.kit);
  assert.equal(result.requiresAcceptance, true); assert.equal(result.promotionAllowed, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-token|hook-key/);
  assert.deepEqual(controller.assignmentFor('worker')!.assignment, lease.assignment);
  const cli = await promisify(execFile)(process.execPath, ['bin/office-harness.js', '--recover', 'script:tool', '--from', 'earlier-run'], {
    env: { ...process.env, AGENT_OFFICE_HOOK_URL: base, AGENT_OFFICE_WORKER_ID: 'worker', AGENT_OFFICE_HOOK_TOKEN: 'hook-key' }, timeout: 20_000 });
  assert.deepEqual(JSON.parse(cli.stdout).kit, proposal.kit); assert.doesNotMatch(cli.stdout + cli.stderr, /PRIVATE-token|hook-key/);
  for (const poison of [
    (v: any) => { v.scope.workspace = 'foreign'; }, (v: any) => { v.epoch++; },
    (v: any) => { v.source.executionId = 'other-run'; }, (v: any) => { v.source.versionDigest = '0'.repeat(64); },
    (v: any) => { v.promotionAllowed = true; }, (v: any) => { v.requiresAcceptance = false; },
    (v: any) => { v.kit.resources[1] = tool('replace unrelated', 'script:other'); },
    (v: any) => { v.kit.resources[0].requires = ['network:all']; },
    (v: any) => { v.debug = 'PRIVATE-token'; },
  ]) {
    responseValue = structuredClone(proposal); poison(responseValue);
    const rejected = await call(); assert.equal(rejected.status, 409); assert.doesNotMatch(await rejected.text(), /PRIVATE-token|foreign|network:all/);
  }
  mode = 'escaped'; responseValue = { ...proposal, debug: 'PRIVATE-token' };
  assert.equal((await call()).status, 409, 'JSON escaped capabilities cannot evade reflection protection');
  mode = 'normal'; responseValue = proposal;
  beforeReply = () => controller.forget('worker');
  assert.equal((await call()).status, 409); beforeReply = () => {}; controller.watch('worker', lease, 60_000);
  mode = 'large'; assert.equal((await call()).status, 409);
  mode = 'missing'; assert.equal((await call()).status, 409); mode = 'normal';
  const bundleFile = path.join(data, 'opora-executions', lease.executionId + '.json');
  const bundle = JSON.parse(readFileSync(bundleFile, 'utf8')); bundle.base = 'https://untrusted.example';
  writeFileSync(bundleFile, JSON.stringify(bundle)); const before = requests;
  assert.equal((await call()).status, 409); assert.equal(requests, before, 'tampered private destination is never contacted');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { harnessWorkerBrief } from '../src/server/harness/worker-brief.js';
import { ExecutionDispatch } from '../src/server/opora/execution-dispatch.js';
import type { ExecutionLease } from '../src/server/opora/execution-client.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import type { Ctx } from '../src/server/office/context.js';
import { officeHarness } from '../src/server/harness/api.js';
import { budgetLease, budgetScope } from './support/opora-budget.js';

const selected = () => {
  const content = 'RESOURCE_CONTENT_NOT_INLINE';
  return { schema: 'harness.kit/1', problems: ['task.quality'], resources: [{ slot: 'rules.quality', resource: 'rule:quality',
    category: 'rules', content, digest: createHash('sha256').update(content).digest('hex'), requires: [] }] };
};
function lease(): ExecutionLease {
  return { ...budgetLease(), contextProtocolVersion: 2, contextValidation: { contextProtocolVersion: 2,
    originAcceptedRevision: 'a'.repeat(40), checkedAcceptedRevision: 'a'.repeat(40), acceptedRevisionsChecked: 1,
    liveTransitionsChecked: 0, acceptedScopeUnchanged: true, liveScopeUnchanged: true },
    assignment: { contextProtocolVersion: 2, contextVersion: 'c'.repeat(64), documents: [
      { nodeId: 'card', fields: { harness: selected() } }, { nodeId: 'neighbor', fields: { harness: selected() } }] } };
}

test('worker guide depends only on accepted target presence, never mutable or neighbor content', () => {
  const original = lease(), before = JSON.stringify(original), guide = harnessWorkerBrief(original);
  assert.match(guide, /harness.worker\/1/);
  assert.match(guide, /office-harness --accepted-kit/);
  assert.match(guide, /requirements/);
  assert.doesNotMatch(guide, /PRIVATE-token|RESOURCE_CONTENT_NOT_INLINE/);
  assert.equal(JSON.stringify(original), before);
  assert.equal(harnessWorkerBrief({ ...original, contextProtocolVersion: 1 }), '');
  assert.equal(harnessWorkerBrief({ ...original, nodeId: 'missing' }), '');
  const docs = original.assignment.documents as any[];
  delete docs[0].fields.harness;
  assert.equal(harnessWorkerBrief(original), '', 'neighbor kit cannot supply guidance');
  docs[0].fields.harness = { ...selected(), resources: [] };
  assert.match(harnessWorkerBrief(original), /empty accepted kit stays empty/);
  docs[0].fields.harness = { ...selected(), resources: [{ ...selected().resources[0], digest: 'bad' }] };
  assert.throws(() => harnessWorkerBrief(original), /Accepted Harness kit is invalid/);
});

test('actual v2 dispatch seats usage guide and its command reads exactly that accepted kit', async t => {
  const oldVersion = process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION;
  process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION = '2';
  t.after(() => { if (oldVersion === undefined) delete process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION; else process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION = oldVersion; });
  const root = mkdtempSync(path.join(tmpdir(), 'harness-worker-guide-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dispatch = new ExecutionDispatch('http://localhost', 'office', root, () => [], () => {}, () => {});
  t.after(() => dispatch.controller.shutdown());
  const grant = lease(), assignment = JSON.stringify(grant.assignment);
  dispatch.controller.claim = async () => ({ lease: grant, deadline: performance.now() + 50000 });
  let prompt = '';
  await dispatch.dispatch(budgetScope, async () => { throw new Error('must not read live profiles'); }, text => {
    prompt = text; return { id: 'worker', via: 'opora', status: 'working' } as WorkerInfo;
  }, () => { throw new Error('must not append live decoration'); });
  assert.match(prompt, /office-harness --accepted-kit/);
  assert.match(prompt, /office-harness --prepare-accepted before using accepted tools/);
  assert.match(prompt, /office-harness --docs-accepted RESOURCE "public question"/);
  assert.match(prompt, /worker-process preparation report does not attest this remote service/);
  assert.match(prompt, /include only observation in result.harnessDocumentation/);
  assert.match(prompt, /Do not put documentation in harnessInvocations/);
  assert.match(prompt, /office-harness --recommend PROBLEM --kit-schema harness.kit\/2/);
  assert.match(prompt, /--capability ID only for capabilities actually checked in this runner/);
  assert.match(prompt, /kit: null means blocked/);
  assert.match(prompt, /normal specification acceptance and a new assignment before using newly selected resources/);
  assert.match(prompt, /office-harness --recall-shared PUBLICATION --resource RESOURCE/);
  assert.match(prompt, /--publish-shared PUBLICATION --resource RESOURCE queues only the server's public fixture lesson/);
  assert.match(prompt, /prepared context is readable material, not an activated tool/);
  assert.match(prompt, /If the command is absent, report preparation unavailable/);
  assert.match(prompt, /immutable Canvas assignment/);
  assert.doesNotMatch(prompt, /PRIVATE-token|RESOURCE_CONTENT_NOT_INLINE/);
  assert.equal(JSON.stringify(JSON.parse(readFileSync(path.join(root, 'opora-executions', grant.executionId + '-assignment.json'), 'utf8'))), assignment);
  const floor = { opora: { executions: { controller: dispatch.controller } }, workers: {
    authenticate: (id: string, token: string) => id === 'worker' && token === 'hook-key' ? { id } : undefined } };
  const ctx = { workerFloor: () => floor } as unknown as Ctx;
  const server = http.createServer((req, res) => void officeHarness(ctx, req, res, new URL(req.url!, 'http://local')));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const result = await promisify(execFile)(process.execPath, ['bin/office-harness.js', '--accepted-kit'], {
    env: { ...process.env, AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
      AGENT_OFFICE_WORKER_ID: 'worker', AGENT_OFFICE_HOOK_TOKEN: 'hook-key' } });
  assert.deepEqual(JSON.parse(result.stdout).kit, selected());
  assert.doesNotMatch(result.stdout, /PRIVATE-token/);
});

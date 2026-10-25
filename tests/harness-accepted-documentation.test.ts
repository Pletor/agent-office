import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acceptedDocumentation } from '../src/server/harness/accepted-documentation.js';
import { officeHarness } from '../src/server/harness/api.js';
import type { Ctx } from '../src/server/office/context.js';

const installed = existsSync(new URL('../src/server/harness/accepted-kit.ts', import.meta.url));
const content = JSON.stringify({ schema: 'harness.context7/1', library: '/nodejs/node/v22.0.0' });
const resource = () => ({ slot: 'mcp.docs', resource: 'mcp:docs', category: 'mcp', content,
  digest: createHash('sha256').update(content).digest('hex'), requires: ['mcp:context7'] });
const input = { action: 'accepted-query', resource: 'mcp:docs', query: 'How do streams work?' };
const snapshot = () => ({ executionId: 'e', epoch: 1, project: 'p', workspace: 'w', nodeId: 'n',
  acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64), contextProtocolVersion: 2,
  assignment: { documents: [{ nodeId: 'n', fields: { harness: { schema: 'harness.kit/1', problems: ['docs.read'], resources: [resource()] } } }] } });

test('accepted documentation refuses missing runtime and local CLI cannot invent an assignment', async () => {
  if (!installed) await assert.rejects(acceptedDocumentation(input, { assignmentFor: snapshot }, 'worker', {
    read: async () => { throw new Error('NETWORK_MUST_NOT_RUN'); } }), /unavailable/);
  const env = { ...process.env }; delete env.AGENT_OFFICE_HOOK_URL;
  await assert.rejects(promisify(execFile)(process.execPath, ['bin/office-harness.js', '--docs-accepted', 'mcp:docs', 'Streams?'], { env }), /requires a connected worker/);
});

test('accepted Context7 CLI binds exact target and refuses poisoned or stale assignments', { skip: !installed }, async t => {
  let current: any = snapshot(), calls = 0, revoke = false;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++;
    assert.ok(!JSON.stringify(init.headers).includes('hook-secret'));
    const body = JSON.parse(String(init.body));
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result: any = { protocolVersion: '2025-06-18' };
    if (body.method === 'tools/list') result = { tools: [{ name: 'query-docs' }] };
    if (body.method === 'tools/call') {
      assert.equal(body.params.arguments.libraryId, '/nodejs/node/v22.0.0');
      result = { content: [{ type: 'text', text: 'Public reference' }] };
      if (revoke) current = undefined;
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
  });
  const controller = { assignmentFor: () => current };
  const floor = { id: 'accepted-docs', opora: { executions: { controller } }, workers: {
    authenticate: (_id: string, token: string) => token === 'hook-secret' ? {} : undefined } };
  const server = http.createServer((req, res) => void officeHarness({ workerFloor: () => floor } as unknown as Ctx, req, res, new URL(req.url!, 'http://local')));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const call = (token = 'hook-secret', task = '') => originalFetch(base + '/office/harness?worker=w&docs=1' + task,
    { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(input) });
  assert.equal((await call('bad')).status, 401); assert.equal(calls, 0);
  const env = { ...process.env, AGENT_OFFICE_HOOK_URL: base, AGENT_OFFICE_WORKER_ID: 'w', AGENT_OFFICE_HOOK_TOKEN: 'hook-secret' };
  const raw = await promisify(execFile)(process.execPath, ['bin/office-harness.js', '--docs-accepted', 'mcp:docs', input.query], { env });
  const receipt = JSON.parse(raw.stdout);
  assert.equal(receipt.accepted.resource.digest, resource().digest);
  assert.equal(receipt.authority, 'external-reference'); assert.equal(receipt.promotionAllowed, false);
  assert.equal(receipt.observation.schema, 'harness.documentation-observation/1');
  assert.equal(receipt.observation.resource.digest, resource().digest);
  assert.equal(receipt.observation.documentDigest, receipt.digest);
  assert.equal(receipt.observation.outputBytes, Buffer.byteLength('Public reference'));
  assert.equal(receipt.observation.evidence, 'worker-reported');
  assert.doesNotMatch(JSON.stringify(receipt.observation), /How do streams|Public reference|contextProtocolVersion/);
  assert.doesNotMatch(raw.stdout, /hook-secret|"assignment"|"content"/);
  const before = calls;
  assert.equal((await call('hook-secret', '&task=other')).status, 400);
  current.assignment.documents[0].fields.harness.resources[0].digest = '0'.repeat(64);
  assert.equal((await call()).status, 409); assert.equal(calls, before);
  current = snapshot(); current.nodeId = 'neighbor';
  assert.equal((await call()).status, 409); assert.equal(calls, before);
  for (const config of [{ schema: 'harness.context7/1', library: 'latest' },
    { schema: 'harness.context7/1', library: '/nodejs/node', endpoint: 'http://elsewhere' }]) {
    current = snapshot(); const item = current.assignment.documents[0].fields.harness.resources[0];
    item.content = JSON.stringify(config); item.digest = createHash('sha256').update(item.content).digest('hex');
    assert.equal((await call()).status, 409); assert.equal(calls, before);
  }
  const helperPath = './support/harness-v2.js';
  const { v2Kit } = await import(helperPath);
  current = snapshot(); current.assignment.documents[0].fields.harness = v2Kit(current.assignment.documents[0].fields.harness);
  assert.equal((await acceptedDocumentation(input, controller, 'w')).accepted.resource.digest, resource().digest);
  current = snapshot(); revoke = true;
  assert.equal((await call()).status, 409); assert.ok(calls > before);
});

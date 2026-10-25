import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/server/harness/invoke-node.js';
import { documentationProbe } from '../src/server/harness/prepare-documentation.js';
import { prepareAccepted } from '../src/server/harness/prepare-accepted.js';

const execution = { executionId: 'e', epoch: 1, project: 'p', workspace: 'w', nodeId: 'n', acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64) };
const resource = { id: 'mcp:docs', digest: sha256('config') };
const answer = () => ({ schema: 'harness.documentation/1', authority: 'external-reference', endpoint: 'https://mcp.context7.com/mcp', tool: 'query-docs', text: 'Public documentation', digest: sha256('Public documentation'),
  accepted: { execution, resource, adapter: 'context7-documentation/1', authorityCurrentAtCompletion: true } });

test('documentation readiness uses fixed public query and verifies exact accepted execution/resource and response digest', async () => {
  let body: any, request: RequestInit | undefined;
  const read = (async (_url: any, init: any) => { body = JSON.parse(init.body); request = init; return Response.json(answer()); }) as typeof fetch;
  assert.equal(await documentationProbe('http://localhost:1234', 'worker', 'test', read)(execution, resource), true);
  assert.equal(body.action, 'accepted-query'); assert.equal(body.resource, resource.id);
  assert.deepEqual(Object.keys(body).sort(), ['action', 'query', 'resource']);
  assert.equal(body.query, 'What API usage and version limitations does this library document?');
  assert.equal(request!.redirect, 'error'); assert.ok(request!.signal);
  for (const mutate of [
    (r: ReturnType<typeof answer>) => { r.accepted.execution = { ...execution, epoch: 2 }; },
    (r: ReturnType<typeof answer>) => { r.accepted.resource = { ...resource, digest: 'wrong' }; },
    (r: ReturnType<typeof answer>) => { r.accepted.authorityCurrentAtCompletion = false; },
    (r: ReturnType<typeof answer>) => { r.digest = 'wrong'; },
    (r: ReturnType<typeof answer>) => { r.endpoint = 'https://other.invalid'; },
  ]) {
    const result = answer(); mutate(result);
    assert.equal(await documentationProbe('http://localhost', 'worker', 'test', (async () => Response.json(result)) as typeof fetch)(execution, resource), false);
  }
  for (const result of [new Response('', { status: 429 }), Response.json({}), new Response('x'.repeat(256 * 1024 + 1))])
    assert.equal(await documentationProbe('http://localhost', 'worker', 'test', (async () => result) as typeof fetch)(execution, resource), false);
});

function fixture(count = 1) {
  const content = JSON.stringify({ schema: 'harness.context7/1', library: '/nodejs/node' });
  return { execution, kit: { schema: 'harness.kit/1', resources: Array.from({ length: count }, (_, i) => ({ resource: 'mcp:docs' + i, category: 'mcp', content, digest: sha256(content), requires: ['mcp:context7'] })) } };
}

test('preparation distinguishes working Context7, missing adapter, failed probe, budget and lost authority', async () => {
  const value = fixture();
  const missing = await prepareAccepted(async () => value, process.cwd());
  assert.equal(missing.ready, false); assert.equal(missing.resources[0].reason, 'documentation-adapter-unavailable');
  const passed = await prepareAccepted(async () => value, process.cwd(), { documentation: async () => true });
  assert.equal(passed.ready, true); assert.equal(passed.documentationCalls, 1);
  assert.equal(passed.resources[0].mode, 'context7-documentation');
  assert.equal(passed.resourceContentsExecuted, false); assert.equal(passed.permissionsGranted, false);
  const failed = await prepareAccepted(async () => value, process.cwd(), { documentation: async () => { throw new Error('offline'); } });
  assert.equal(failed.ready, false); assert.equal(failed.resources[0].state, 'unavailable');
  const budget = await prepareAccepted(async () => fixture(3), process.cwd(), { documentation: async () => true });
  assert.equal(budget.ready, false); assert.equal(budget.documentationCalls, 2); assert.equal(budget.resources[2].reason, 'documentation-probe-budget');
  let stale = false;
  const revoked = await prepareAccepted(async () => ({ ...value, execution: stale ? { ...execution, epoch: 2 } : execution }), process.cwd(), { documentation: async () => { stale = true; return true; } });
  assert.equal(revoked.ready, false); assert.equal(revoked.resources[0].reason, 'execution-changed-or-unavailable');
});

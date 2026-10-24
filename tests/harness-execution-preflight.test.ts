import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecutionDispatch } from '../src/server/opora/execution-dispatch.js';
import type { ExecutionLease } from '../src/server/opora/execution-client.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

test('registered preflight precedes claim, and claimed drift releases before seat', async t => {
  const previous = [process.env.AGENT_OFFICE_HARNESS_PREFLIGHT, process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION];
  process.env.AGENT_OFFICE_HARNESS_PREFLIGHT = '1'; process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION = '2';
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-preflight-'));
  const scope = { project: 'p', workspace: 'w', nodeId: 'n' }, order: string[] = [];
  const context = { available: true, unavailableReason: null, acceptedHead: 'a'.repeat(40), contextVersion: 'c'.repeat(64), contextProtocolVersion: 2 as const };
  const preview = { schema: 'harness.preflight/1', scope, contextProtocolVersion: 2,
    acceptedHead: context.acceptedHead, contextVersion: context.contextVersion, assignmentDigest: 'b'.repeat(64),
    kit: null, kitDigest: null, evidence: 'accepted-context-preview', executionAuthority: false,
    runnerReadinessVerified: false, permissionsGranted: false };
  let mode = 'valid';
  const server = http.createServer(async (req, res) => {
    order.push('preview');
    assert.equal(req.url, '/api/oporahub/harness-preflight'); assert.equal(req.method, 'POST');
    assert.equal(req.headers['x-opora-actor'], 'agent; name=office');
    let body = ''; for await (const part of req) body += part;
    assert.deepEqual(JSON.parse(body), { ...scope, expectedAcceptedHead: context.acceptedHead, expectedContextVersion: context.contextVersion });
    if (mode === 'missing') { res.writeHead(404); res.end(); return; }
    if (mode === 'oversized') { res.end('x'.repeat(256 * 1024 + 1)); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(mode === 'foreign' ? { ...preview, scope: { ...scope, workspace: 'foreign' } }
      : mode === 'authority' ? { ...preview, permissionsGranted: true } : preview));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const dispatch = new ExecutionDispatch('http://127.0.0.1:' + (server.address() as { port: number }).port, 'office', dir, () => [], () => {}, () => {});
  t.after(() => {
    dispatch.controller.shutdown(); server.close(); server.closeAllConnections(); rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['AGENT_OFFICE_HARNESS_PREFLIGHT', previous[0]], ['AGENT_OFFICE_OPORA_CONTEXT_VERSION', previous[1]]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  dispatch.client.context = async () => { order.push('context'); return context; };
  let drift = false, kitDrift = false;
  const lease = (): ExecutionLease => ({ ...scope, executionId: 'one', epoch: 1, token: 'd'.repeat(64),
    acceptedRevision: context.acceptedHead, assignmentDigest: drift ? 'e'.repeat(64) : preview.assignmentDigest,
    contextProtocolVersion: 2, assignment: { contextProtocolVersion: 2, contextVersion: context.contextVersion,
      documents: [{ nodeId: scope.nodeId, fields: kitDrift ? { harness: { schema: 'harness.kit/1', problems: ['check'], resources: [] } } : {} }] }, serverNow: 100, expiresAt: 1000, state: 'running' });
  dispatch.controller.claim = async () => { order.push('claim'); return { lease: lease(), deadline: performance.now() + 10000 }; };
  dispatch.client.release = async () => { order.push('release'); };
  const run = () => dispatch.dispatch(scope, async () => { throw new Error('Live v2 preparation must not run'); }, prompt => {
    order.push('seat'); return { id: 'worker', via: 'opora', prompt, status: 'working' } as WorkerInfo;
  });
  for (mode of ['missing', 'oversized', 'foreign', 'authority']) {
    order.length = 0; await assert.rejects(run(), /preflight/); assert.deepEqual(order, ['context', 'preview']);
  }
  mode = 'valid'; drift = true; order.length = 0;
  await assert.rejects(run(), /preflight/); assert.deepEqual(order, ['context', 'preview', 'claim', 'release']);
  drift = false; kitDrift = true; order.length = 0;
  await assert.rejects(run(), /preflight/); assert.deepEqual(order, ['context', 'preview', 'claim', 'release']);
  kitDrift = false; order.length = 0;
  const result = await run(); assert.deepEqual(order, ['context', 'preview', 'claim', 'seat']);
  await dispatch.release({ workerId: result.worker.id, execution: result.execution });
});

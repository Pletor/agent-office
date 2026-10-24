import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acceptedReceipt, invokeNode } from '../src/server/harness/invoke-node.js';
import { prepareAccepted } from '../src/server/harness/prepare-accepted.js';
import { validateAdapterKit } from '../src/server/harness/adapter-kit.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function receipt() {
  const content = "console.log('v2-run')", digest = sha(content);
  const resource = { slot: 'scripts.run', resource: 'script:run', category: 'scripts', content, digest, requires: ['command:node'] };
  return { execution: { executionId: 'exec-1', epoch: 1, project: 'p', workspace: 'w', nodeId: 'n',
    acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64) }, kit: {
    schema: 'harness.kit/2', problems: ['tool.run'], resources: [resource], selection: {
      schema: 'harness.selection/1', policy: 'harness.recommendation/1', problem: 'tool.run',
      profileRevision: 1, declaredCapabilities: ['command:node'], evidence: 'caller-declared-selection',
      entries: [{ resource: resource.resource, digest, order: 0, reason: 'explicit-assignment',
        versionDigest: sha(JSON.stringify({ category: resource.category, digest, requires: resource.requires, resource: resource.resource })),
        assignments: [{ slot: 'work', scope: 'global', node: null }] }] } } };
}

test('unknown kit versions are refused even through a direct reader', async () => {
  const value = receipt(); value.kit.schema = 'harness.kit/99';
  await assert.rejects(validateAdapterKit(value.kit), /Unsupported/);
  await assert.rejects(prepareAccepted(async () => value, process.cwd()), /Unsupported/);
  await assert.rejects(invokeNode(async () => value, 'script:run', [], process.cwd()), /Unsupported/);
});

test('v2 requires the optional real validator before preparation or execution; composed installs preserve provenance', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-adapter-kit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = receipt(), before = structuredClone(value);
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const read = () => acceptedReceipt(base, 'worker', 'isolated-hook');
  const cli = (args: string[]) => promisify(execFile)(process.execPath, ['bin/office-harness.js', ...args], {
    env: { ...process.env, AGENT_OFFICE_HOOK_URL: base, AGENT_OFFICE_WORKER_ID: 'worker', AGENT_OFFICE_HOOK_TOKEN: 'isolated-hook' },
    timeout: 15_000,
  });
  const installed = existsSync(new URL('../src/server/harness/accepted-kit.ts', import.meta.url));
  if (!installed) {
    await assert.rejects(read(), /v2 validation is unavailable/);
    await assert.rejects(prepareAccepted(async () => value, root, { tempRoot: root }), /v2 validation is unavailable/);
    await assert.rejects(invokeNode(async () => value, 'script:run', [], root, { tempRoot: root }), /v2 validation is unavailable/);
    await assert.rejects(cli(['--prepare-accepted']), /v2 validation is unavailable/);
    await assert.rejects(cli(['--invoke-node', 'script:run']), /v2 validation is unavailable/);
  } else {
    assert.deepEqual(await read(), value);
    const prepared = await prepareAccepted(read, root, { tempRoot: root });
    assert.equal(prepared.ready, true); assert.equal(prepared.resourceContentsExecuted, false);
    const invoked = await invokeNode(read, 'script:run', [], root, { tempRoot: root });
    assert.equal(invoked.stdout, 'v2-run\n'); assert.equal(invoked.outcome, 'pass');
    assert.equal(invoked.independentlyVerified, false);
    const readiness = JSON.parse((await cli(['--prepare-accepted'])).stdout);
    assert.equal(readiness.ready, true); assert.equal(readiness.resourceContentsExecuted, false);
    const observed = JSON.parse((await cli(['--invoke-node', 'script:run'])).stdout);
    assert.equal(observed.stdout, 'v2-run\n'); assert.equal(observed.outcome, 'pass');
    assert.equal(observed.independentlyVerified, false); assert.equal(observed.promotionAllowed, false);
    const broken = structuredClone(value); broken.kit.selection.entries[0].versionDigest = '0'.repeat(64);
    await assert.rejects(prepareAccepted(async () => broken, root, { tempRoot: root }));
    await assert.rejects(invokeNode(async () => broken, 'script:run', [], root, { tempRoot: root }));
  }
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(value, before);
});

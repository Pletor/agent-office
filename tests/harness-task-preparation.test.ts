import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { acceptedReceipt, sha256 } from '../src/server/harness/invoke-node.js';
import { prepareTask } from '../src/server/harness/prepare-task.js';

const execution = { executionId: 'e', epoch: 1, project: 'p', workspace: 'w', nodeId: 'n',
  acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64) };
test('automatic task preparation distinguishes no kit from unavailable or changed authority', async () => {
  const empty = { execution, kit: null };
  const report = await prepareTask(async () => empty, process.cwd());
  assert.equal(report.ready, true); assert.equal(report.kitPresent, false);
  let reads = 0;
  const changed = await prepareTask(async () => ++reads === 1 ? empty : { ...empty, execution: { ...execution, epoch: 2 } }, process.cwd());
  assert.equal(changed.ready, false);
  await assert.rejects(prepareTask(async () => { throw new Error('offline'); }, process.cwd()), /offline/);
  const content = 'Use verified outcomes';
  const equipped = await prepareTask(async () => ({ execution, kit: { schema: 'harness.kit/1', resources: [
    { resource: 'rule:one', category: 'rules', content, digest: sha256(content), requires: [] },
  ] } }), process.cwd());
  assert.equal(equipped.ready, true); assert.equal(equipped.kitPresent, true);
});

test('only explicit nullable task preparation accepts a null kit; missing kit still fails', async t => {
  let value: unknown = { execution, kit: null };
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture'); res.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  await assert.rejects(acceptedReceipt(base, 'worker', 'fixture'));
  assert.equal((await acceptedReceipt(base, 'worker', 'fixture', { allowEmptyKit: true })).kit, null);
  value = { execution };
  await assert.rejects(acceptedReceipt(base, 'worker', 'fixture', { allowEmptyKit: true }));
  value = { execution: { ...execution, epoch: 0 }, kit: null };
  await assert.rejects(acceptedReceipt(base, 'worker', 'fixture', { allowEmptyKit: true }));
});

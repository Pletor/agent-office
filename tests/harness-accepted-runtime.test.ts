import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExecutionClient, type ExecutionLease } from '../src/server/opora/execution-client.js';
import { ExecutionController } from '../src/server/opora/execution-controller.js';
import { acceptedKit, validateAcceptedKit } from '../src/server/harness/accepted-kit.js';
import { officeHarness } from '../src/server/harness/api.js';
import type { Ctx } from '../src/server/office/context.js';
import { budgetLease } from './support/opora-budget.js';
import { v2Kit } from './support/harness-v2.js';

const digest = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
function kit(content = 'node run.mjs') {
  return { schema: 'harness.kit/1', problems: ['tool.run'], resources: [{ slot: 'scripts.run', resource: 'el:project:script',
    category: 'scripts', digest: digest(content), content, requires: ['command:node'] }] };
}
function lease(assignment: Record<string, unknown>, contextProtocolVersion = 2): ExecutionLease {
  return { ...budgetLease(), nodeId: 'target', contextProtocolVersion: contextProtocolVersion as 1 | 2, assignment };
}

for (const selected of [kit(), v2Kit(kit())]) test(`${selected.schema} HTTP lookup authenticates first and returns only the current worker target snapshot`, async (t) => {
  const neighbor = { ...kit('secret neighbor'), resources: [{ ...kit('secret neighbor').resources[0], resource: 'neighbor-secret' }] };
  const assignment = { contextVersion: 'accepted-context', documents: [
    { nodeId: 'target', fields: { title: 'Target', harness: selected } },
    { nodeId: 'neighbor', fields: { title: 'Neighbor', harness: neighbor } },
  ] };
  const controller = new ExecutionController(new ExecutionClient('http://127.0.0.1', 'test'), () => {}, () => {}, () => 0);
  const active = lease(assignment);
  controller.watch('worker-1', active, 10_000);
  let assignmentReads = 0;
  const original = controller.assignmentFor.bind(controller);
  controller.assignmentFor = (id) => { assignmentReads++; return original(id); };
  const floor = { opora: { executions: { controller } }, workers: { authenticate: (id: string, token: string) => token === 'hook-secret' ? { id } : undefined } };
  const ctx = { workerFloor: (id: string) => id ? floor : undefined } as unknown as Ctx;
  const server = http.createServer((req, res) => void officeHarness(ctx, req, res, new URL(req.url!, 'http://x')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { controller.shutdown(); server.close(); server.closeAllConnections(); });
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const call = (worker = 'worker-1', token = 'hook-secret', suffix = '') => fetch(`${base}/office/harness?worker=${worker}&accepted-kit${suffix}`, { headers: { authorization: `Bearer ${token}` } });

  assert.equal((await call('worker-1', 'bad')).status, 401);
  assert.equal(assignmentReads, 0, 'unauthenticated request never asks the controller for assignment data');
  const response = await call();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json() as Record<string, any>;
  assert.deepEqual(body.kit, selected);
  assert.equal(body.execution.executionId, active.executionId);
  assert.equal(body.execution.assignmentDigest, active.assignmentDigest);
  assert.equal('token' in body.execution, false);
  assert.equal(JSON.stringify(body).includes(active.token), false, 'private capability never appears anywhere in the response');
  assert.equal('assignment' in body.execution, false);
  assert.equal(JSON.stringify(body).includes('secret neighbor'), false);
  assert.equal(body.evidence, 'accepted-selection-only');
  assert.equal(body.invocationObserved, false);
  assert.equal(body.capabilitiesVerified, false);
  assert.equal(body.promotionAllowed, false);
  const cli = await promisify(execFile)(process.execPath, ['bin/office-harness.js', '--accepted-kit'], {
    env: { ...process.env, AGENT_OFFICE_HOOK_URL: base, AGENT_OFFICE_WORKER_ID: 'worker-1', AGENT_OFFICE_HOOK_TOKEN: 'hook-secret' },
  });
  assert.deepEqual(JSON.parse(cli.stdout).kit, selected, 'real worker CLI receives the pinned kit');
  assert.equal((await call('worker-2')).status, 409, 'another worker has no lease');
  assert.equal((await call('worker-1', 'hook-secret', '&task=neighbor')).status, 400, 'caller cannot select a different card');

  const detached = controller.assignmentFor('worker-1')!;
  (detached.assignment.documents as any[])[0].fields.harness.resources[0].content = 'mutated request snapshot';
  assert.equal((active.assignment.documents as any[])[0].fields.harness.resources[0].content, 'node run.mjs', 'assignmentFor returns a detached snapshot');
  assert.deepEqual((await (await call()).json() as any).kit, selected, 'reading or mutating the snapshot never changes the active lease');

  controller.watch('worker-1', lease(assignment, 1), 10_000);
  assert.equal((await call()).status, 409, 'legacy context must not supply an accepted kit');
  controller.watch('worker-1', lease({ documents: [{ nodeId: 'target', fields: { harness: { ...selected, secret: 'do-not-reflect' } } }] }), 10_000);
  const invalid = await call();
  assert.equal(invalid.status, 409);
  assert.doesNotMatch(await invalid.text(), /do-not-reflect/);

  let now = 0;
  const expiring = new ExecutionController(new ExecutionClient('http://127.0.0.1', 'test'), () => {}, () => {}, () => now);
  expiring.watch('expiring', active, 100);
  const expiringFloor = { ...floor, opora: { executions: { controller: expiring } } };
  ctx.workerFloor = (id: string) => id === 'expiring' ? expiringFloor : floor;
  now = 100;
  assert.equal((await call('expiring')).status, 409, 'expired lease is refused');
  expiring.shutdown();

  controller.forget('worker-1');
  assert.equal((await call()).status, 409, 'forgotten worker lease is refused');
  const shutdown = new ExecutionController(new ExecutionClient('http://127.0.0.1', 'test'), () => {}, () => {}, () => 0);
  shutdown.watch('shutdown-worker', active, 10_000);
  const shutdownFloor = { ...floor, opora: { executions: { controller: shutdown } } };
  ctx.workerFloor = (id: string) => id === 'shutdown-worker' ? shutdownFloor : floor;
  shutdown.shutdown();
  assert.equal((await call('shutdown-worker')).status, 409, 'controller shutdown clears v2 authority');
});

test('accepted kit validates digest, identity, UTF-8 and size bounds', () => {
  const exact = kit();
  assert.deepEqual(acceptedKit({ documents: [{ nodeId: 'other', fields: { harness: kit('neighbor') } }] }, 'target'), null);
  for (const bad of [
    { ...exact, resources: [{ ...exact.resources[0], digest: '0'.repeat(64) }] },
    { ...exact, resources: [exact.resources[0], { ...exact.resources[0], slot: 'scripts.other' }] },
    { ...exact, problems: ['tool.run\n'] },
    { ...exact, resources: [{ ...exact.resources[0], slot: 'scripts.run\n' }] },
    { ...exact, resources: [{ ...exact.resources[0], requires: ['command:node', 'command:node'] }] },
    kit('é'.repeat(17000)),
    { ...exact, resources: [{ ...exact.resources[0], content: '\ud800', digest: digest('\ud800') }] },
    { ...exact, resources: [{ ...exact.resources[0], content: 'x'.repeat(96 * 1024 + 1), digest: digest('x'.repeat(96 * 1024 + 1)) }] },
  ]) assert.throws(() => validateAcceptedKit(bad), /Accepted Harness kit is invalid/);
  assert.throws(() => acceptedKit({ documents: [{ nodeId: 'target', fields: { harness: exact } }, { nodeId: 'target', fields: { harness: exact } }] }, 'target'), /Accepted Harness kit is invalid/);
  assert.throws(() => validateAcceptedKit({ ...exact, resources: Array(25).fill(exact.resources[0]) }), /Accepted Harness kit is invalid/);
  assert.deepEqual(validateAcceptedKit(kit('𝄞 café')), kit('𝄞 café'));
  assert.deepEqual(acceptedKit({ documents: [{ nodeId: 'target', fields: {} }] }, 'target'), null);
  assert.equal(acceptedKit({}, 'target'), null);
  assert.equal(acceptedKit({ documents: [{ nodeId: 'target' }] }, 'target'), null);
  assert.deepEqual(validateAcceptedKit({ ...exact, resources: [] }), { ...exact, resources: [] });
});

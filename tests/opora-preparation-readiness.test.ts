import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecutionDispatch } from '../src/server/opora/execution-dispatch.js';
import type { ExecutionLease } from '../src/server/opora/execution-client.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { verifyWorkerReadiness } from '../src/server/opora/execution-worker-readiness.js';
import type { ExecutionController } from '../src/server/opora/execution-controller.js';

const scope = { project: 'project', workspace: 'draft', nodeId: 'card' };
test('runtime readiness has claimed authority before provider start; refusal releases and cancels', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-runtime-readiness-')), order: string[] = [];
  const dispatch = new ExecutionDispatch('http://localhost:1', 'office', dir, () => [], () => {}, () => {});
  t.after(() => { dispatch.controller.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const lease: ExecutionLease = { ...scope, executionId: 'execution', token: 'fixture', epoch: 1,
    acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64),
    assignment: { contextVersion: 'context', documents: { card: 'accepted task' } }, state: 'running', serverNow: 100, expiresAt: 1000 };
  dispatch.controller.claim = async () => { order.push('claim'); return { lease, deadline: performance.now() + 10_000 }; };
  dispatch.client.release = async () => { order.push('release'); };
  let refuse = true;
  const staged = {
    worker: { id: 'worker' } as WorkerInfo,
    async verify() {
      order.push('verify');
      assert.equal(dispatch.controller.allowed('worker'), true);
      await Promise.resolve();
      if (refuse) throw new Error('equipment unavailable');
    },
    start(prompt: string) {
      order.push('start');
      const info = { id: 'worker', via: 'opora', prompt, status: 'working' } as WorkerInfo;
      assert.equal(dispatch.guard.check(info), undefined);
      return info;
    },
    async cancel() { order.push('cancel'); return {}; },
  };
  const run = () => dispatch.dispatch(scope, async () => '', () => { throw new Error('legacy seat'); }, undefined, undefined, async () => staged);
  await assert.rejects(run(), /equipment unavailable/);
  assert.deepEqual(order, ['claim', 'verify', 'release', 'cancel']);
  assert.equal(dispatch.controller.allowed('worker'), false);
  refuse = false; order.length = 0;
  const result = await run();
  assert.deepEqual(order, ['claim', 'verify', 'start']);
  assert.equal(result.worker.id, 'worker');
  assert.equal(dispatch.controller.allowed('worker'), true);
});

test('readiness refuses missing identity and lost authority without starting a provider', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-runtime-expiry-'));
  const dispatch = new ExecutionDispatch('http://localhost:1', 'office', dir, () => [], () => {}, () => {});
  t.after(() => { dispatch.controller.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const lease: ExecutionLease = { ...scope, executionId: 'execution', token: 'fixture', epoch: 1,
    acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64),
    assignment: { contextVersion: 'context', documents: { card: 'task' } }, state: 'running', serverNow: 100, expiresAt: 1000 };
  dispatch.controller.claim = async () => ({ lease, deadline: performance.now() + 10_000 });
  let releases = 0, cancels = 0;
  dispatch.client.release = async () => { releases++; };
  const staged = { start: () => { throw new Error('must not start'); }, cancel: async () => { cancels++; return {}; },
    verify: async () => { dispatch.controller.forget('worker'); } };
  const run = (worker = staged) => dispatch.dispatch(scope, async () => '', () => { throw new Error('legacy seat'); }, undefined, undefined, async () => worker);
  await assert.rejects(run(), /reserved worker identity/);
  await assert.rejects(run({ ...staged, worker: { id: 'worker' } as WorkerInfo } as typeof staged), /expired during worker readiness/);
  assert.equal(releases, 2); assert.equal(cancels, 2); assert.equal(dispatch.controller.allowed('worker'), false);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let watched = false;
  dispatch.controller.watch = () => { watched = true; };
  dispatch.controller.allowed = () => watched;
  dispatch.controller.forget = () => { watched = false; };
  const stuck = run({ ...staged, worker: { id: 'worker' } as WorkerInfo, verify: async () => { await new Promise(() => {}); } } as typeof staged);
  const rejected = assert.rejects(stuck, /readiness deadline exceeded/);
  // Let dispatch reach the verifier without advancing real time or starting heartbeats.
  for (let i = 0; i < 20 && !watched; i++) await Promise.resolve();
  assert.equal(watched, true);
  t.mock.timers.tick(10_000); await rejected;
  assert.equal(releases, 3); assert.equal(cancels, 3); assert.equal(watched, false);
});

test('a hung readiness callback is bounded and receives cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let watched = false, signal: AbortSignal | undefined;
  const controller = { allowed: () => watched, watch: () => { watched = true; }, forget: () => { watched = false; } } as unknown as ExecutionController;
  const result = verifyWorkerReadiness(controller, { lease: {} as ExecutionLease, deadline: performance.now() + 100_000 }, {
    worker: { id: 'worker' } as WorkerInfo,
    verify: async value => { signal = value; await new Promise(() => {}); },
    start: () => { throw new Error('must not start'); }, cancel: async () => ({}),
  });
  const rejected = assert.rejects(result, /readiness deadline exceeded/);
  await Promise.resolve();
  t.mock.timers.tick(60_000); await rejected;
  assert.equal(signal?.aborted, true); assert.equal(watched, false);
});

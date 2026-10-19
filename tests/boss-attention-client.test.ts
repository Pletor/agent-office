import test from 'node:test';
import assert from 'node:assert/strict';
import type { BossAttention } from '../src/shared/boss-attention.js';
import { AttentionController } from '../src/client/features/bossattention/controller.js';

const data = (name: string): BossAttention => ({ project: { id: name, name }, workspace: { id: 'w', label: 'Work' }, checkedAt: 1, scope: 'linked-workspace', status: 'ready', items: [], system: [] });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('attention rejects late old-floor responses and clears old questions immediately', async () => {
  const reads: { signal: AbortSignal; resolve: (value: BossAttention) => void }[] = [];
  const c = new AttentionController((_floor, signal) => new Promise((resolve) => reads.push({ signal, resolve })));
  c.setScope('one', 'p1', 'w1');
  c.setScope('two', 'p2', 'w2');
  assert.equal(reads[0].signal.aborted, true);
  assert.equal(c.view.data, undefined);
  reads[1].resolve(data('two')); await tick();
  reads[0].resolve(data('one')); await tick();
  assert.equal(c.view.data?.project?.id, 'two');
  assert.equal(c.view.loading, false);
});

test('workspace changes reset; unchanged scope does not refetch', async () => {
  let calls = 0;
  const c = new AttentionController(async () => { calls++; return data('project'); });
  c.setScope('f', 'p', 'w1'); await tick();
  c.setScope('f', 'p', 'w1'); await tick();
  assert.equal(calls, 1);
  c.setScope('f', 'p', 'w2');
  assert.equal(c.view.data, undefined);
  await tick(); assert.equal(calls, 2);
});

test('failed refresh shows unknown state, not stale empty success', async () => {
  let fail = false;
  const c = new AttentionController(async () => { if (fail) throw new Error('offline'); return data('p'); });
  c.setScope('f', 'p', 'w'); await tick();
  fail = true; await c.refresh();
  assert.equal(c.view.data, undefined);
  assert.match(c.view.error!, /offline/);
  assert.equal(c.view.loading, false);
});

test('no overlapping reads; observers unsubscribe; leaving floor clears data', async () => {
  let resolve!: (value: BossAttention) => void;
  let calls = 0, changes = 0;
  const c = new AttentionController(() => { calls++; return new Promise((r) => { resolve = r; }); });
  const off = c.onChange(() => changes++);
  c.setScope('f', 'p', 'w');
  await c.refresh(); assert.equal(calls, 1);
  resolve(data('p')); await tick();
  off(); const before = changes;
  c.setScope(null, null, null);
  assert.equal(changes, before);
  assert.equal(c.view.data, undefined);
  assert.match(c.view.error!, /patra/);
});

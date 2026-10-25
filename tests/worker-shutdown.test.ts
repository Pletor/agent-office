import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerManager } from '../src/server/workers.js';
import { Ledger } from '../src/server/usage.js';
import type { Worker } from '../src/server/workers/types.js';

for (const keep of [false, true]) test(`shutdown (${keep ? 'restart' : 'stop'}) refuses new, resumed and deferred launches`, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-worker-shutdown-'));
  const manager = new WorkerManager(dir, dir, process.execPath, [], { url: 'http://127.0.0.1:1', token: '' },
    { update() {}, remove() {}, data() {}, screen() {}, toast() {} },
    new Ledger(dir, { pauseHiring: false }, () => {}, () => {}));
  t.after(() => { manager.shutdown(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
  let launches = 0;
  manager.launchGuards.add({ applies: () => true, restore: async () => undefined, check: () => {
    launches++; return 'Fixture intercepts before any provider or external process';
  } });
  const worker = manager.spawn('desk-1', 'test', 'initial', false, 'agent', 'custom');
  assert.notEqual(typeof worker, 'string');
  if (typeof worker === 'string') return;
  const internals = manager as unknown as { workers: Map<string, Worker>; launch(w: Worker, prompt: string, resume: undefined): void };
  const pendingWorker = internals.workers.get(worker.id)!;
  let finish!: () => void;
  // A queued setup completion owns the existing Worker even after shutdown returns.
  const pending = new Promise<void>(resolve => { finish = resolve; }).then(() => internals.launch(pendingWorker, 'prepared', undefined));
  manager.shutdown(keep);
  const before = launches;
  finish(); await pending;
  assert.equal(launches, before, 'a deferred completion must not enter provider/authority launch hooks after shutdown');
  assert.match(manager.resume(worker.id, 'again') ?? '', /shutting down/i);
  assert.match(String(manager.spawn('desk-2', 'test', 'new', false, 'agent', 'custom')), /shutting down/i);
  assert.equal(internals.workers.size, 1, 'closed manager must not allocate another worker');
  assert.equal(launches, before);
});

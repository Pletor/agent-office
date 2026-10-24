import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerManager } from '../src/server/workers.js';
import { Ledger } from '../src/server/usage.js';
import { stagedWorker, stageTimeout } from '../src/server/workers/staged-start.js';
import type { Worker } from '../src/server/workers/types.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-staging-')), data = path.join(root, 'data'); mkdirSync(data);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main'); writeFileSync(path.join(root, 'source.txt'), 'source'); git('add', 'source.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, 'commit', '-m', 'fixture');
  const managers: WorkerManager[] = [];
  const create = () => {
    const m = new WorkerManager(root, data, process.execPath, [], { url: 'http://127.0.0.1:1', token: '' },
      { update() {}, remove() {}, data() {}, screen() {}, toast() {} }, new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
    managers.push(m); return m;
  };
  t.after(() => { for (const m of managers) m.shutdown(); rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });
  return { root, data, create };
}

test('staging reserves a real worktree without launching, refuses resume, and safely cancels once', async t => {
  const f = fixture(t), m = f.create(); let calls = 0;
  m.launchGuards.add({ applies: () => true, restore: async () => undefined, check: () => { calls++; return 'authority missing'; } });
  const stage = m.stage({ deskId: 'desk-1', by: 'test', worktree: true, provider: 'custom' });
  assert.notEqual(typeof stage, 'string'); if (typeof stage === 'string') return;
  assert.ok(existsSync(path.join(stage.cwd, 'source.txt'))); assert.equal(calls, 0);
  assert.equal(m.deskOccupied('desk-1'), true); assert.equal(m.owners().find(x => x.workerId === stage.worker.id)?.cwd, stage.cwd);
  assert.match(m.resume(stage.worker.id)!, /preparation/);
  assert.equal(typeof m.stage({ deskId: 'desk-1', by: 'test' }), 'string');
  const first = stage.cancel(); assert.equal(stage.cancel(), first); await first;
  assert.equal(m.get(stage.worker.id), undefined); assert.equal(m.deskOccupied('desk-1'), false);
  assert.equal(existsSync(stage.cwd), false); assert.equal(stage.signal.aborted, true);
  assert.match(String(stage.start('task')), /consumed|cancelled/); assert.equal(calls, 0);
});

test('staged work survives cancellation when modified; an authority refusal cleans the reservation', async t => {
  const f = fixture(t), m = f.create(); let calls = 0;
  m.launchGuards.add({ applies: () => true, restore: async () => undefined, check: () => { calls++; return 'no execution lease'; } });
  const stage = m.stage({ deskId: 'desk-1', by: 'test', worktree: true, provider: 'custom' });
  if (typeof stage === 'string') throw new Error(stage);
  writeFileSync(path.join(stage.cwd, 'source.txt'), 'valuable change');
  assert.match(String(stage.start('accepted task')), /no execution lease/); assert.equal(calls, 1);
  await stage.cancel(); assert.equal(m.get(stage.worker.id), undefined);
  assert.equal(readFileSync(path.join(stage.cwd, 'source.txt'), 'utf8'), 'valuable change');
  assert.match(String(stage.start('again')), /consumed|cancelled/);
});

test('an uncommitted preparation cannot resume after persistence and restart', async t => {
  const f = fixture(t), before = f.create();
  const stage = before.stage({ deskId: 'desk-1', by: 'test', worktree: true, provider: 'custom' });
  if (typeof stage === 'string') throw new Error(stage);
  before.shutdown(true); const after = f.create(); let calls = 0;
  const saved = readFileSync(path.join(f.data, 'workers.json'), 'utf8');
  assert.equal(stage.signal.aborted, true); await stage.cancel();
  assert.equal(readFileSync(path.join(f.data, 'workers.json'), 'utf8'), saved, 'old manager cannot overwrite successor state');
  assert.ok(existsSync(stage.cwd), 'old handle cannot remove the restored worktree');
  after.launchGuards.add({ applies: () => true, restore: async () => undefined, check: () => { calls++; return 'fixture'; } });
  assert.match(after.resume(stage.worker.id)!, /preparation/); after.wakeAll(); assert.equal(calls, 0);
  assert.ok(existsSync(stage.cwd));
  await after.kill(stage.worker.id, 'keep'); await stage.cancel();
});

test('one-use start and bounded expiration retain separate execution and preparation lifetimes', async () => {
  const w = { info: { id: 'fixture', status: 'exited' }, preparing: true } as Worker;
  let starts = 0, cancels = 0;
  const stage = stagedWorker(w, '.', 1000, { current: () => true, start: () => { starts++; w.info.status = 'idle'; return undefined; },
    cancel: async () => { cancels++; return {}; }, persist() {} });
  assert.equal(typeof stage.start('task'), 'object'); assert.match(String(stage.start('again')), /consumed/);
  assert.match((await stage.cancel()).error!, /already started/); assert.equal(starts, 1); assert.equal(cancels, 0);
  const expired = stagedWorker({ info: { id: 'other' }, preparing: true } as Worker, '.', 10,
    { current: () => true, start: () => { throw new Error('must not start'); }, cancel: async () => { cancels++; return {}; }, persist() {} });
  await new Promise(resolve => setTimeout(resolve, 25)); await expired.cancel();
  assert.equal(expired.signal.aborted, true); assert.equal(cancels, 1); assert.match(String(expired.start('task')), /cancelled/);
  for (const value of [0, -1, NaN, Infinity, 7_200_001]) assert.throws(() => stageTimeout(value));
});

test('cancellation rechecks ownership before cleanup and failed starts restore the preparation marker', async () => {
  let current = true, cancels = 0;
  const w = { info: { id: 'fixture', status: 'exited', prompt: 'before' }, preparing: true } as Worker;
  const host = { current: () => current, start: () => { throw new Error('provider setup failed'); },
    cancel: async () => { cancels++; return {}; }, persist() {} };
  const stale = stagedWorker(w, '.', 1000, host);
  const pending = stale.cancel(); current = false;
  assert.match((await pending).note!, /no longer active/); assert.equal(cancels, 0);
  current = true;
  const failed = stagedWorker(w, '.', 1000, host);
  assert.throws(() => failed.start('new task'), /provider setup failed/);
  assert.equal(w.preparing, true); assert.equal(w.info.prompt, 'before');
  await failed.cancel(); assert.equal(cancels, 1);
  assert.match(String(failed.start('retry')), /consumed|cancelled/);
});

test('cancel waits for tracked installer writes and preserves their changes before releasing the desk', async t => {
  const f = fixture(t), m = f.create();
  const stage = m.stage({ deskId: 'desk-1', by: 'test', worktree: true, provider: 'custom' });
  if (typeof stage === 'string') throw new Error(stage);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const preparation = stage.prepare(async (cwd, signal) => {
    assert.equal(signal.aborted, false); await gate;
    writeFileSync(path.join(cwd, 'source.txt'), 'installer finishing after cancellation');
  });
  const rejected = assert.rejects(preparation, /cancelled/);
  await Promise.resolve();
  assert.match(String(stage.start('task')), /still running/);
  await assert.rejects(stage.prepare(async () => {}), /already running/);
  const cancelled = stage.cancel();
  await Promise.resolve();
  assert.equal(stage.signal.aborted, true); assert.equal(m.deskOccupied('desk-1'), true);
  assert.ok(existsSync(stage.cwd));
  finish(); await rejected; await cancelled;
  assert.equal(m.deskOccupied('desk-1'), false);
  assert.equal(readFileSync(path.join(stage.cwd, 'source.txt'), 'utf8'), 'installer finishing after cancellation');
});

test('tracked preparation failure cancels the allocation without starting a worker', async t => {
  const f = fixture(t), m = f.create();
  const stage = m.stage({ deskId: 'desk-1', by: 'test', worktree: true, provider: 'custom' });
  if (typeof stage === 'string') throw new Error(stage);
  await assert.rejects(stage.prepare(async () => { throw new Error('setup failed'); }), /setup failed/);
  await stage.cancel(); assert.equal(m.get(stage.worker.id), undefined);
  assert.equal(existsSync(stage.cwd), false);
  assert.match(String(stage.start('task')), /consumed|cancelled/);
});

test('direct removal and successor removal retain worktrees while a preparation writer may still exist', async t => {
  for (const restart of [false, true]) {
    const f = fixture(t), original = f.create();
    const stage = original.stage({ deskId: 'desk-1', by: 'test', worktree: true, provider: 'custom' });
    if (typeof stage === 'string') throw new Error(stage);
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const work = stage.prepare(async cwd => {
      await gate; writeFileSync(path.join(cwd, 'source.txt'), 'late installer write');
    });
    const rejected = assert.rejects(work, /cancelled/); await Promise.resolve();
    let current = original;
    if (restart) { original.shutdown(true); current = f.create(); }
    await current.kill(stage.worker.id, 'all');
    assert.ok(existsSync(stage.cwd), 'even explicit deletion cannot remove an unsettled staged directory');
    finish(); await rejected; await stage.cancel();
    assert.equal(readFileSync(path.join(stage.cwd, 'source.txt'), 'utf8'), 'late installer write');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerManager } from '../src/server/workers.js';
import { Ledger } from '../src/server/usage.js';
import { stagedWorker, stageTimeout } from '../src/server/workers/staged-start.js';
import { prepareTaskWorker, launchAllocatedWorker } from '../src/server/workers/prepared-task.js';
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

test('task preparation requires a configured installer capability and a successful outcome in the real worktree', async t => {
  for (const outcome of ['missing', 'invalid', 'failed', 'passed']) {
    const f = fixture(t), m = f.create(); let cwd = '';
    mkdirSync(path.join(f.root, '.agent-office'), { recursive: true });
    writeFileSync(path.join(f.root, '.agent-office', 'worktree-setup.json'), '{}');
    const trees = outcome === 'missing' ? {} : { setup: { ensure: async (dir: string) => {
      cwd = dir; assert.ok(existsSync(path.join(dir, 'source.txt')));
      return outcome === 'invalid' ? undefined : { exitCode: outcome === 'passed' ? 0 : 1 };
    } } };
    const prepared = prepareTaskWorker(() => m.stage({ deskId: 'desk-1', by: 'test', worktree: true, provider: 'custom' }), trees, f.root);
    if (outcome === 'passed') {
      const stage = await prepared; assert.equal(stage.cwd, cwd); await stage.cancel();
    } else await assert.rejects(prepared, /installer is unavailable|preparation failed/);
    assert.equal(m.deskOccupied('desk-1'), false);
  }
});

test('allocation waits for setup and rejects stale launch; staged allocation defers setup', async () => {
  const worker = { info: {}, preparing: true } as unknown as import('../src/server/workers/types.js').Worker;
  let setups = 0, current = true; const launched: (string | undefined)[] = [];
  let finish!: (prompt: string) => void;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  const prepare = () => { setups++; return pending; };
  launchAllocatedWorker(worker, 'task', prepare, () => current, p => { launched.push(p); });
  assert.equal(setups, 0); assert.deepEqual(launched, []);
  worker.preparing = undefined;
  launchAllocatedWorker(worker, 'task', prepare, () => current, p => { launched.push(p); });
  assert.equal(setups, 1); assert.deepEqual(launched, []);
  current = false; finish('prepared'); await pending; await Promise.resolve();
  assert.deepEqual(launched, []);
  current = true;
  launchAllocatedWorker(worker, 'task', prepare, () => current, p => { launched.push(p); });
  await Promise.resolve(); assert.deepEqual(launched, ['prepared']);
});

test('startup releases abandoned preparation only after recording retained work, even with a late installer write', async t => {
  const f = fixture(t), before = f.create();
  const stage = before.stage({ deskId: 'desk-1', by: 'test', worktree: true, provider: 'custom' });
  if (typeof stage === 'string') throw new Error(stage);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const pending = stage.prepare(async cwd => { await gate; writeFileSync(path.join(cwd, 'source.txt'), 'late retained work'); });
  const rejected = assert.rejects(pending, /cancelled/); await Promise.resolve();
  before.shutdown(true);
  const after = f.create();
  const host = (after as any).host;
  host.connect = async () => {}; host.killUnclaimed = () => {};
  after.launchGuards.add({ applies: () => true, restore: async () => { throw new Error('must not restore authority'); },
    check: () => { throw new Error('must not launch abandoned preparation'); } });
  await after.start();
  assert.equal(after.deskOccupied('desk-1'), false); assert.deepEqual(after.list(), []);
  assert.ok(existsSync(stage.cwd));
  const directory = path.join(f.data, 'preparation-recovery'), files = readdirSync(directory);
  assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(path.join(directory, files[0]), 'utf8')).record;
  assert.equal(record.workerId, stage.worker.id); assert.equal(record.worktree.path, stage.worker.worktree!.path);
  assert.equal(record.writerState, 'unknown'); assert.equal(record.automaticReuse, false);
  const next = after.stage({ deskId: 'desk-1', by: 'retry', worktree: true, provider: 'custom' });
  if (typeof next === 'string') throw new Error(next);
  assert.notEqual(next.cwd, stage.cwd); await next.cancel();
  finish(); await rejected; await stage.cancel();
  assert.equal(readFileSync(path.join(stage.cwd, 'source.txt'), 'utf8'), 'late retained work');
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.data, 'workers.json'), 'utf8')), []);
});

test('failed recovery record prevents startup authority restoration and preserves the desk', async t => {
  const f = fixture(t), before = f.create();
  const stage = before.stage({ deskId: 'desk-1', by: 'test', worktree: true, provider: 'custom' });
  if (typeof stage === 'string') throw new Error(stage);
  before.shutdown(true);
  writeFileSync(path.join(f.data, 'preparation-recovery'), 'storage unavailable');
  const after = f.create(), host = (after as any).host;
  host.connect = async () => {}; host.killUnclaimed = () => {};
  // Background branch inspection is unrelated to recovery and must not outlive fixture cleanup.
  (after as any).syncBranches = async () => {};
  let restores = 0, launches = 0;
  after.launchGuards.add({ applies: () => true, restore: async () => { restores++; return 'refused'; },
    check: () => { launches++; return 'refused'; } });
  await after.start();
  assert.equal(restores, 0); assert.equal(launches, 0);
  assert.equal(after.deskOccupied('desk-1'), true);
  assert.ok(existsSync(stage.cwd));
  assert.equal(JSON.parse(readFileSync(path.join(f.data, 'workers.json'), 'utf8'))[0].preparing, true);
});

/** A manager whose worktree setup waits on the test and whose launches are recorded, not run. */
function setupGate(m: WorkerManager) {
  const gate = { setups: [] as (string | undefined)[], launched: [] as [string | undefined, string | undefined][], finish: (_p: string | undefined) => {} };
  (m as any).worktrees.setup.prepare = (_dir: string, prompt: string | undefined) => {
    gate.setups.push(prompt);
    return new Promise<string | undefined>(resolve => { gate.finish = resolve; });
  };
  (m as any).launch = (_w: Worker, prompt: string | undefined, resumeSessionId: string | undefined) => { gate.launched.push([prompt, resumeSessionId]); };
  return gate;
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a worker waiting on its worktree setup is not woken without its prompt, and starts with it once setup is done', async t => {
  const f = fixture(t), m = f.create(), gate = setupGate(m);
  const info = m.spawn('desk-1', 'opora', 'do the card', true, 'agent', 'custom', undefined, undefined, undefined, undefined, [], 'opora');
  if (typeof info === 'string') throw new Error(info);
  assert.deepEqual(gate.setups, ['do the card']);
  // A browser walking in (ws connection, floor navigation) wakes everyone not running.
  m.wakeAll();
  assert.match(String(m.resume(info.id)), /setting up/i);
  assert.deepEqual(gate.launched, []);
  gate.finish('do the card\n\nsetup ok'); await settle();
  assert.deepEqual(gate.launched, [['do the card\n\nsetup ok', undefined]]);
  // Setup done: resume behaves as before.
  assert.equal(m.resume(info.id), undefined);
});

test('a worker cut off by an office restart mid-setup runs its setup again and starts with its prompt', async t => {
  const f = fixture(t), before = f.create(); setupGate(before);
  const info = before.spawn('desk-1', 'opora', 'do the card', true, 'agent', 'custom', undefined, undefined, undefined, undefined, [], 'opora');
  if (typeof info === 'string') throw new Error(info);
  before.shutdown(true);
  const after = f.create(), host = (after as any).host, gate = setupGate(after);
  host.connect = async () => {}; host.killUnclaimed = () => {};
  after.syncBranches = async () => {}; // no git left running in the worktree as the fixture is removed
  await after.start();
  assert.deepEqual(gate.setups, ['do the card']);
  assert.deepEqual(gate.launched, []);
  gate.finish('do the card\n\nsetup ok'); await settle();
  assert.deepEqual(gate.launched, [['do the card\n\nsetup ok', undefined]]);
});

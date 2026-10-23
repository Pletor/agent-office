// The save lock's single steps (src/server/harness/lock.ts), each pinned by a test that fails when the
// step is dropped or changed: the token check of a takeover, the put-back that never replaces, the
// release's checks and its put-back, renewal (token, whole record, pause, timer, unref), held(), the
// contention set, the folder errors, and no lock resurrected for a holder that finished. The protocol's
// interleavings of whole saves are in tests/harness-lock.test.ts and tests/harness-commit.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessProfiles } from '../src/server/harness/profiles.js';
import { FileLockError, Lease, withFileLock, type LockFs, type LockRecord } from '../src/server/harness/lock.js';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-lock-steps-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, lock: path.join(dir, 'harness-profiles.json.lock') };
}
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { open, opened };
}
const record = (token: string, renewedAt: number): LockRecord => ({ token, pid: 0, acquiredAt: renewedAt, renewedAt });
const tokenOf = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as LockRecord).token;
const renewedAtOf = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as LockRecord).renewedAt;
const leftovers = (dir: string) => readdirSync(dir).filter((f) => f.includes('.lock'));
const fail = (errno: string) => { const err = new Error(errno) as NodeJS.ErrnoException; err.code = errno; return err; };
const status = (code: number, message: RegExp) => (err: Error & { status: number }) => err.status === code && message.test(err.message);
const unreadable = { read: () => { throw fail('EPERM'); } } as unknown as LockFs;

test('a waiter compares the token as well as the renewal time: a different lock with the same renewal time is put back, not removed', async (t) => {
  const { lock } = fixture(t);
  writeFileSync(lock, JSON.stringify(record('T', 0)));
  const observed: (string | undefined)[] = [];
  let restored = 0;
  await withFileLock(lock, { hooks: {
    // Before the waiter acts on T, T is gone and another lock with the very same renewedAt took its place.
    observed: (r) => { observed.push(r?.token); if (observed.length === 1) writeFileSync(lock, JSON.stringify(record('U', 0))); },
    restored: () => void restored++,
  } }, async () => undefined);
  assert.equal(restored, 1, 'U was renamed by mistake and put back');
  assert.deepEqual(observed, ['T', 'U'], 'and then observed and taken over on its own staleness');
});

test('a put-back never replaces a lock created in the vacancy: it is dropped instead, and nothing is left behind', async (t) => {
  const { dir, lock } = fixture(t);
  writeFileSync(lock, JSON.stringify(record('T', 0)));
  let once = false;
  await assert.rejects(withFileLock(lock, { waitMs: 30, hooks: {
    observed: () => { if (!once) writeFileSync(lock, JSON.stringify(record('U', Date.now()))); }, // T replaced by a live U
    renamed: () => { if (!once) { once = true; writeFileSync(lock, JSON.stringify(record('V', Date.now()))); } }, // V created while U is renamed away
  } }, async () => 'never'), (err: FileLockError) => err.code === 'timeout');
  assert.equal(tokenOf(lock), 'V', 'the lock created in the vacancy is untouched');
  assert.deepEqual(leftovers(dir), ['harness-profiles.json.lock'], 'U\'s renamed copy is gone (EEXIST counts as done)');
});

test('a release that renamed someone else\'s lock puts it back, and drops it when the path was taken meanwhile', async (t) => {
  const { dir, lock } = fixture(t);
  // Between the release's read and its rename, its lock was replaced by a foreign one; with `third`, another lock is created in the vacancy.
  const swapThenRename = (third: boolean) => (from: string, to: string) => {
    if (from === lock && to.includes('.release.')) writeFileSync(lock, JSON.stringify(record('foreign', Date.now())));
    renameSync(from, to);
    if (third && from === lock) writeFileSync(lock, JSON.stringify(record('third', Date.now())));
  };
  await withFileLock(lock, { fs: { rename: swapThenRename(false) } }, async () => undefined);
  assert.equal(tokenOf(lock), 'foreign', 'put back');
  assert.deepEqual(leftovers(dir), ['harness-profiles.json.lock']);
  unlinkSync(lock);
  await withFileLock(lock, { fs: { rename: swapThenRename(true) } }, async () => undefined);
  assert.equal(tokenOf(lock), 'third', 'not replaced by the put-back');
  assert.deepEqual(leftovers(dir), ['harness-profiles.json.lock']);
});

test('a release that finds someone else\'s lock does not even move it', async (t) => {
  const { lock } = fixture(t);
  const renamed: string[] = [];
  await withFileLock(lock, { fs: { rename: (from, to) => { renamed.push(from); renameSync(from, to); } } }, async () => {
    unlinkSync(lock);
    writeFileSync(lock, JSON.stringify(record('successor', Date.now())));
  });
  assert.deepEqual(renamed, [], 'no rename of the successor\'s lock, which would leave its path empty for a moment');
  assert.equal(tokenOf(lock), 'successor');
});

test('renewal writes only into our own lock, the whole record, and pauses once the lock is missing until it is read as ours again', (t) => {
  const { lock } = fixture(t);
  writeFileSync(lock, JSON.stringify(record('other', 5)));
  assert.equal(new Lease(lock, 'mine', undefined, () => 99).renew(), false);
  assert.equal(renewedAtOf(lock), 5, 'someone else\'s lock is not renewed');
  // A longer record than the renewal writes: nothing of it may survive past the new text.
  writeFileSync(lock, JSON.stringify(record('mine', 12345678901234567)));
  const lease = new Lease(lock, 'mine', undefined, () => 5);
  assert.equal(lease.renew(), true);
  assert.equal(renewedAtOf(lock), 5, 'the record was rewritten whole');
  unlinkSync(lock);
  assert.equal(lease.renew(), false, 'missing');
  writeFileSync(lock, JSON.stringify(record('mine', 1)));
  assert.equal(lease.renew(), false, 'renewals pause once the lock went missing');
  assert.equal(renewedAtOf(lock), 1);
  assert.equal(lease.held(), true, 'read as ours again');
  assert.equal(lease.renew(), true, 'and renewals resume');
  assert.equal(renewedAtOf(lock), 5);
});

test('held() reads the file: a missing or unreadable lock is not held, and a lock briefly renamed away is ours again once it is back', async (t) => {
  const { lock } = fixture(t);
  assert.equal(new Lease(lock, 'mine').held(), false, 'missing');
  writeFileSync(lock, JSON.stringify(record('mine', 1)));
  assert.equal(new Lease(lock, 'mine', unreadable).held(), false, 'unreadable');
  assert.throws(() => new Lease(lock, 'mine', unreadable).verify(), (err: FileLockError) => err.code === 'lost' && /could not be confirmed/.test(err.message));
  assert.throws(() => new Lease(lock, 'theirs').verify(), (err: FileLockError) => err.code === 'lost' && /took over/.test(err.message));
  unlinkSync(lock);
  await withFileLock(lock, {}, async (lease) => {
    // A waiter acting on an old observation renames the live lock away and, finding it fresh, puts it back.
    const aside = lock + '.stale.waiter';
    renameSync(lock, aside);
    assert.equal(lease.renew(), false);
    assert.equal(lease.held(), false);
    linkSync(aside, lock);
    unlinkSync(aside);
    lease.verify(); // not refused as "taken over": it is ours again
    assert.equal(lease.renew(), true);
  });
  assert.equal(existsSync(lock), false);
});

test('ENOENT, EBUSY and EACCES while creating the lock are contention, retried within the wait', async (t) => {
  const { lock } = fixture(t);
  const errors = ['ENOENT', 'EBUSY', 'EACCES'];
  let attempts = 0;
  const result = await withFileLock(lock, { sleep: async () => undefined, fs: { openExclusive: (p) => { attempts++; const next = errors.shift(); if (next) throw fail(next); return openSync(p, 'wx', 0o600); } } }, async () => 'held');
  assert.equal(result, 'held');
  assert.equal(attempts, 4);
});

test('a missing or unwritable folder is its own error, not "another process holds the lock"', async (t) => {
  const { dir } = fixture(t);
  const started = Date.now();
  await assert.rejects(withFileLock(path.join(dir, 'missing', 'x.lock'), { waitMs: 5000 }, async () => 'never'), (err: FileLockError) => err.code === 'unavailable' && /can't be created \(ENOENT\)/.test(err.message));
  assert.ok(Date.now() - started < 2000, 'reported at once, not after the wait');
  const denied = { waitMs: 20, sleep: async () => undefined, fs: { openExclusive: (): number => { throw fail('EACCES'); } } };
  await assert.rejects(withFileLock(path.join(dir, 'x.lock'), denied, async () => 'never'), (err: FileLockError) => err.code === 'unavailable' && /EACCES/.test(err.message));
  await assert.rejects(new HarnessProfiles(dir, denied).save('/repo', '', 'global', {}, 0), status(503, /can't be created \(EACCES\)/));
});

test('a lock whose record could not be written is removed, not left to block everyone', async (t) => {
  const { lock } = fixture(t);
  await assert.rejects(withFileLock(lock, { fs: { writeRecord: () => { throw fail('ENOSPC'); } } }, async () => 'never'), /ENOSPC/);
  assert.equal(existsSync(lock), false);
});

test('the holder renews on a timer that never keeps the process alive, and the timer stops at release', async (t) => {
  const { lock } = fixture(t);
  let opened = 0;
  await withFileLock(lock, { renewMs: 10, fs: { openExisting: (p) => { opened++; return openSync(p, 'r+'); } } }, async (lease) => {
    assert.equal((lease as unknown as { timer: NodeJS.Timeout }).timer.hasRef(), false, 'unref\'d');
    const first = JSON.parse(readFileSync(lock, 'utf8')) as LockRecord;
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(renewedAtOf(lock) > first.acquiredAt, 'renewed by the timer while held');
  });
  const afterRelease = opened;
  assert.ok(afterRelease > 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(opened, afterRelease, 'no renewal after release');
});

test('a waiter whose put-back would come after the holder finished finds nothing to put back: no lock is resurrected', async (t) => {
  const { dir, lock } = fixture(t);
  writeFileSync(lock, JSON.stringify(record('dead', 0)));
  const observed = gate(), acquired = gate(), renamed = gate(), released = gate();
  const waiter = withFileLock(lock, { waitMs: 2000, hooks: {
    observed: async (r) => { if (r?.token === 'dead') { observed.open(); await acquired.opened; } },
    renamed: async () => { renamed.open(); await released.opened; },
  } }, async () => 'waiter held it');
  await observed.opened;
  // The holder takes the stale lock over, works while the waiter renames its fresh lock away, and finishes.
  assert.equal(await withFileLock(lock, {}, async () => { acquired.open(); await renamed.opened; return 'holder done'; }), 'holder done');
  released.open();
  assert.equal(await waiter, 'waiter held it', 'the waiter got the lock after the holder, not a dead lock');
  assert.equal(existsSync(lock), false, 'no lock left behind for a holder that is gone');
  assert.deepEqual(leftovers(dir), []);
  const started = Date.now();
  assert.equal(await withFileLock(lock, { waitMs: 1500 }, async () => 'fresh'), 'fresh');
  assert.ok(Date.now() - started < 500, 'a new save is not blocked');
});

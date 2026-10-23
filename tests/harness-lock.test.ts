// The save lock's ownership protocol (src/server/harness/lock.ts), interleaved deterministically through
// its hooks, clock and file system seams: two waiters on one stale lock, a live holder older than the
// stale age, a holder whose lock was taken over, and Windows' delete-pending EPERM. The two-process
// stress run is in tests/harness-cascade.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessProfiles } from '../src/server/harness/profiles.js';
import { FileLockError, withFileLock, type LockRecord } from '../src/server/harness/lock.js';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-lock-'));
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
const status = (code: number, message: RegExp) => (err: Error & { status: number }) => err.status === code && message.test(err.message);
/** The lock's leftovers (`.stale.`, `.release.`) must never remain; the lock itself is gone when nobody holds it. */
const leftovers = (dir: string) => readdirSync(dir).filter((f) => f.includes('.lock'));

test('two waiters that both found the lock stale: one takes it over, the other finds the fresh lock, puts it back and waits for it', async (t) => {
  const { dir, lock } = fixture(t);
  writeFileSync(lock, JSON.stringify(record('dead', 0)));
  const bothObserved = gate(), aInWork = gate(), bRestored = gate();
  let observed = 0;
  const seen: string[] = [];
  const a = new HarnessProfiles(dir, { hooks: { observed: async (r) => { seen.push('a:' + r?.token); if (++observed === 2) bothObserved.open(); await bothObserved.opened; } } });
  const b = new HarnessProfiles(dir, {
    hooks: {
      observed: async (r) => {
        seen.push('b:' + r?.token);
        if (r?.token !== 'dead') return; // the second look: A's fresh lock, which is waited for
        if (++observed === 2) bothObserved.open();
        await bothObserved.opened;
        await aInWork.opened; // B acts on its stale observation only after A has taken over and holds a fresh lock
      },
      restored: () => bRestored.open(),
    },
  });
  // A's write waits (in its recheck, under the lock) until B has renamed A's lock away and put it back: the fencing check must still find A's token.
  const saveA = a.save('/repo', '', 'global', { a: { value: 1 } }, 0, 'a', () => { aInWork.open(); return bRestored.opened; });
  const saveB = b.save('/repo', '', 'repository', { b: { value: 2 } }, 1, 'b');
  const [resultA, resultB] = await Promise.all([saveA, saveB]);
  assert.equal(resultA.revision, 1);
  assert.equal(resultB.revision, 2);
  assert.deepEqual(seen.slice(0, 2).sort(), ['a:dead', 'b:dead'], 'both waiters observed the stale lock');
  assert.ok(seen.slice(2).every((s) => s.startsWith('b:') && s !== 'b:dead'), `B's later looks saw A's fresh lock, never the stale one again: ${seen}`);
  const final = new HarnessProfiles(dir).view('/repo');
  assert.deepEqual([final.layers.global, final.layers.repository], [{ a: { value: 1 } }, { b: { value: 2 } }], 'neither accepted save was lost');
  assert.deepEqual(leftovers(dir), []);
});

test('a live holder older than the stale age keeps the lock: its renewals make it fresh, and a waiter times out instead of taking it over', async (t) => {
  const { dir, lock } = fixture(t);
  let clock = 1_000_000;
  const now = () => clock;
  const observedTokens: (string | undefined)[] = [];
  const waiter = new HarnessProfiles(dir, { now, waitMs: 200, staleMs: 10_000, sleep: async (ms) => { clock += ms; }, hooks: { observed: (r) => void observedTokens.push(r?.token) } });
  const result = await withFileLock(lock, { now, staleMs: 10_000, renewMs: 2_000_000_000 }, async (lease) => {
    clock += 9_000;
    assert.equal(lease.renew(), true, 'the holder renews its lease while working');
    clock += 6_000; // 15 s since the lock was created, 6 s since it was renewed: not stale
    await assert.rejects(waiter.save('/repo', '', 'global', { w: { value: 1 } }, 0), status(503, /Another office is saving/));
    assert.ok(observedTokens.length > 0 && observedTokens.every((tk) => tk === lease.token), 'the waiter saw the holder\'s lock every time and left it');
    assert.equal(tokenOf(lock), lease.token, 'the lock is still the holder\'s');
    lease.verify();
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.equal(existsSync(lock), false, 'released');
  assert.equal((await waiter.save('/repo', '', 'global', { w: { value: 1 } }, 0)).revision, 1, 'the waiter gets the lock once it is released');
  assert.deepEqual(leftovers(dir), []);
});

test('a holder whose lock was taken over cannot commit, and its release never deletes the lock that replaced it', async (t) => {
  const { dir, lock } = fixture(t);
  const store = new HarnessProfiles(dir);
  await store.save('/repo', '', 'global', { before: { value: 1 } }, 0);
  const takeOver = () => {
    // Another process found the lock stale: renamed it away, removed it, created its own.
    const gone = lock + '.stale.elsewhere';
    renameSync(lock, gone);
    unlinkSync(gone);
    writeFileSync(lock, JSON.stringify(record('other', Date.now())));
  };
  await assert.rejects(store.save('/repo', '', 'global', { lost: { value: 1 } }, 1, '', takeOver), status(503, /took over the save lock/));
  assert.equal(tokenOf(lock), 'other', 'the successor\'s lock is untouched by the loser\'s release');
  assert.deepEqual(store.view('/repo').layers.global, { before: { value: 1 } }, 'nothing was written');
  assert.equal(store.view('/repo').revision, 1);
  unlinkSync(lock);
  assert.equal((await store.save('/repo', '', 'global', { after: { value: 1 } }, 1)).revision, 2);
  assert.deepEqual(leftovers(dir), []);
});

test('EPERM on a delete-pending lock and a lock that vanishes under a reader are contention, retried within the wait', async (t) => {
  const { dir, lock } = fixture(t);
  const failures = { EPERM: 3, EEXIST: 1, ENOENT: 1 };
  let slept = 0;
  const fail = (code: keyof typeof failures) => { const err = new Error(code) as NodeJS.ErrnoException; err.code = code; return err; };
  const store = new HarnessProfiles(dir, {
    sleep: async () => { slept++; },
    fs: {
      openExclusive: (p) => {
        if (failures.EPERM-- > 0) throw fail('EPERM');
        if (failures.EEXIST-- > 0) throw fail('EEXIST');
        return openSync(p, 'wx', 0o600);
      },
      read: (p) => { if (failures.ENOENT-- > 0) throw fail('ENOENT'); return readFileSync(p, 'utf8'); },
    },
  });
  assert.equal((await store.save('/repo', '', 'global', { x: { value: 1 } }, 0)).revision, 1);
  assert.equal(slept, 4, 'three EPERMs and one EEXIST (whose lock vanished before it could be read) were each waited out');
  assert.equal(existsSync(lock), false);
  // An error that is not contention still escapes, so a broken disk is never mistaken for a busy office.
  const broken = new HarnessProfiles(dir, { fs: { openExclusive: () => { throw fail('ENOSPC' as never); } } });
  await assert.rejects(broken.save('/repo', '', 'global', {}, 1), /ENOSPC/);
  // The lock's own errors are typed: out of wait is a timeout, not a raw error.
  writeFileSync(lock, JSON.stringify(record('busy', Date.now())));
  await assert.rejects(withFileLock(lock, { waitMs: 50 }, async () => 'never'), (err: FileLockError) => err instanceof FileLockError && err.code === 'timeout');
  unlinkSync(lock);
});

test('a lock renewed after a waiter saw it stale is put back, and a release that finds a foreign lock leaves it alone', async (t) => {
  const { dir, lock } = fixture(t);
  // The waiter observed token T renewed at 0; before it renames, the holder (stalled, then alive) renews it.
  writeFileSync(lock, JSON.stringify(record('T', 0)));
  await assert.rejects(withFileLock(lock, { waitMs: 30, hooks: { observed: () => writeFileSync(lock, JSON.stringify(record('T', Date.now()))) } }, async () => 'never'), (err: FileLockError) => err.code === 'timeout');
  assert.equal(tokenOf(lock), 'T', 'the renewed lock is back in place, not removed');
  assert.deepEqual(leftovers(dir), ['harness-profiles.json.lock']);
  unlinkSync(lock);
  // A holder whose lock was replaced and who never called verify: its release must not touch the successor's lock.
  await withFileLock(lock, {}, async () => { unlinkSync(lock); writeFileSync(lock, JSON.stringify(record('successor', Date.now()))); });
  assert.equal(tokenOf(lock), 'successor');
  assert.deepEqual(leftovers(dir), ['harness-profiles.json.lock']);
});

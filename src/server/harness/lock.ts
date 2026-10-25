// A lock between processes on one machine, as a file next to the thing it guards (the harness profiles
// store; the element registry may reuse it). It is an optimisation, not the guarantee: it serialises
// honest writers and keeps their waits short. Mutual exclusion is best effort, because no file system
// call makes "check that this is the lock I saw, then replace it" one step. What prevents lost updates
// is the store's commit (commit.ts): each revision is published with an exclusive create, so a writer
// that lost the lock, or never really had it alone, fails its commit with a revision conflict instead
// of overwriting. The protocol, and why each step is there:
//
// - The lock is a file created with O_EXCL (`wx`) holding `{token, pid, acquiredAt, renewedAt}`. The
//   token is the holder's identity; a pid or a pathname is not (a pathname names whatever is there now).
// - A holder renews `renewedAt` on a timer while it holds the lock (a lease), so a live holder that is
//   slow is never stale: a lock is stale only when nobody has renewed it for `staleMs`.
// - A waiter takes over a stale lock by renaming the lock it *observed* to a name of its own and then
//   reading the renamed file back: only when it still carries the observed token and renewal time was
//   it the stale lock, and the waiter removes it. Otherwise it renamed a lock someone created or renewed
//   in between and puts it back (`link`, which never replaces a file the way `rename` does on Windows).
//   While it is renamed away the path is empty, and a third process may create a lock there; then the
//   put-back finds the path taken and the displaced lock is dropped (its holder's `verify()` refuses).
// - A holder that finds its lock missing (renewing, checking or releasing) does not conclude it was
//   taken over: a waiter may have it renamed away for a moment. `held()` reads the file again every
//   time. A release that finds its lock missing removes any copy of it a waiter or a release has
//   renamed aside (`<lock>.stale.*`, `<lock>.release.*`) and looks at the path once more, so a put-back
//   that comes after the holder finished finds nothing to put back, and one that came before is released.
// - A release renames the holder's own lock away and verifies the token the same way before unlinking,
//   so a holder whose lock was taken over never deletes its successor's lock.
// - `Lease.verify()` re-reads the lock and throws unless it carries the holder's token. Callers call it
//   right before they publish (commit.ts does, through its `fence`).
// - EEXIST, EPERM, EBUSY, ENOENT and EACCES while creating the lock are contention (Windows keeps a
//   deleted file's name for a moment while someone still has it open; a lock can vanish between a stat
//   and a read): retried within the bounded wait. Running out of wait is a `FileLockError` with `code:
//   'timeout'`; a directory that is missing, or that can't be written at all, is `code: 'unavailable'`.
//
// Time, sleeping and the file system calls are injectable, so tests can interleave waiters
// deterministically and fail single calls, without patching the module.
import { closeSync, ftruncateSync, linkSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import nodePath from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LockRecord { token: string; pid: number; acquiredAt: number; renewedAt: number }
export interface LockFs {
  openExclusive(path: string): number;
  openExisting(path: string): number;
  /** Writes the new lock's record through the descriptor `openExclusive` returned. */
  writeRecord(fd: number, text: string): void;
  read(path: string): string;
  mtimeMs(path: string): number;
  rename(from: string, to: string): void;
  link(from: string, to: string): void;
  unlink(path: string): void;
  /** The names in a directory. */
  list(dir: string): string[];
  /** Whether a directory is there. */
  dirExists(dir: string): boolean;
}
export interface LockHooks {
  /** A waiter read an existing lock (parsed when it was one of ours) and is about to decide whether it is stale. */
  observed?(record: LockRecord | undefined, raw: string): Promise<void> | void;
  /** A waiter renamed what it took for a stale lock and is about to read it back. */
  renamed?(): Promise<void> | void;
  /** A waiter found it had renamed a fresh lock and has put it back (or found the path taken). */
  restored?(): Promise<void> | void;
  /** The holder's `verify()` passed right before it publishes (commit.ts): tests stall here. Not called by this module. */
  verified?(): void;
}
export interface LockOptions {
  /** How long to wait for a holder before giving up (ms). */
  waitMs?: number;
  /** A lock nobody renewed for this long is a crashed holder's (ms); the renewal interval is a quarter of it. */
  staleMs?: number;
  renewMs?: number;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  fs?: Partial<LockFs>;
  hooks?: LockHooks;
}
export class FileLockError extends Error {
  constructor(message: string, readonly code: 'timeout' | 'lost' | 'unavailable') { super(message); }
}

const realFs: LockFs = {
  openExclusive: (p) => openSync(p, 'wx', 0o600),
  openExisting: (p) => openSync(p, 'r+'),
  writeRecord: (fd, text) => writeFileSync(fd, text),
  read: (p) => readFileSync(p, 'utf8'),
  mtimeMs: (p) => statSync(p).mtimeMs,
  rename: renameSync,
  link: linkSync,
  unlink: unlinkSync,
  list: (dir) => readdirSync(dir),
  dirExists: (dir) => { try { return statSync(dir).isDirectory(); } catch { return false; } },
};
const code = (err: unknown) => (err as NodeJS.ErrnoException).code;
const CONTENTION = new Set(['EEXIST', 'EPERM', 'EBUSY', 'ENOENT', 'EACCES']);
/** Errors creating a file that, when they last the whole wait, may mean the directory itself is the problem. */
const UNWRITABLE = new Set(['EPERM', 'ENOENT', 'EACCES']);
function parse(raw: string): LockRecord | undefined {
  try {
    const data = JSON.parse(raw) as LockRecord;
    return data && typeof data.token === 'string' && Number.isFinite(data.renewedAt) ? data : undefined;
  } catch { return undefined; }
}
type Found = 'mine' | 'foreign' | 'missing' | 'unreadable';

/** The lock while held: the holder's token, renewal, and the ownership check before a commit. */
export class Lease {
  /** Set when a renewal found the lock missing or foreign: renewals pause until `held()` reads it as ours again. */
  private lost = false;
  private timer: NodeJS.Timeout | undefined;
  constructor(readonly path: string, readonly token: string, private fs: LockFs = realFs, private now: () => number = Date.now) {}
  /** Writes `renewedAt` into the lock when it is still ours; pauses renewals when it is missing or someone else's. */
  renew(): boolean {
    if (this.lost) return false;
    let fd: number | undefined;
    try {
      // Opened for writing only (no create), and the token is read through that very descriptor: what is
      // written to is the file that was checked, never a foreign lock created at the path in between.
      fd = this.fs.openExisting(this.path);
      const current = parse(readFileSync(fd, 'utf8'));
      if (current?.token !== this.token) { this.lost = true; return false; }
      const text = JSON.stringify({ ...current, renewedAt: this.now() } satisfies LockRecord);
      ftruncateSync(fd, 0);
      writeSync(fd, text, 0);
      return true;
    } catch (err) {
      if (code(err) === 'ENOENT') this.lost = true; // a transient EPERM/EBUSY is only a missed renewal
      return false;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  /** What is at `file` now: our lock, someone else's, nothing, or something that can't be read after a few tries. */
  private find(file: string): Found {
    let found: Found = 'unreadable';
    for (let attempt = 0; attempt < 5; attempt++) {
      try { return parse(this.fs.read(file))?.token === this.token ? 'mine' : 'foreign'; }
      catch (err) { if (code(err) === 'ENOENT') found = 'missing'; }
    }
    return found;
  }
  private check(): Found {
    const found = this.find(this.path);
    if (found === 'mine') this.lost = false; // read as ours again: renewals resume
    return found;
  }
  /** Whether the lock carries our token now, read from the file every time (a lock briefly renamed away by a waiter is ours again once it is back). */
  held(): boolean {
    return this.check() === 'mine';
  }
  /** Throws unless the lock is ours now: call it right before publishing what the lock protects. */
  verify(): void {
    const found = this.check();
    if (found === 'mine') return;
    throw new FileLockError(found === 'foreign'
      ? 'Another office took over the save lock while this save waited; nothing was written. Try again.'
      : 'The save lock could not be confirmed as this save\'s (another office may be checking it); nothing was written. Try again.', 'lost');
  }
  start(renewMs: number) {
    this.timer = setInterval(() => void this.renew(), renewMs);
    this.timer.unref();
  }
  /** Removes copies of our lock that a waiter or a release renamed aside, so none of them is put back after we finished. */
  private sweep() {
    const dir = nodePath.dirname(this.path), base = nodePath.basename(this.path);
    let names: string[];
    try { names = this.fs.list(dir); } catch { return; }
    for (const name of names) {
      if (!name.startsWith(base + '.stale.') && !name.startsWith(base + '.release.')) continue;
      const file = nodePath.join(dir, name);
      try { if (parse(this.fs.read(file))?.token === this.token) this.fs.unlink(file); } catch { /* gone, or not readable: not provably ours */ }
    }
  }
  /** Removes our lock, and only ours: renamed away first, read back, then unlinked when it carries our token. */
  release() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (let round = 0; round < 2; round++) {
      const found = this.find(this.path);
      if (found === 'foreign' || found === 'unreadable') return; // someone else's: never ours to remove, not even to move
      // Missing: a waiter may have it renamed aside and be about to put it back. Remove that copy, then look again.
      if (found === 'missing') { this.sweep(); continue; }
      const mine = this.path + '.release.' + this.token;
      let moved = false;
      for (let attempt = 0; attempt < 5 && !moved; attempt++) {
        try { this.fs.rename(this.path, mine); moved = true; } catch (err) { if (code(err) === 'ENOENT') break; }
      }
      if (!moved) { this.sweep(); continue; }
      try {
        if (parse(this.fs.read(mine))?.token === this.token) { this.fs.unlink(mine); return; }
        // Someone else's lock came in between: put it back without replacing anything, or drop it when the path is taken.
        try { this.fs.link(mine, this.path); } catch { /* taken, or its holder finished and removed this copy */ }
        this.fs.unlink(mine);
      } catch { /* the renamed file is gone */ }
      return;
    }
  }
}

/**
 * Runs `work` holding the lock at `path`, created exclusively, waited for while fresh, taken over when
 * stale. `work` gets the lease and must call `lease.verify()` right before it publishes.
 */
export async function withFileLock<T>(path: string, options: LockOptions, work: (lease: Lease) => Promise<T>): Promise<T> {
  const fs = { ...realFs, ...options.fs };
  const now = options.now ?? Date.now;
  const pause = options.sleep ?? ((ms: number) => sleep(ms));
  const waitMs = options.waitMs ?? 3000, staleMs = options.staleMs ?? 10_000, renewMs = options.renewMs ?? Math.max(50, Math.floor(staleMs / 4));
  const hooks = options.hooks ?? {};
  const token = randomUUID();
  const until = now() + waitMs;
  for (;;) {
    let fd: number | undefined;
    try { fd = fs.openExclusive(path); }
    catch (err) {
      const why = code(err) ?? '';
      if (!CONTENTION.has(why)) throw err;
      if (why === 'ENOENT' && !fs.dirExists(nodePath.dirname(path))) throw unavailable(path, why);
      if (why === 'EEXIST') await takeOverIfStale(path, fs, now, staleMs, hooks);
      if (now() > until) {
        if (UNWRITABLE.has(why) && !writable(path, fs)) throw unavailable(path, why);
        throw new FileLockError('Another process holds the lock. Try again in a moment.', 'timeout');
      }
      await pause(5 + Math.random() * 20);
      continue;
    }
    const at = now();
    const lease = new Lease(path, token, fs, now);
    try { fs.writeRecord(fd, JSON.stringify({ token, pid: process.pid, acquiredAt: at, renewedAt: at } satisfies LockRecord)); }
    catch (err) { try { closeSync(fd); fd = undefined; fs.unlink(path); } catch { /* left to go stale */ } throw err; }
    finally { if (fd !== undefined) closeSync(fd); }
    lease.start(renewMs);
    try { return await work(lease); }
    finally { lease.release(); }
  }
}

function unavailable(path: string, why: string) {
  return new FileLockError(`The lock file ${path} can't be created (${why}): check that its folder exists and can be written.`, 'unavailable');
}
/** Whether a file of our own can be created next to the lock right now (the lock's own errors may have been contention). */
function writable(path: string, fs: LockFs) {
  const probe = path + '.probe.' + randomUUID();
  try { closeSync(fs.openExclusive(probe)); } catch { return false; }
  try { fs.unlink(probe); } catch { /* left behind: harmless */ }
  return true;
}

/** Reads the lock someone else holds and, when nobody renewed it for `staleMs`, removes that very file. */
async function takeOverIfStale(path: string, fs: LockFs, now: () => number, staleMs: number, hooks: LockHooks) {
  let raw: string, mtime: number;
  try { raw = fs.read(path); mtime = fs.mtimeMs(path); } catch { return; } // gone, or not readable yet: contention
  const record = parse(raw);
  await hooks.observed?.(record, raw);
  // A lock of ours says when it was renewed; anything else (an older office's pid file) only has its mtime.
  const stale = record ? now() - record.renewedAt > staleMs : now() - mtime > staleMs;
  if (!stale) return;
  const gone = path + '.stale.' + randomUUID();
  try { fs.rename(path, gone); } catch { return; } // someone else took it over, or it was released
  await hooks.renamed?.();
  let same = false;
  try {
    const renamed = fs.read(gone);
    // The very lock we observed: the same token and not renewed since (a holder that stalled and then renewed is alive).
    const now = parse(renamed);
    same = record ? now?.token === record.token && now.renewedAt === record.renewedAt : renamed === raw;
  } catch { /* unreadable, or removed by its holder's release: not proven to be the stale one */ }
  if (same) { try { fs.unlink(gone); } catch { /* already gone */ } return; }
  // Not the lock we observed: a fresh or renewed holder's. Put it back without replacing anything. When the path
  // is taken again it is dropped (its holder's verify() refuses); when its holder already finished, the holder's
  // release has removed this copy (Lease.sweep) and there is nothing to put back.
  let restored = false;
  try { fs.link(gone, path); restored = true; } catch (err) { restored = code(err) === 'EEXIST'; }
  if (restored) { try { fs.unlink(gone); } catch { /* already gone */ } }
  await hooks.restored?.();
}

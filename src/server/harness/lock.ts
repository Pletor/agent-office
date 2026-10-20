// An exclusive lock between processes on one machine, as a file next to the thing it guards (the
// harness profiles store; the element registry may reuse it). The protocol, and why each step is there:
//
// - The lock is a file created with O_EXCL (`wx`) holding `{token, pid, acquiredAt, renewedAt}`. The
//   token is the holder's identity; a pid or a pathname is not (a pathname names whatever is there now).
// - A holder renews `renewedAt` on a timer while it holds the lock (a lease), so a live holder that is
//   slow is never stale: a lock is stale only when nobody has renewed it for `staleMs`.
// - A waiter takes over a stale lock by renaming the lock it *observed* to a name of its own and then
//   reading the renamed file back: only when it still carries the observed token was it the stale lock,
//   and the waiter removes it. Otherwise it renamed a fresh lock someone created in between and puts it
//   back (`link`, which never replaces a file the way `rename` does on Windows), or if the path is taken
//   again by then, leaves it to the fencing below: the holder whose lock went missing cannot commit.
// - A release renames the holder's own lock away and verifies the token the same way before unlinking,
//   so a holder whose lock was taken over never deletes its successor's lock.
// - Fencing: `Lease.verify()` re-reads the lock right before the protected write and throws when the
//   lock no longer carries the holder's token (taken over, or lost in a renewal). The caller re-checks
//   its own revision under the lock as well (read-check-write happens inside `work`).
// - EPERM, EBUSY and ENOENT while acquiring are contention (Windows keeps a deleted file's name for a
//   moment while someone still has it open; a lock can vanish between a stat and a read): retried within
//   the bounded wait. Running out of wait is a `FileLockError` with `code: 'timeout'`.
//
// Time, sleeping and the file system calls are injectable, so tests can interleave two waiters
// deterministically and fail single calls, without patching the module.
import { closeSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync, ftruncateSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LockRecord { token: string; pid: number; acquiredAt: number; renewedAt: number }
export interface LockFs {
  openExclusive(path: string): number;
  openExisting(path: string): number;
  read(path: string): string;
  mtimeMs(path: string): number;
  rename(from: string, to: string): void;
  link(from: string, to: string): void;
  unlink(path: string): void;
}
export interface LockHooks {
  /** A waiter read an existing lock (parsed when it was one of ours) and is about to decide whether it is stale. */
  observed?(record: LockRecord | undefined, raw: string): Promise<void> | void;
  /** A waiter renamed what it took for a stale lock and is about to read it back. */
  renamed?(): Promise<void> | void;
  /** A waiter found it had renamed a fresh lock and has put it back (or found the path taken). */
  restored?(): Promise<void> | void;
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
  constructor(message: string, readonly code: 'timeout' | 'lost') { super(message); }
}

const realFs: LockFs = {
  openExclusive: (p) => openSync(p, 'wx', 0o600),
  openExisting: (p) => openSync(p, 'r+'),
  read: (p) => readFileSync(p, 'utf8'),
  mtimeMs: (p) => statSync(p).mtimeMs,
  rename: renameSync,
  link: linkSync,
  unlink: unlinkSync,
};
const code = (err: unknown) => (err as NodeJS.ErrnoException).code;
const CONTENTION = new Set(['EEXIST', 'EPERM', 'EBUSY', 'ENOENT', 'EACCES']);
function parse(raw: string): LockRecord | undefined {
  try {
    const data = JSON.parse(raw) as LockRecord;
    return data && typeof data.token === 'string' && Number.isFinite(data.renewedAt) ? data : undefined;
  } catch { return undefined; }
}

/** The lock while held: the holder's token, renewal, and the ownership check before a commit. */
export class Lease {
  private lost = false;
  private timer: NodeJS.Timeout | undefined;
  constructor(readonly path: string, readonly token: string, private fs: LockFs, private now: () => number) {}
  /** Writes `renewedAt` into the lock when it is still ours; marks the lease lost when it is not. */
  renew(): boolean {
    if (this.lost) return false;
    let fd: number | undefined;
    try {
      const current = parse(this.fs.read(this.path));
      if (current?.token !== this.token) { this.lost = true; return false; }
      // Opened for writing only (no create): a lock renamed away in between is ENOENT, never a new file at the path.
      fd = this.fs.openExisting(this.path);
      const text = JSON.stringify({ ...current, renewedAt: this.now() } satisfies LockRecord);
      ftruncateSync(fd, 0);
      writeSync(fd, text, 0);
      return true;
    } catch (err) {
      if (code(err) === 'ENOENT') this.lost = true;
      return false;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  /** Whether the lock still carries our token; false once it was taken over. */
  held(): boolean {
    if (this.lost) return false;
    try { if (parse(this.fs.read(this.path))?.token === this.token) return true; } catch { /* gone */ }
    this.lost = true;
    return false;
  }
  /** Throws unless the lock is still ours: call it right before the write the lock protects. */
  verify(): void {
    if (!this.held()) throw new FileLockError('The lock was taken over while this save waited; nothing was written.', 'lost');
  }
  start(renewMs: number) {
    this.timer = setInterval(() => void this.renew(), renewMs);
    this.timer.unref();
  }
  /** Removes our lock, and only ours: renamed away first, read back, then unlinked when it carries our token. */
  release() {
    if (this.timer) clearInterval(this.timer);
    if (this.lost) return;
    let raw: string;
    try { raw = this.fs.read(this.path); } catch { return; }
    if (parse(raw)?.token !== this.token) return;
    const mine = this.path + '.release.' + this.token;
    try { this.fs.rename(this.path, mine); } catch { return; }
    try {
      if (parse(this.fs.read(mine))?.token === this.token) { this.fs.unlink(mine); return; }
      // Someone else's lock came in between: put it back, or leave it for its holder's fencing when the path is taken.
      try { this.fs.link(mine, this.path); } catch { /* taken */ }
      this.fs.unlink(mine);
    } catch { /* the renamed file is gone */ }
  }
}

/**
 * Runs `work` holding the lock at `path`, created exclusively, waited for while fresh, taken over when
 * stale. `work` gets the lease and must call `lease.verify()` right before its write.
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
      if (!CONTENTION.has(code(err) ?? '')) throw err;
      if (code(err) === 'EEXIST') await takeOverIfStale(path, fs, now, staleMs, hooks);
      if (now() > until) throw new FileLockError('Another process holds the lock. Try again in a moment.', 'timeout');
      await pause(5 + Math.random() * 20);
      continue;
    }
    const at = now();
    const lease = new Lease(path, token, fs, now);
    try { writeFileSync(fd, JSON.stringify({ token, pid: process.pid, acquiredAt: at, renewedAt: at } satisfies LockRecord)); }
    finally { closeSync(fd); }
    lease.start(renewMs);
    try { return await work(lease); }
    finally { lease.release(); }
  }
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
  try { fs.rename(path, gone); } catch { return; } // someone else took it over, or created a fresh one
  await hooks.renamed?.();
  let renamed: string;
  try { renamed = fs.read(gone); } catch { return; }
  const same = record ? parse(renamed)?.token === record.token : renamed === raw;
  if (same) { try { fs.unlink(gone); } catch { /* already gone */ } return; }
  // Not the lock we observed: a fresh holder's. Put it back without replacing anything; when the path is taken again, its holder's fencing refuses its write.
  try { fs.link(gone, path); } catch { /* taken */ }
  try { fs.unlink(gone); } catch { /* already gone */ }
  await hooks.restored?.();
}

// A cross-process lock file for the element registry. The lock is a file created with O_EXCL that
// holds its owner's token and a lease timestamp; the owner keeps the file open and renews the lease
// while it holds the lock. A lock whose lease is older than the stale threshold is taken over, but
// only the lock that was observed: it is renamed away (atomic), and the renamed file must carry the
// observed inode and token, else it is put back (never over a newer lock) and the takeover is a miss.
// Release renames the owner's lock away and verifies the same way before unlinking, so a replacement
// lock is never deleted. The holder re-checks the lock before committing (fencing), so a writer whose
// lock was taken over does not overwrite the taker's write.
import { closeSync, fstatSync, ftruncateSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface LockTiming { staleMs: number; tries: number; waitMs: number }
export const LOCK_TIMING: LockTiming = { staleMs: 10_000, tries: 40, waitMs: 25 };
export interface HeldLock {
  /** The lock path still holds this owner's file: the write it guards may be committed. */
  valid(): boolean;
  /** Renew the lease (the holder is alive); done on a timer while held and at the slow steps. */
  renew(): void;
  release(): void;
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const code = (err: unknown) => (err as NodeJS.ErrnoException).code;
/** `<token> <lease timestamp>`; a lock without a parsable timestamp (older format, hand-made) counts by its mtime alone. */
const lease = (content: string) => { const at = Number(content.split(' ')[1]); return Number.isFinite(at) ? at : 0; };
const tokenOf = (content: string) => content.split(' ')[0];
const identity = (file: string) => {
  const stat = statSync(file, { bigint: true });
  return { ino: stat.ino, mtimeMs: Number(stat.mtimeMs), content: readFileSync(file, 'utf8') };
};
/**
 * Move `claimed` back to `lock` without replacing a lock created meanwhile: a hard link fails on an
 * existing path where rename would overwrite it. Where links are unavailable, rename is the fallback.
 */
function restore(claimed: string, lock: string) {
  try { linkSync(claimed, lock); }
  catch (err) { if (code(err) === 'EEXIST') { try { unlinkSync(claimed); } catch { /* gone */ } return; } try { renameSync(claimed, lock); } catch { /* gone */ } return; }
  try { unlinkSync(claimed); } catch { /* gone */ }
}

/** A stale lock at `lock` is claimed: renamed away and removed, when the renamed file is the one that was observed. */
export function claimStale(lock: string, token: string, staleMs: number): boolean {
  let seen: ReturnType<typeof identity>;
  try { seen = identity(lock); } catch { return false; /* gone, or unreadable: leave it */ }
  if (Date.now() - Math.max(lease(seen.content), seen.mtimeMs) <= staleMs) return false;
  const claimed = lock + '.' + token;
  try { renameSync(lock, claimed); } catch { return false; /* raced, or gone */ }
  try {
    const moved = identity(claimed);
    if (moved.ino === seen.ino && moved.content === seen.content) { unlinkSync(claimed); return true; }
  } catch { /* fall through: put back whatever was moved */ }
  restore(claimed, lock);
  return false;
}

/** Take `lock` with bounded asynchronous waiting; undefined when it stays held (or the folder is not writable). */
export async function acquireLock(lock: string, timing: LockTiming = LOCK_TIMING): Promise<HeldLock | undefined> {
  const token = randomUUID();
  for (let attempt = 0; attempt < timing.tries; attempt++) {
    let fd: number;
    try {
      mkdirSync(path.dirname(lock), { recursive: true });
      fd = openSync(lock, 'wx', 0o600);
    } catch (err) {
      if (code(err) !== 'EEXIST') return undefined;
      claimStale(lock, token, timing.staleMs);
      await delay(timing.waitMs);
      continue;
    }
    const stamp = () => { try { ftruncateSync(fd, 0); writeSync(fd, token + ' ' + Date.now(), 0); } catch { /* lease not renewed; the mtime still moves on a later write */ } };
    stamp();
    const ino = fstatSync(fd, { bigint: true }).ino;
    const mine = (file: string) => { try { const now = identity(file); return now.ino === ino && tokenOf(now.content) === token; } catch { return false; } };
    const timer = setInterval(stamp, Math.max(1, Math.floor(timing.staleMs / 4)));
    timer.unref();
    let open = true;
    return {
      valid: () => mine(lock),
      renew: () => { if (open) stamp(); },
      release: () => {
        clearInterval(timer);
        if (open) { open = false; closeSync(fd); }
        if (!mine(lock)) return; // taken over: the lock there is someone else's
        const claimed = lock + '.' + token + '.release';
        try { renameSync(lock, claimed); } catch { return; }
        if (mine(claimed)) { try { unlinkSync(claimed); } catch { /* gone */ } } else restore(claimed, lock);
      },
    };
  }
  return undefined;
}

// 🧹 Uklidit: the exact list of what may be deleted (merged branches, local and on the remote, and
// orphaned worktrees), and deleting what the person confirmed, each item checked again just before.
// Never main, the checked-out branch, a live worker's branch or worktree, or uncommitted work; every
// branch's commit is kept under refs/cleanline-backup/<time>/ first (see docs/cista-linie.md, 2.6).
import { existsSync, lstatSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { CleanupItem, CleanupPlan, CleanupResult } from '../../shared/cleanline.js';
import { samePath, type Runner } from '../status/git.js';
import { IDLE_HOURS, orphanWhy, type LineState, type RefInfo } from './health.js';

const keyOf = (kind: CleanupItem['kind'], name: string, sha?: string) => `${kind}:${name}${sha ? `@${sha}` : ''}`;

/** A branch copy old or finished enough to go: its PR merged, its own commits squashed into main, or long idle. */
const done = (r: RefInfo) => r.pr?.state === 'MERGED' || r.ahead > 0 || r.idleH > IDLE_HOURS;

/** What Uklidit would delete now, and the candidates it leaves alone. */
export function cleanupPlan(s: LineState): CleanupPlan {
  const items: CleanupItem[] = [];
  const kept: CleanupPlan['kept'] = [];
  // Without the remote main nothing can be told merged: every worktree would look orphaned.
  if (!s.mainSha) return { items, kept };
  const remoteName = s.remote.split('/')[0];
  // Never delete on someone else's upstream: with a fork, origin is read-only.
  const remoteRefused = remoteName === 'origin' && !!s.remotes?.includes('fork');
  const protectedPath = (p: string) => s.protect.some((x) => samePath(x, p));
  const goingWts = new Set<string>();
  for (const w of s.worktrees) {
    const why = orphanWhy(w, s);
    if (!why) continue;
    if (protectedPath(w.path)) kept.push({ name: w.path, why: 'chráněná složka (repozitář nebo instalace kanceláře)' });
    else if (w.dirty) kept.push({ name: w.path, why: `neuložené změny (${w.dirty}) — smaže jen vlastník` });
    else if (w.busy) kept.push({ name: w.path, why: 'běží v něm proces' });
    else if ((w.recentH ?? 0) < IDLE_HOURS) kept.push({ name: w.path, why: 'soubory se změnily v posledních 24 h — možná v něm někdo pracuje' });
    else if (!w.headSha) kept.push({ name: w.path, why: 'HEAD nelze přečíst, nelze zazálohovat' });
    else {
      goingWts.add(w.path);
      items.push({ key: keyOf('worktree', w.path, w.headSha), kind: 'worktree', name: w.path, sha: w.headSha, reason: why });
    }
  }
  for (const r of s.refs) {
    if (r.name === s.mainName || r.name === 'HEAD') continue;
    const open = r.pr?.state === 'OPEN';
    if (r.elsewhere) {
      if ((r.local !== undefined && r.localMerged) || (r.remote !== undefined && r.remoteMerged)) kept.push({ name: r.name, why: 'větev stejného jména je i na jiném remote (upstream) — může tam mít otevřený PR' });
      continue;
    }
    if (r.local !== undefined && r.localMerged && done(r)) {
      const holders = s.worktrees.filter((w) => w.branch === r.name);
      const why =
        r.name === s.current ? 'je to větev vybraná v hlavním checkoutu'
        : r.worker ? `pracuje na ní ${r.worker}`
        : open ? `PR #${r.pr!.number} je otevřený`
        : holders.some((w) => !goingWts.has(w.path)) ? `je vybraná ve worktree ${holders.find((w) => !goingWts.has(w.path))!.path}`
        : undefined;
      if (why) kept.push({ name: r.name, why });
      else items.push({ key: keyOf('branch', r.name, r.local), kind: 'branch', name: r.name, sha: r.local, reason: mergedWhy(r) });
    }
    if (r.remote !== undefined && r.remoteMerged && done(r)) {
      const why =
        remoteRefused ? `${remoteName} je cizí upstream (je tu fork): na něm se nemaže`
        : r.name === s.current ? 'je to větev vybraná v hlavním checkoutu'
        : r.worker ? `pracuje na ní ${r.worker}`
        : open ? `PR #${r.pr!.number} je otevřený`
        : r.pr?.state !== 'MERGED' ? `na ${remoteName} se maže jen větev sloučeného PR`
        : undefined;
      if (why) kept.push({ name: `${remoteName}/${r.name}`, why });
      else items.push({ key: keyOf('remote-branch', r.name, r.remote), kind: 'remote-branch', name: r.name, sha: r.remote, reason: mergedWhy(r) });
    }
  }
  return { items, kept };
}

const mergedWhy = (r: RefInfo) => (r.pr?.state === 'MERGED' ? `PR #${r.pr.number} sloučený` : r.ahead > 0 ? 'obsah už je v main (squash)' : `bez commitů mimo main, ${Math.round(r.idleH)} h bez pohybu`);

/** What removing a worktree touches on disk, handed in so a test can stand in for it. */
export interface Disk {
  isLink(p: string): boolean;
  /** Removes the link itself (a junction or symlink), never what it points at. */
  unlink(p: string): void;
  exists(p: string): boolean;
  /** Deletes a folder that git has let go of (never following links). */
  rmTree(p: string): void;
}

export const realDisk: Disk = {
  isLink: (p) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  },
  // unlink takes a symlink; a Windows junction is a directory reparse point, which rmdir (not recursive) takes.
  unlink: (p) => {
    try {
      unlinkSync(p);
    } catch {
      rmdirSync(p);
    }
  },
  exists: existsSync,
  // \\?\ lifts Windows' 260-character limit; rmSync unlinks a junction rather than going into it.
  rmTree: (p) => rmSync(process.platform === 'win32' ? `\\\\?\\${path.resolve(p)}` : p, { recursive: true, force: true }),
};

/**
 * Removes a clean worktree: a junction node_modules first (rmdir takes the link, not what it points
 * at), then `git worktree remove`; when only the long paths stop git, the folder by \\?\ and a prune.
 */
export async function removeWorktree(run: Runner, repo: string, wt: string, disk: Disk = realDisk): Promise<void> {
  const nm = path.join(wt, 'node_modules');
  if (disk.isLink(nm)) disk.unlink(nm);
  try {
    await run('git', ['-c', 'core.longpaths=true', 'worktree', 'remove', wt], repo);
  } catch (err) {
    const msg = (err as Error).message;
    // git refuses uncommitted work: that's an answer, not something to force past.
    if (/modified or untracked|untracked files|is dirty|locked|is a main working tree/i.test(msg)) throw err;
    if (disk.exists(wt)) disk.rmTree(wt);
    await run('git', ['worktree', 'prune'], repo);
  }
}

export interface CleanupDeps {
  run: Runner;
  disk?: Disk;
  now?: Date;
}

/** Deletes the confirmed `keys` that are still in a plan made from `fresh` state; skips the rest. */
export async function runCleanup(fresh: LineState, keys: readonly string[], deps: CleanupDeps): Promise<CleanupResult> {
  const plan = cleanupPlan(fresh);
  const byKey = new Map(plan.items.map((i) => [i.key, i]));
  const stamp = (deps.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const backup = `refs/cleanline-backup/${stamp}`;
  const res: CleanupResult = { done: [], skipped: [] };
  const wanted = [...new Set(keys)];
  const pick = (kind: CleanupItem['kind']) => wanted.map((k) => byKey.get(k)).filter((i): i is CleanupItem => !!i && i.kind === kind);
  for (const k of wanted) if (!byKey.has(k)) res.skipped.push({ key: k, why: 'už neplatí (změnilo se, nebo to není bezpečné smazat)' });
  const failedWts = new Set<string>();
  for (const it of pick('worktree')) {
    try {
      // The worktree's HEAD is kept too, whatever it was on.
      await deps.run('git', ['update-ref', `${backup}/wt-${path.basename(it.name).replace(/[^A-Za-z0-9._-]/g, '-')}`, it.sha!], fresh.dir);
      res.backup = `${backup}/ v ${fresh.dir}`;
      await removeWorktree(deps.run, fresh.dir, it.name, deps.disk);
      res.done.push({ key: it.key, name: it.name });
    } catch (err) {
      failedWts.add(it.name);
      res.skipped.push({ key: it.key, why: (err as Error).message.split('\n')[0].slice(0, 200) });
    }
  }
  const remoteName = fresh.remote.split('/')[0];
  for (const it of [...pick('branch'), ...pick('remote-branch')]) {
    const holder = fresh.worktrees.find((w) => w.branch === it.name && failedWts.has(w.path));
    if (it.kind === 'remote-branch' && remoteName === 'origin' && fresh.remotes?.includes('fork')) {
      res.skipped.push({ key: it.key, why: 'origin je cizí upstream: nemažu na něm' });
      continue;
    }
    if (it.kind === 'branch' && holder) {
      res.skipped.push({ key: it.key, why: `worktree ${holder.path} se nepodařilo odstranit` });
      continue;
    }
    try {
      await deps.run('git', ['update-ref', `${backup}/${it.kind === 'branch' ? '' : 'remote/'}${it.name}`, it.sha!], fresh.dir);
      res.backup = `${backup}/ v ${fresh.dir}`;
      if (it.kind === 'branch') await deps.run('git', ['branch', '-D', it.name], fresh.dir);
      else await deps.run('git', ['push', remoteName, '--delete', it.name], fresh.dir);
      res.done.push({ key: it.key, name: it.kind === 'branch' ? it.name : `${remoteName}/${it.name}` });
    } catch (err) {
      res.skipped.push({ key: it.key, why: (err as Error).message.split('\n')[0].slice(0, 200) });
    }
  }
  return res;
}

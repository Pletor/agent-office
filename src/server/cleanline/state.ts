// 🧹 Reads a repository for the clean line, read-only: the remote main, every branch (local and on
// the remote) against it, the worktrees and who's in them. Built on the status wall's git helpers.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseWorktrees, prFor, remoteMain, samePath, type LiveWork, type Runner } from '../status/git.js';
import type { PrFact } from '../status/rules.js';
import type { LineState, RefInfo, WtInfo } from './health.js';

const tryRun = (run: Runner, args: string[], cwd: string) => run('git', args, cwd).catch(() => undefined);
const hours = (now: number, sec: number) => Math.max(0, (now - sec * 1000) / 3_600_000);

export interface ReadOptions {
  /** The remote main to hold it to (fork/main); found as the status wall finds it when missing. */
  remote?: string;
  fetch?: boolean;
  prs?: PrFact[];
  live: readonly LiveWork[];
  protect: string[];
  now?: number;
}

/** When a linked worktree was last touched: its index or HEAD in the repository's worktrees folder. */
function touched(wt: string): number {
  try {
    const dotGit = path.join(wt, '.git');
    const st = statSync(dotGit);
    const gitDir = st.isFile() ? path.resolve(wt, readFileSync(dotGit, 'utf8').replace(/^gitdir:\s*/, '').trim()) : dotGit;
    return Math.max(...['index', 'HEAD'].map((f) => {
      try {
        return statSync(path.join(gitDir, f)).mtimeMs;
      } catch {
        return 0;
      }
    }));
  } catch {
    return 0;
  }
}

/** Whether `ref`'s changes are all in `main` already: by ancestry, or merging it would change nothing (a squash). */
async function inMain(run: Runner, dir: string, ref: string, main: string, mainTree: string | undefined, ahead: number): Promise<boolean> {
  if (ahead === 0) return true;
  if (!mainTree) return false;
  const merged = await tryRun(run, ['merge-tree', '--write-tree', main, ref], dir);
  return !!merged && merged.split('\n')[0].trim() === mainTree;
}

export async function readLine(run: Runner, dir: string, opts: ReadOptions): Promise<LineState> {
  const now = opts.now ?? Date.now();
  const remote = await remoteMain(run, dir, opts.remote);
  const [remoteName, ...rest] = remote.split('/');
  const mainName = rest.join('/') || 'main';
  let remoteError: string | undefined;
  if (opts.fetch) {
    try {
      await run('git', ['fetch', '--quiet', '--prune', remoteName], dir);
    } catch (err) {
      remoteError = `fetch selhal (${(err as Error).message.split('\n')[0].slice(0, 120)})`;
    }
  }
  const mainRef = `refs/remotes/${remote}`;
  const mainSha = (await tryRun(run, ['rev-parse', '--verify', '--quiet', mainRef], dir)) || undefined;
  const state: LineState = { dir, remote, mainName, ...(mainSha ? { mainSha } : {}), ...(remoteError ? { remoteError } : !mainSha ? { remoteError: 'větev na remote chybí' } : {}), refs: [], worktrees: [], protect: opts.protect };
  const current = await tryRun(run, ['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  if (current && current !== 'HEAD') state.current = current;

  // The branches, local and remote, paired by name.
  if (mainSha) {
    const mainTree = await tryRun(run, ['rev-parse', `${mainRef}^{tree}`], dir);
    const out = (await tryRun(run, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:unix)', 'refs/heads', `refs/remotes/${remoteName}`], dir)) ?? '';
    const byName = new Map<string, RefInfo>();
    for (const line of out.split('\n').filter(Boolean)) {
      const [ref, sha, ct] = line.split('\t');
      const local = ref.startsWith('refs/heads/');
      const name = local ? ref.slice('refs/heads/'.length) : ref.slice(`refs/remotes/${remoteName}/`.length);
      if (!name || name === 'HEAD' || name === mainName) continue;
      const r = byName.get(name) ?? { name, idleH: Infinity, ahead: 0 };
      const ahead = Number(await tryRun(run, ['rev-list', '--count', `${mainRef}..${ref}`], dir)) || 0;
      let idle = hours(now, Number(ct) || 0);
      if (local && ahead === 0) {
        // A branch just made from main has main's old commit: when it was made is in its reflog.
        const made = Number(await tryRun(run, ['reflog', 'show', '-n1', '--format=%ct', ref, '--'], dir));
        if (made) idle = Math.min(idle, hours(now, made));
      }
      const merged = await inMain(run, dir, ref, mainRef, mainTree, ahead);
      if (local) Object.assign(r, { local: sha, localMerged: merged });
      else Object.assign(r, { remote: sha, remoteMerged: merged });
      r.idleH = Math.min(r.idleH, idle);
      if (ahead >= r.ahead) {
        r.ahead = ahead;
        if (ahead > 0 && !merged) r.behind = Number(await tryRun(run, ['rev-list', '--count', `${ref}..${mainRef}`], dir)) || 0;
      }
      byName.set(name, r);
    }
    for (const r of byName.values()) {
      const pr = prFor(opts.prs, r.name);
      if (pr) r.pr = pr;
      const worker = opts.live.find((w) => w.branch === r.name)?.name;
      if (worker) r.worker = worker;
    }
    state.refs = [...byName.values()];
  }

  // The worktrees, and who's in each.
  const wts = parseWorktrees((await tryRun(run, ['worktree', 'list', '--porcelain'], dir)) ?? '');
  for (const [i, wt] of wts.entries()) {
    if (wt.prunable) continue;
    const primary = i === 0;
    // The main checkout counts tracked files (as the status wall does); a worktree also its untracked ones.
    const status = await tryRun(run, ['status', '--porcelain', ...(primary ? ['--untracked-files=no'] : [])], wt.path);
    if (status === undefined) continue;
    const headTime = Number(await tryRun(run, ['log', '-1', '--format=%ct', 'HEAD'], wt.path)) || 0;
    const idleH = Math.min(hours(now, headTime), (now - touched(wt.path)) / 3_600_000);
    const worker = opts.live.find((w) => (w.path && samePath(w.path, wt.path)) || (w.branch && w.branch === wt.branch))?.name;
    const info: WtInfo = { path: wt.path, ...(wt.branch ? { branch: wt.branch } : {}), dirty: status ? status.split('\n').filter(Boolean).length : 0, primary, idleH, ...(worker ? { worker } : {}) };
    state.worktrees.push(info);
  }
  return state;
}

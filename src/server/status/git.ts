// 🚦 What the status wall finds in a repository, through git and gh run with fixed arguments and no
// shell (see runner.ts). The runner is handed in, so a test can answer for git and gh itself.
import path from 'node:path';
import type { BranchFact, PrFact, RepoFacts, WorktreeFact } from './rules.js';

/** Runs `cmd args` in `cwd`, resolving to its trimmed output, rejecting when it fails. */
export type Runner = (cmd: string, args: string[], cwd: string) => Promise<string>;

/** A seated worker, as far as the wall goes: its name, and its worktree's folder and branch. */
export interface LiveWork {
  name: string;
  path?: string;
  branch?: string;
}

const tryRun = (run: Runner, cmd: string, args: string[], cwd: string) => run(cmd, args, cwd).catch(() => undefined);

/** A folder, comparable to another (Windows ignores case and takes either slash). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.replace(/\//g, '\\').toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/**
 * The remote main the repository is held to: the one asked for (AGENT_OFFICE_STATUS_REMOTE, say
 * `fork/main`), else `fork/main` when there's a remote called fork (a fork you push to, next to a
 * read-only upstream), else what the local main tracks, else origin/main.
 */
export async function remoteMain(run: Runner, dir: string, wanted?: string): Promise<string> {
  if (wanted?.includes('/')) return wanted;
  const remotes = ((await tryRun(run, 'git', ['remote'], dir)) ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (remotes.includes('fork')) return 'fork/main';
  const up = await tryRun(run, 'git', ['rev-parse', '--abbrev-ref', 'main@{upstream}'], dir);
  if (up && up.includes('/')) return up;
  return `${remotes[0] ?? 'origin'}/main`;
}

/** `git worktree list --porcelain`, as folders and their branches; the first is the primary checkout. */
export function parseWorktrees(out: string): { path: string; branch?: string; prunable: boolean }[] {
  const list: { path: string; branch?: string; prunable: boolean }[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim());
    const wt = lines.find((l) => l.startsWith('worktree '));
    if (!wt) continue;
    const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length).replace(/^refs\/heads\//, '');
    list.push({ path: wt.slice('worktree '.length), branch, prunable: lines.some((l) => l.startsWith('prunable')) });
  }
  return list;
}

/** owner/repo of a GitHub remote's URL (https or ssh), or undefined. */
export function githubRepo(url: string): string | undefined {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** Every pull request of the repository, newest first (`gh pr list --state all`), or undefined without gh. */
export async function listPrs(run: Runner, dir: string, repo: string, gh = 'gh'): Promise<PrFact[] | undefined> {
  const out = await tryRun(run, gh, ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '300', '--json', 'number,state,headRefName,url,isDraft'], dir);
  if (out === undefined) return undefined;
  try {
    const rows = JSON.parse(out) as unknown;
    if (!Array.isArray(rows)) return undefined;
    return rows
      .filter((r): r is PrFact => !!r && typeof r.number === 'number' && typeof r.headRefName === 'string' && ['OPEN', 'MERGED', 'CLOSED'].includes(r.state))
      .map((r) => ({ number: r.number, state: r.state, headRefName: r.headRefName, ...(typeof r.url === 'string' ? { url: r.url } : {}), ...(r.isDraft === true ? { isDraft: true } : {}) }));
  } catch {
    return undefined;
  }
}

/** The PR that says most about a branch: an open one, else a merged one, else the newest closed one. */
export function prFor(prs: readonly PrFact[] | undefined, branch: string): PrFact | undefined {
  const mine = (prs ?? []).filter((p) => p.headRefName === branch);
  return mine.find((p) => p.state === 'OPEN') ?? mine.find((p) => p.state === 'MERGED') ?? mine[0];
}

export interface RepoOptions {
  /** The remote main to hold it to (see remoteMain). */
  remote?: string;
  /** Fetch the remote first (every few minutes; the cheap checks in between don't). */
  fetch?: boolean;
  /** The repository's pull requests (listPrs), read with the last fetch; undefined without gh. */
  prs?: PrFact[];
  live: readonly LiveWork[];
}

/** Everything repoReasons needs about the repository at `dir`. */
export async function repoFacts(run: Runner, dir: string, opts: RepoOptions): Promise<RepoFacts> {
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
  const remoteRef = `refs/remotes/${remote}`;
  const remoteSha = await tryRun(run, 'git', ['rev-parse', '--verify', '--quiet', remoteRef], dir);
  const facts: RepoFacts = { dir, remote, remoteSha: remoteSha || undefined, remoteError, branches: [], worktrees: [], prLookup: !!opts.prs };
  if (!facts.remoteSha) facts.remoteError ??= 'větev na remote chybí';

  // Local main against the remote main.
  if (facts.remoteSha && (await tryRun(run, 'git', ['rev-parse', '--verify', '--quiet', `refs/heads/${mainName}`], dir))) {
    const counts = await tryRun(run, 'git', ['rev-list', '--left-right', '--count', `refs/heads/${mainName}...${remoteRef}`], dir);
    const [ahead, behind] = (counts ?? '').split(/\s+/).map(Number);
    if (Number.isFinite(ahead) && Number.isFinite(behind)) facts.localMain = { ahead, behind };
  }

  // The worktrees, and who's in each.
  const wts = parseWorktrees((await tryRun(run, 'git', ['worktree', 'list', '--porcelain'], dir)) ?? '');
  for (const [i, wt] of wts.entries()) {
    if (wt.prunable) continue;
    const status = await tryRun(run, 'git', ['status', '--porcelain', '--untracked-files=no'], wt.path);
    if (status === undefined) continue; // gone from disk, or not readable
    const worker = opts.live.find((w) => (w.path && samePath(w.path, wt.path)) || (w.branch && w.branch === wt.branch))?.name;
    const fact: WorktreeFact = { path: wt.path, ...(wt.branch ? { branch: wt.branch } : {}), dirty: status ? status.split('\n').filter(Boolean).length : 0, primary: i === 0, ...(worker ? { worker } : {}) };
    facts.worktrees.push(fact);
  }

  // The branches, local and on the remote, against the remote main.
  if (facts.remoteSha) {
    const refs = ((await tryRun(run, 'git', ['for-each-ref', '--format=%(refname)', 'refs/heads', `refs/remotes/${remoteName}`], dir)) ?? '').split('\n').filter(Boolean);
    const seen = new Map<string, BranchFact>();
    const mainTree = await tryRun(run, 'git', ['rev-parse', `${remoteRef}^{tree}`], dir);
    for (const ref of refs) {
      const local = ref.startsWith('refs/heads/');
      const name = local ? ref.slice('refs/heads/'.length) : ref.slice(`refs/remotes/${remoteName}/`.length);
      if (!name || name === 'HEAD' || name === mainName) continue;
      const ahead = Number(await tryRun(run, 'git', ['rev-list', '--count', `${remoteRef}..${ref}`], dir)) || 0;
      const had = seen.get(name);
      if (had && had.ahead >= ahead) continue;
      const b: BranchFact = { name, ahead, ...(local ? {} : { remote: true }) };
      const pr = prFor(opts.prs, name);
      if (pr) b.pr = pr;
      const worker = opts.live.find((w) => w.branch === name)?.name;
      if (worker) b.worker = worker;
      // A squash merge leaves no ancestry: the branch's changes already in main still count as merged.
      if (ahead > 0 && pr?.state !== 'MERGED' && mainTree) {
        const merged = await tryRun(run, 'git', ['merge-tree', '--write-tree', remoteRef, ref], dir);
        if (merged && merged.split('\n')[0].trim() === mainTree) b.inMain = true;
      }
      seen.set(name, b);
    }
    facts.branches = [...seen.values()];
  }
  return facts;
}

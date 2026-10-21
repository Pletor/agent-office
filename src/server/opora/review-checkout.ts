import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { normalizeRepo } from '../../shared/floors.js';
import type { ReviewJob } from './review-client.js';
import type { ReviewMaterial } from './review-prompt.js';

/**
 * A review slot's own checkout of the pull request: a detached worktree of the floor's repository at
 * the job's `headSha`, which nobody commits to or pushes from, and the diff the slot reviews
 * (`sinceSha..headSha` in a later round, else from the merge base of `baseSha`, or of the remote's
 * default branch when Canvas couldn't read the base).
 */

export type Git = (args: string[], cwd: string) => Promise<string>;
export interface Checkout extends ReviewMaterial { dir: string; cleanup(): Promise<void> }

const SHA = /^[a-f0-9]{40}$/;

async function has(git: Git, repo: string, sha: string): Promise<boolean> {
  try { await git(['cat-file', '-e', `${sha}^{commit}`], repo); return true; } catch { return false; }
}

async function fetchCommit(git: Git, repo: string, sha: string, number?: number): Promise<void> {
  if (await has(git, repo, sha)) return;
  if (number) await git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/pull/${number}/head:refs/opora-review/pr-${number}`], repo).catch(() => '');
  if (!(await has(git, repo, sha))) await git(['fetch', '--no-tags', '--quiet', 'origin', sha], repo).catch(() => '');
  if (!(await has(git, repo, sha))) throw new Error(`commit ${sha.slice(0, 12)} isn't reachable from origin`);
}

async function defaultBase(git: Git, repo: string, head: string): Promise<string> {
  for (const ref of ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master']) {
    try { const sha = (await git(['merge-base', head, ref], repo)).trim(); if (SHA.test(sha)) return sha; } catch { /* next */ }
  }
  throw new Error('no base to diff against: Canvas has no baseSha and origin has no default branch');
}

export async function prepareCheckout(git: Git, repo: string, root: string, job: ReviewJob, key: string): Promise<Checkout> {
  const origin = normalizeRepo((await git(['remote', 'get-url', 'origin'], repo).catch(() => '')).trim());
  if (!origin || origin.toLowerCase() !== job.repository.toLowerCase()) throw new Error(`this floor's origin isn't ${job.repository}`);
  await fetchCommit(git, repo, job.headSha, job.number);
  let base: string;
  const incremental = !!job.sinceSha;
  if (job.sinceSha) {
    await fetchCommit(git, repo, job.sinceSha, job.number);
    base = job.sinceSha;
  } else if (job.baseSha) {
    await fetchCommit(git, repo, job.baseSha);
    base = (await git(['merge-base', job.baseSha, job.headSha], repo)).trim();
  } else base = await defaultBase(git, repo, job.headSha);
  if (!SHA.test(base)) throw new Error('git returned no merge base');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = path.join(root, key.replace(/[^A-Za-z0-9_-]/g, '-'));
  rmSync(dir, { recursive: true, force: true });
  await git(['worktree', 'prune'], repo).catch(() => '');
  await git(['worktree', 'add', '--detach', '--force', dir, job.headSha], repo);
  const cleanup = async () => {
    await git(['worktree', 'remove', '--force', dir], repo).catch(() => '');
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const range = [base, job.headSha];
    const diff = await git(['diff', '--no-color', '--no-ext-diff', ...range], dir);
    const files = (await git(['diff', '--name-only', '--no-ext-diff', ...range], dir)).split('\n').map((s) => s.trim()).filter(Boolean);
    return { dir, base, diff, files, incremental, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gh as runGh } from '../github.js';

/**
 * What PR upkeep and the post-merge guard run: git, gh, the repository's check command and the
 * conflict resolver, narrow so a test can fake each; and the ledger they keep between passes.
 */

export interface CheckResult { ok: boolean; output: string }
export interface ResolveRun { cwd: string; prompt: string }
export interface UpkeepTools {
  git(args: string[], cwd: string): Promise<string>;
  gh(args: string[], cwd: string): Promise<string>;
  /** Runs the configured check command in `cwd`; resolves (never rejects) with whether it passed. */
  check(command: string, cwd: string): Promise<CheckResult>;
  /** A fresh headless model run that edits conflicted files in `cwd` (conflict-resolver.ts). */
  resolve(run: ResolveRun): Promise<string>;
}

export function gitRunner(timeoutMs = 180_000): UpkeepTools['git'] {
  return (args, cwd) => new Promise((resolve, reject) => execFile('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ') || 'git failed')) : resolve(stdout))));
}

export const ghRunner: UpkeepTools['gh'] = async (args, cwd) => (await runGh(args, cwd, 90_000)).trim();

/** The check command through the platform's shell, keeping the last 4 KB of its output for evidence. */
export function checkRunner(timeoutMs: number, env: NodeJS.ProcessEnv = process.env): UpkeepTools['check'] {
  return (command, cwd) => new Promise((resolve) => {
    let out = '';
    const keep = (d: Buffer | string) => { out = (out + String(d)).slice(-4096); };
    const child = spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { child.kill('SIGKILL'); keep('\n[timed out]'); }, timeoutMs);
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out.trim() }); });
  });
}

/** A throwaway detached worktree at `sha` under `root`, removed again by `cleanup`. */
export async function throwaway(git: UpkeepTools['git'], repo: string, root: string, key: string, sha: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = path.join(root, key.replace(/[^A-Za-z0-9_-]/g, '-'));
  rmSync(dir, { recursive: true, force: true });
  await git(['worktree', 'prune'], repo).catch(() => '');
  await git(['worktree', 'add', '--detach', '--force', dir, sha], repo);
  return {
    dir,
    cleanup: async () => {
      await git(['worktree', 'remove', '--force', dir], repo).catch(() => '');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function isAncestor(git: UpkeepTools['git'], repo: string, a: string, b: string): Promise<boolean> {
  try { await git(['merge-base', '--is-ancestor', a, b], repo); return true; } catch { return false; }
}

/** The execution id of an `Opora-Execution:` trailer in a commit message or PR body. */
export function executionOf(text: string | undefined): string | undefined {
  return /^Opora-Execution:[ \t]*([A-Za-z0-9._:-]{1,120})[ \t]*$/m.exec(text ?? '')?.[1];
}

export interface PrEntry { head: string; attempts: number; human?: boolean }
export interface RevertEntry { state: 'opened' | 'reused' | 'failed'; url?: string; reason?: string }
interface LedgerData {
  prs: Record<string, PrEntry>;
  lastGreen?: string;
  /** The red base head the guard already bisected, so it doesn't bisect it again each pass. */
  handledRed?: string;
  reverts: Record<string, RevertEntry>;
}

/** What upkeep and the guard remember between passes and restarts (`opora-upkeep/state.json`). */
export class UpkeepLedger {
  private data: LedgerData = { prs: {}, reverts: {} };
  constructor(private file?: string) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<LedgerData>;
      this.data = { prs: saved.prs ?? {}, reverts: saved.reverts ?? {}, lastGreen: saved.lastGreen, handledRed: saved.handledRed };
    } catch { /* a missing or broken file starts afresh */ }
  }

  /** The PR's entry for this head commit: a new head starts with no attempts and no human mark. */
  pr(number: number, head: string): PrEntry {
    const entry = this.data.prs[number];
    if (entry?.head === head) return entry;
    return (this.data.prs[number] = { head, attempts: 0 });
  }
  get lastGreen() { return this.data.lastGreen; }
  set lastGreen(sha: string | undefined) { this.data.lastGreen = sha; this.save(); }
  get handledRed() { return this.data.handledRed; }
  set handledRed(sha: string | undefined) { this.data.handledRed = sha; this.save(); }
  revert(sha: string): RevertEntry | undefined { return this.data.reverts[sha]; }
  setRevert(sha: string, entry: RevertEntry) { this.data.reverts[sha] = entry; this.save(); }

  save() {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch { /* a full disk only means a repeated attempt */ }
  }
}

export type Say = (message: string, level: 'info' | 'warn') => void;

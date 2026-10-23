// A floor's dependency setup for its workers' fresh worktrees: `.agent-office/worktree-setup.json` in
// the floor's checkout names one shell command (`npm ci && uv sync`, say) that runs in each new
// worktree before its worker starts, and again before self-checks in a worktree it never ran in.
// The worker's first prompt says how it went. A floor without the file gets no setup, as before.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { shellCheck, type ExecCheck } from '../opora/self-checks.js';

/** Where a floor names its setup command, relative to its checkout. */
export const SETUP_FILE = path.join('.agent-office', 'worktree-setup.json');
/** Kept in the worktree's own git dir (never in its files): the setup that last ran there. */
const MARKER = 'agent-office-setup.json';
const DEFAULT_TIMEOUT_MIN = 15, MAX_TIMEOUT_MIN = 120, MAX_COMMAND = 1000, LOG_TAIL_LINES = 15;

export interface WorktreeSetupConfig { command: string; timeoutMs: number }
export interface SetupOutcome { command: string; exitCode: number; lastLine?: string }
export type SetupLog = (message: string, level: 'info' | 'warn') => void;

const floorLog: SetupLog = (message, level) => (level === 'info' ? console.log : console.warn)(`[worktree-setup] ${message}`);
/** What was already said about each floor's file, so a missing or broken one is logged once, not on every hire. */
const said = new Map<string, string>();
function once(dir: string, message: string, level: 'info' | 'warn', log: SetupLog) {
  if (said.get(dir) === message) return;
  said.set(dir, message);
  log(message, level);
}

/** The floor's setup, read afresh each time (an edit applies to the next worktree); undefined when there's none to run. */
export function loadWorktreeSetup(floorDir: string, log: SetupLog = floorLog): WorktreeSetupConfig | undefined {
  const file = path.join(floorDir, SETUP_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    once(floorDir, `no ${file}: new worktrees get no dependency setup`, 'info', log);
    return undefined;
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { value = undefined; }
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const command = typeof v?.command === 'string' ? v.command.trim() : '';
  const minutes = v?.timeoutMin === undefined ? DEFAULT_TIMEOUT_MIN : Number(v.timeoutMin);
  if (!command || command.length > MAX_COMMAND || !Number.isFinite(minutes) || minutes < 1) {
    once(floorDir, `${file} is invalid (want {"command": "npm ci", "timeoutMin": ${DEFAULT_TIMEOUT_MIN}}): new worktrees get no dependency setup`, 'warn', log);
    return undefined;
  }
  said.delete(floorDir);
  return { command, timeoutMs: Math.min(MAX_TIMEOUT_MIN, Math.floor(minutes)) * 60_000 };
}

/** The line the worker's first prompt carries about its worktree's setup. */
export function setupPromptLine(outcome: SetupOutcome): string {
  if (outcome.exitCode === 0) return `Project dependencies are installed in this worktree: the office ran \`${outcome.command}\` before you started; don't reinstall them unless a check needs it.`;
  return `Setup \`${outcome.command}\` failed with exit ${outcome.exitCode}: ${outcome.lastLine ?? 'no output'}; fix the environment before running checks.`;
}

const lastLine = (output: string) => output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 300);

/** Runs a floor's setup in its workers' worktrees; one run per worktree at a time. */
export class WorktreeSetup {
  private running = new Map<string, Promise<SetupOutcome | undefined>>();
  constructor(private floorDir: string, private log: SetupLog = floorLog,
    private exec: (timeoutMs: number) => ExecCheck = (timeoutMs) => shellCheck(timeoutMs)) {}

  /**
   * For a worker about to start in a fresh worktree `dir`: undefined when the floor has no setup (start
   * it now), else its first prompt once the setup ran, with the line saying how that went. A worker
   * starts either way.
   */
  prepare(dir: string, prompt: string | undefined): Promise<string | undefined> | undefined {
    const config = loadWorktreeSetup(this.floorDir, this.log);
    if (!config) return undefined;
    return this.run(dir, config).then(
      (outcome) => (outcome && prompt ? `${prompt}\n\n${setupPromptLine(outcome)}` : prompt),
      () => prompt,
    );
  }

  /** Before self-checks: the setup, unless it already ran in `dir` (successfully, with this command). */
  ensure(dir: string): Promise<SetupOutcome | undefined> {
    const config = loadWorktreeSetup(this.floorDir, this.log);
    if (!config) return Promise.resolve(undefined);
    const done = this.marker(dir);
    if (done?.exitCode === 0 && done.command === config.command) return Promise.resolve(done);
    return this.run(dir, config);
  }

  /** Runs `config` in `dir` (the one already running there, if any), logs its tail and remembers it in the git dir. */
  run(dir: string, config: WorktreeSetupConfig): Promise<SetupOutcome | undefined> {
    const busy = this.running.get(dir);
    if (busy) return busy;
    this.log(`running \`${config.command}\` in ${dir}`, 'info');
    const job = this.exec(config.timeoutMs)(config.command, dir).then((ran) => {
      const exitCode = ran.exitCode === null ? 127 : ran.exitCode;
      const outcome: SetupOutcome = { command: config.command, exitCode, lastLine: ran.timedOut ? 'timed out' : lastLine(ran.output) };
      const tail = ran.output.split(/\r?\n/).filter((l) => l.trim()).slice(-LOG_TAIL_LINES).join('\n');
      this.log(`\`${config.command}\` in ${dir} ${exitCode === 0 ? 'passed' : `failed with exit ${exitCode}`}${tail ? `:\n${tail}` : ''}`, exitCode === 0 ? 'info' : 'warn');
      this.remember(dir, outcome);
      return outcome;
    }).finally(() => this.running.delete(dir));
    this.running.set(dir, job);
    return job;
  }

  private markerFile(dir: string): string | undefined {
    try {
      const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
      return gitDir ? path.join(gitDir, MARKER) : undefined;
    } catch {
      return undefined;
    }
  }

  private marker(dir: string): SetupOutcome | undefined {
    const file = this.markerFile(dir);
    try {
      return file ? JSON.parse(readFileSync(file, 'utf8')) as SetupOutcome : undefined;
    } catch {
      return undefined;
    }
  }

  private remember(dir: string, outcome: SetupOutcome) {
    const file = this.markerFile(dir);
    try {
      if (file) writeFileSync(file, JSON.stringify(outcome));
    } catch { /* the next self-check runs it again */ }
  }
}

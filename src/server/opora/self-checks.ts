import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { executionOf } from './upkeep-tools.js';

/**
 * Self-check evidence (Canvas's docs/oporahub-review-jobs.md, "Důkaz vlastních kontrol"): before a
 * pull request asks to be merged, the office runs the configured checks on its exact head commit and
 * tells Canvas what came out, through `POST /api/oporahub/review-jobs/self-checks`. It is the agent's
 * claim, not independent verification, and is shaped and bounded here exactly as Canvas validates it
 * (unknown keys are refused there). It runs when the office hands a pull request off
 * (execution-dispatch.ts, isolated-pull-request.ts) and on every new head PR upkeep pushes
 * (upkeep-runner.ts). Off until `AGENT_OFFICE_OPORA_SELF_CHECKS` names the checks.
 */

export interface SelfCheckCommand { name: string; command: string }
export interface SelfCheck {
  name: string; command: string; exitCode: number | null; status: 'passed' | 'failed' | 'skipped';
  summary?: string; output?: string; durationSeconds?: number;
}
export interface SelfChecks { headSha: string; checks: SelfCheck[] }
export interface SelfCheckScope { project: string; workspace: string }
export type SelfCheckOutcome = 'recorded' | 'not-deployed' | 'conflict' | 'failed' | 'skipped';
/** Runs one shell command in `cwd`; resolves (never rejects) with its exit code (null: it never ran) and the tail of its output. */
export type ExecCheck = (command: string, cwd: string) => Promise<{ exitCode: number | null; output: string; timedOut?: boolean }>;

const NAME = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const SHA = /^[a-f0-9]{40}$/;
const MAX_CHECKS = 30, MAX_COMMAND = 1000, MAX_SUMMARY = 500, MAX_OUTPUT = 4000;
const KEYS = new Set(['name', 'command', 'exitCode', 'status', 'summary', 'output', 'durationSeconds']);

/**
 * The checks to run: `AGENT_OFFICE_OPORA_SELF_CHECKS` as a JSON object (`{"tests":"npm test","build":"npm run build"}`)
 * or one `name=command` per line. Names Canvas wouldn't take, and commands it wouldn't, are dropped.
 */
export function selfCheckCommands(env: NodeJS.ProcessEnv = process.env): SelfCheckCommand[] {
  const raw = (env.AGENT_OFFICE_OPORA_SELF_CHECKS ?? '').trim();
  if (!raw) return [];
  let pairs: [string, unknown][] = [];
  if (raw.startsWith('{')) {
    try { pairs = Object.entries(JSON.parse(raw) as Record<string, unknown>); } catch { return []; }
  } else pairs = raw.split(/\r?\n/).map((line) => { const at = line.indexOf('='); return [line.slice(0, at).trim(), at > 0 ? line.slice(at + 1).trim() : ''] as [string, string]; });
  const out: SelfCheckCommand[] = [];
  for (const [name, command] of pairs) {
    if (NAME.test(name) && typeof command === 'string' && command.trim() && command.length <= MAX_COMMAND && !out.some((c) => c.name === name)) out.push({ name, command: command.trim() });
  }
  return out.slice(0, MAX_CHECKS);
}

export function selfCheckTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env.AGENT_OFFICE_OPORA_SELF_CHECK_TIMEOUT_MIN ?? '').trim());
  return (Number.isFinite(n) && n >= 1 ? Math.min(120, Math.floor(n)) : 20) * 60_000;
}

/** The platform's shell runs the command, keeping the last 4000 characters of what it printed. */
export function shellCheck(timeoutMs: number, env: NodeJS.ProcessEnv = process.env): ExecCheck {
  return (command, cwd) => new Promise((resolve) => {
    let out = '', timedOut = false;
    const keep = (d: Buffer | string) => { out = (out + String(d)).slice(-MAX_OUTPUT); };
    const child = spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: null, output: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: timedOut ? 124 : code ?? 1, output: out, timedOut }); });
  });
}

/** The last line of output worth reading, as the check's one-line summary. */
function summaryOf(output: string, timedOut?: boolean): string | undefined {
  if (timedOut) return 'timed out';
  const line = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  return line ? line.slice(0, MAX_SUMMARY) : undefined;
}

/**
 * Runs each check in `cwd`, in order, and returns the evidence for `headSha`. A check that couldn't
 * start is `failed` with exit code 127, a timed-out one `failed` with 124: Canvas allows `skipped`
 * only for a check that deliberately didn't run, and `passed` only for exit code 0.
 */
export async function runSelfChecks(commands: SelfCheckCommand[], cwd: string, headSha: string, exec: ExecCheck,
  now: () => number = Date.now): Promise<SelfChecks> {
  if (!SHA.test(headSha)) throw new Error('self-checks need the 40-character head commit');
  const checks: SelfCheck[] = [];
  for (const { name, command } of commands.slice(0, MAX_CHECKS)) {
    const started = now();
    const ran = await exec(command, cwd);
    const exitCode = ran.exitCode === null ? 127 : ran.exitCode;
    const output = ran.output.trim().slice(-MAX_OUTPUT);
    const summary = summaryOf(ran.output, ran.timedOut);
    checks.push({ name, command, exitCode, status: exitCode === 0 ? 'passed' : 'failed',
      ...(summary ? { summary } : {}), ...(output ? { output } : {}),
      durationSeconds: Math.max(0, Math.round((now() - started) / 100) / 10) });
  }
  return { headSha, checks };
}

/** Whether `value` is evidence Canvas would take, with the same rules (validation, not repair). */
export function validSelfChecks(value: unknown): value is SelfChecks {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'headSha' && k !== 'checks') || typeof v.headSha !== 'string' || !SHA.test(v.headSha)) return false;
  if (!Array.isArray(v.checks) || v.checks.length < 1 || v.checks.length > MAX_CHECKS) return false;
  const names = new Set<string>();
  return v.checks.every((c: unknown) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
    const k = c as Record<string, unknown>;
    if (Object.keys(k).some((key) => !KEYS.has(key))) return false;
    if (typeof k.name !== 'string' || !NAME.test(k.name) || names.has(k.name)) return false;
    names.add(k.name);
    if (typeof k.command !== 'string' || !k.command.length || k.command.length > MAX_COMMAND) return false;
    const code = k.exitCode;
    if (k.status === 'passed' ? code !== 0 : k.status === 'failed' ? !(Number.isSafeInteger(code) && code !== 0) : k.status === 'skipped' ? code !== null : true) return false;
    if (k.summary !== undefined && (typeof k.summary !== 'string' || k.summary.length > MAX_SUMMARY)) return false;
    if (k.output !== undefined && (typeof k.output !== 'string' || k.output.length > MAX_OUTPUT)) return false;
    return k.durationSeconds === undefined || (typeof k.durationSeconds === 'number' && Number.isFinite(k.durationSeconds) && k.durationSeconds >= 0);
  });
}

/** POST /api/oporahub/review-jobs/self-checks as the office's agent. 404: Canvas predates it; 409: refused (a different record for this head, or not its current head). */
export async function postSelfChecks(base: string, agent: string, transport: typeof fetch,
  body: SelfCheckScope & { executionId: string; selfChecks: SelfChecks }): Promise<Exclude<SelfCheckOutcome, 'skipped'>> {
  try {
    const response = await transport(new URL('/api/oporahub/review-jobs/self-checks', base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: new URL(base).origin, 'X-Opora-Actor': `agent; name=${agent}` },
      body: JSON.stringify({ project: body.project, workspace: body.workspace, executionId: body.executionId, selfChecks: body.selfChecks }),
    });
    if (response.ok) return 'recorded';
    return response.status === 404 ? 'not-deployed' : response.status === 409 ? 'conflict' : 'failed';
  } catch { return 'failed'; }
}

export interface SelfCheckSubject extends SelfCheckScope { executionId: string; headSha: string; dir: string }

/**
 * Runs the checks once per (execution, head commit) and posts them; a second call for the same head,
 * even after a restart, does nothing. Runs go one at a time, so two pull requests don't race for the
 * machine. Undefined from `createSelfCheckReporter` while no checks are configured.
 */
export class SelfCheckReporter {
  private queue: Promise<unknown> = Promise.resolve();
  private running = new Map<string, Promise<SelfCheckOutcome>>();
  /** Heads whose evidence Canvas refused for now and that are posted again on a timer. */
  private pending = new Set<string>();
  private timers = new Set<NodeJS.Timeout>();
  constructor(private base: string, private agent: string, private commands: SelfCheckCommand[], private ledgerFile: string,
    private exec: ExecCheck, private transport: typeof fetch = fetch, private log: (message: string, level: 'info' | 'warn') => void = () => {},
    private retry: { everyMs: number; attempts: number } = SELF_CHECK_RETRY) {}

  /** Stops the re-posts still waiting (the office is shutting down). */
  shutdown() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private ledger(): Record<string, SelfCheckOutcome> {
    try { return JSON.parse(readFileSync(this.ledgerFile, 'utf8')) as Record<string, SelfCheckOutcome>; } catch { return {}; }
  }
  private remember(key: string, outcome: SelfCheckOutcome) {
    try {
      const all = this.ledger();
      all[key] = outcome;
      mkdirSync(path.dirname(this.ledgerFile), { recursive: true, mode: 0o700 });
      writeFileSync(this.ledgerFile, JSON.stringify(all, null, 2), { mode: 0o600 });
    } catch { /* the next call runs them again; Canvas takes the same record idempotently */ }
  }

  /** The evidence run for this head, or the one already under way; resolves to what Canvas said. */
  report(subject: SelfCheckSubject): Promise<SelfCheckOutcome> {
    const key = `${subject.executionId}@${subject.headSha}`;
    const prior = this.ledger()[key];
    if (prior === 'recorded' || prior === 'conflict' || this.pending.has(key)) return Promise.resolve('skipped');
    const busy = this.running.get(key);
    if (busy) return busy;
    const job = this.queue.catch(() => undefined).then(() => this.once(key, subject));
    this.queue = job;
    const tracked = job.catch((): SelfCheckOutcome => 'failed').finally(() => this.running.delete(key));
    this.running.set(key, tracked);
    return tracked;
  }

  private async once(key: string, s: SelfCheckSubject): Promise<SelfCheckOutcome> {
    const selfChecks = await runSelfChecks(this.commands, s.dir, s.headSha, this.exec);
    const outcome = await postSelfChecks(this.base, this.agent, this.transport, { project: s.project, workspace: s.workspace, executionId: s.executionId, selfChecks });
    const failed = selfChecks.checks.filter((c) => c.status !== 'passed').map((c) => c.name);
    const what = failed.length ? `${failed.join(', ')} failed` : 'all passed';
    this.log(outcome === 'recorded' ? `🧪 Self-checks for ${s.executionId} at ${s.headSha.slice(0, 12)}: ${what}; Canvas recorded them`
      : `🧪 Self-checks for ${s.executionId} at ${s.headSha.slice(0, 12)} (${what}) were not recorded by Canvas (${outcome})`, outcome === 'recorded' && !failed.length ? 'info' : 'warn');
    // 409 right after PR upkeep pushed is usually "not the PR's current head" yet: Canvas learns a new
    // head from its next reconciliation read (every few minutes), so the same evidence is posted again
    // for a while before the refusal counts. A different record for this head stays refused anyway.
    if (outcome === 'conflict' && this.retry.attempts > 0) this.postLater(key, s, selfChecks, 1);
    else if (outcome !== 'failed') this.remember(key, outcome);
    return outcome;
  }

  private postLater(key: string, s: SelfCheckSubject, selfChecks: SelfChecks, attempt: number) {
    this.pending.add(key);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void postSelfChecks(this.base, this.agent, this.transport, { project: s.project, workspace: s.workspace, executionId: s.executionId, selfChecks }).then((outcome) => {
        if ((outcome === 'conflict' || outcome === 'failed') && attempt < this.retry.attempts) return this.postLater(key, s, selfChecks, attempt + 1);
        this.pending.delete(key);
        if (outcome === 'recorded') this.log(`🧪 Self-checks for ${s.executionId} at ${s.headSha.slice(0, 12)}: Canvas recorded them once it saw that head`, 'info');
        if (outcome !== 'failed') this.remember(key, outcome);
      });
    }, this.retry.everyMs);
    timer.unref?.();
    this.timers.add(timer);
  }
}

/** Re-posts of evidence Canvas refused (409): every 30 s for 10 minutes, past Canvas's 5-minute reconciliation of a PR's head. */
export const SELF_CHECK_RETRY = { everyMs: 30_000, attempts: 20 };

export function createSelfCheckReporter(base: string, agent: string, dataDir: string, log: (message: string, level: 'info' | 'warn') => void,
  env: NodeJS.ProcessEnv = process.env): SelfCheckReporter | undefined {
  const commands = selfCheckCommands(env);
  if (!commands.length) return undefined;
  return new SelfCheckReporter(base, agent, commands, path.join(dataDir, 'opora-self-checks.json'), shellCheck(selfCheckTimeoutMs(env)), fetch, log);
}

/** The project and workspace an execution was claimed in, from its bundle (only those two fields are read). */
export function executionScope(dataDir: string, executionId: string): SelfCheckScope | undefined {
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(executionId)) return undefined;
  try {
    const b = JSON.parse(readFileSync(path.join(dataDir, 'opora-executions', `${executionId}.json`), 'utf8')) as { project?: unknown; workspace?: unknown };
    return typeof b.project === 'string' && typeof b.workspace === 'string' ? { project: b.project, workspace: b.workspace } : undefined;
  } catch { return undefined; }
}

/**
 * PR upkeep's `pushed` hook: evidence for the head it just pushed, for the execution its pull request
 * body names (`Opora-Execution:`), in that execution's scope, else the floor's linked one.
 */
export function upkeepSelfChecks(reporter: SelfCheckReporter, dataDir: string, linked: () => SelfCheckScope | undefined) {
  return async (pr: { body?: string }, headSha: string, dir: string): Promise<unknown> => {
    const executionId = executionOf(pr.body);
    const scope = executionId && (executionScope(dataDir, executionId) ?? linked());
    if (!executionId || !scope) return 'skipped';
    return reporter.report({ ...scope, executionId, headSha, dir });
  };
}

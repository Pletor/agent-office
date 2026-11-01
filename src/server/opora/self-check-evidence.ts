// What a self-check run leaves behind, so a red result can be read afterwards: each command's exit code
// and the last lines of its output, made safe (no tokens, no paths into the office's data, the worktree
// folded to `.`; process/redact.ts) for the evidence Canvas keeps, the office's ledger and its log. And
// the rule for a red check: it runs once more, and is red only when that fails too.
import { redactLines } from '../process/redact.js';
import { cutText, tailText } from '../../shared/text-cut.js';

/** How many of the output's last lines are kept. */
export const TAIL_LINES = 40;
const LINE_MAX = 300, MAX_OUTPUT = 4000, MAX_SUMMARY = 500;

/** The last `TAIL_LINES` non-empty lines of `output`, redacted, within Canvas's 4000 characters. */
export function outputTail(output: string, roots: string[] = []): string {
  const lines = output.split(/\r?\n/).filter((l) => l.trim()).slice(-TAIL_LINES).join('\n');
  return tailText(redactLines(lines, LINE_MAX, roots), MAX_OUTPUT).trim();
}

/** One check's run, the first and (after a red one) the second. */
export interface CheckRun { exitCode: number; output: string; timedOut?: boolean }

/** Whether a red run gets a second try: not when it never started (127) or ran out of time (a second would only wait as long again). */
export function retries(run: CheckRun): boolean {
  return run.exitCode !== 0 && run.exitCode !== 127 && !run.timedOut;
}

const ANSI = /\x1b\[[0-9;]*m/g;
/** Where a red run failed, or `undefined`: the first failing test's location (vitest `❯ file:line`,
 *  pytest `FAILED …`, `FAIL file`), else a `… failed` count. The last line alone is often just the run's duration. */
export function failureLine(tail: string): string | undefined {
  const lines = tail.replace(ANSI, '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^❯\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?:\d+/.test(l) || /^FAILED\s/.test(l) || /^FAIL\s+\S/.test(l))
    ?? lines.find((l) => /\b\d+ failed\b/.test(l));
}

/** The check's one-line summary: where it failed (else the last line), and what the retry said when there was one. */
export function checkSummary(runs: CheckRun[], roots: string[] = []): string | undefined {
  const last = runs[runs.length - 1];
  const tail = last.timedOut ? '' : outputTail(last.output, roots);
  const line = last.timedOut ? 'timed out' : (last.exitCode !== 0 ? failureLine(tail) : undefined) ?? tail.split('\n').pop();
  const note = runs.length < 2 ? '' : last.exitCode === 0
    ? `passed on a retry (first run exit ${runs[0].exitCode}) · `
    : `failed twice (exit ${runs[0].exitCode}, then exit ${last.exitCode}; retried once) · `;
  const text = `${note}${line ?? ''}`.replace(/ · $/, '').trim();
  return text ? cutText(text, MAX_SUMMARY) : undefined;
}

/** What the office's ledger keeps of one check (and the log says of a red one). */
export interface LedgerCheck { name: string; command: string; exitCode: number | null; status: string; attempts: number; firstExitCode?: number; tail?: string }
/** A head's entry in the ledger: what Canvas said, when, and the checks behind it. */
export interface LedgerEntry { outcome: string; at?: string; checks?: LedgerCheck[] }

/** A ledger entry as it was written: an older office wrote just the outcome. */
export function ledgerEntry(value: unknown): LedgerEntry | undefined {
  if (typeof value === 'string') return { outcome: value };
  if (value && typeof value === 'object' && typeof (value as LedgerEntry).outcome === 'string') return value as LedgerEntry;
  return undefined;
}

/** "tests exit 1 (2 runs): FAIL cart.test.ts", for the log and the process wall. */
export function describeFailed(checks: LedgerCheck[]): string {
  return checks.filter((c) => c.status !== 'passed').map((c) => {
    const last = c.tail ? failureLine(c.tail) ?? c.tail.split('\n').pop() : undefined;
    return `${c.name} exit ${c.exitCode}${c.attempts > 1 ? ` (${c.attempts} runs)` : ''}${last ? `: ${cutText(last, 160)}` : ''}`;
  }).join('; ');
}

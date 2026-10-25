import { execFileSync } from 'node:child_process';
import type { ExecutionLease } from './execution-client.js';
import { commitsFromLog, pinnedSteps } from './plan-steps.js';

/**
 * Resuming a card at its checkpointed steps with their code. Canvas's live `progress` says which steps an
 * earlier run already reported done (and by which execution), but a run that stopped before its result was
 * never pushed: its step commits live only on its local branch (`office/<worker>-<id>`), while the new worker's
 * worktree starts from origin's main. So before the new worker launches, the office cherry-picks the earlier
 * runs' `step <id>:` commits (the same commits its step checkpoints sent to Canvas, found the same way, from git)
 * onto the new branch, and the prompt says exactly that. When any of them can't be found, nothing is picked and
 * the prompt says so honestly: the done steps' code isn't on the branch; redo them unless main already has it.
 */

/** An earlier run of this office: its execution and the branch (and base) its worktree was on. */
export interface EarlierRun { executionId: string; branch: string; base?: string }
export interface ResumePick { sha: string; stepId: string; branch: string }
export type ResumePlan =
  | { state: 'picks'; done: string[]; resumeAt: string | null; picks: ResumePick[] }
  | { state: 'missing'; done: string[]; resumeAt: string | null; first: string; reason: string };

/** Synchronous git in `cwd`; throws on failure. */
export type GitSync = (args: string[], cwd: string) => string;
export const gitSync: GitSync = (args, cwd) => execFileSync('git', args,
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, windowsHide: true });

const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const HEX = /^[a-f0-9]{7,40}$/;

/** The plan for a claimed lease: undefined when nothing is done yet (or the card has no steps). */
export function resumePlan(lease: ExecutionLease, earlier: EarlierRun[], floorDir: string, git: GitSync = gitSync): ResumePlan | undefined {
  const progress = lease.progress;
  const steps = pinnedSteps(lease.assignment);
  if (!progress?.done || !steps.length) return undefined;
  const done = progress.steps.filter(s => s.status === 'done');
  if (!done.length) return undefined;
  const ids = done.map(s => s.id), resumeAt = progress.current;
  const first = progress.steps[0]?.id ?? steps[0].id;
  const missing = (reason: string): ResumePlan => ({ state: 'missing', done: ids, resumeAt, first, reason });
  const logs = new Map<string, { order: Map<string, number>; commits: Map<string, string[]> }>();
  const picks: (ResumePick & { at: number; group: number })[] = [];
  for (const step of done) {
    const run = step.executionId ? earlier.find(r => r.executionId === step.executionId) : undefined;
    if (!run || !BRANCH.test(run.branch)) return missing(`this office has no branch of the run that did ${step.id}`);
    let log = logs.get(run.branch);
    if (!log) {
      let text: string;
      try {
        const range = run.base && HEX.test(run.base) ? [`${run.base}..refs/heads/${run.branch}`] : [`refs/heads/${run.branch}`, '--not', '--remotes'];
        text = git(['log', '--reverse', '--max-count=500', '--format=%H%x1f%s', ...range, '--'], floorDir);
      } catch { return missing(`the earlier run's branch ${run.branch} is gone`); }
      const order = new Map(text.split(/\r?\n/).map((row, i) => [row.split('\x1f')[0].trim(), i] as const));
      log = { order, commits: commitsFromLog(text, steps) };
      logs.set(run.branch, log);
    }
    const shas = log.commits.get(step.id);
    if (!shas?.length) return missing(`no "step ${step.id}:" commit is on ${run.branch}`);
    const group = [...logs.keys()].indexOf(run.branch);
    picks.push(...shas.map(sha => ({ sha, stepId: step.id, branch: run.branch, at: log.order.get(sha) ?? 0, group })));
  }
  // Each branch's commits in the order they were made there; branches in the order their first done step comes.
  picks.sort((a, b) => a.group - b.group || a.at - b.at);
  const seen = new Set<string>();
  return { state: 'picks', done: ids, resumeAt,
    picks: picks.filter(p => !seen.has(p.sha) && !!seen.add(p.sha)).map(({ sha, stepId, branch }) => ({ sha, stepId, branch })) };
}

/** Cherry-picks the plan's commits onto the worktree at `dir`; on any conflict it's all undone and the reason given. */
export function applyResume(dir: string, plan: ResumePlan, git: GitSync = gitSync): { ok: true } | { ok: false; reason: string } {
  if (plan.state !== 'picks' || !plan.picks.length) return { ok: true };
  try {
    git(['cherry-pick', '--keep-redundant-commits', ...plan.picks.map(p => p.sha)], dir);
    return { ok: true };
  } catch (error) {
    try { git(['cherry-pick', '--abort'], dir); } catch { /* nothing to abort */ }
    const why = String((error as { stderr?: unknown }).stderr ?? (error as Error).message).split(/\r?\n/).find(l => /^(error|fatal|CONFLICT)/.test(l));
    return { ok: false, reason: why?.slice(0, 200) ?? 'git cherry-pick failed' };
  }
}

/** The prompt's resume lines, saying what is (or isn't) on the worker's branch; '' when nothing is done yet. */
export function resumeBrief(plan: ResumePlan | undefined): string {
  if (!plan) return '';
  const list = plan.done.join(', ');
  if (plan.state === 'picks') {
    const from = [...new Set(plan.picks.map(p => p.branch))].join(', ');
    const commits = plan.picks.map(p => `${p.stepId} ${p.sha.slice(0, 12)}`).join(', ');
    const where = `The office cherry-picked that work onto your branch before you started (${commits}, from ${from}); confirm with git log.`;
    const fallback = `If those commits aren't on your branch, the pick failed: redo the steps from ${plan.done[0]} and report each one.`;
    if (!plan.resumeAt) return `Progress: an earlier run already reported every step done (${list}). ${where} Verify the work, don't redo it. ${fallback}`;
    return `Progress: an earlier run already reported ${plan.done.length} step${plan.done.length === 1 ? '' : 's'} done (${list}). ${where} Resume at step ${plan.resumeAt}: don't redo the done steps, and you may leave them out of stepResults. ${fallback}`;
  }
  return `Progress: an earlier run reported ${list} done, but their commits are not on your branch (${plan.reason}); your worktree starts from main. Check git log: if main already has that work, resume at step ${plan.resumeAt ?? plan.first}; otherwise redo from step ${plan.first} and report every step.`;
}

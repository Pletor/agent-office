/**
 * Plan steps (Canvas's docs/oporahub-plan-steps.md): the accepted `spec.steps` of a card are pinned in
 * the execution's immutable `assignment.steps`. The worker works them one by one, one commit per step
 * (`step <id>: <title>`), and reports `stepResults` in its result. This module renders the checklist
 * the prompt carries, validates `stepResults` exactly as Canvas does (backend/canvas/opora_step_results.py)
 * and replaces the commit SHAs the agent claims with the ones git says, parsed from the commit
 * messages. A card without steps (a legacy assignment) gets none of this: the old prompt and result.
 */

export interface PlanStep {
  id: string; order: number; title: string; acceptance: string[]; dependsOn: string[];
  kind?: string; files?: string[];
}
export type StepStatus = 'done' | 'failed' | 'skipped';
interface StepResult { stepId: string; status: StepStatus; evidence: { notes: string; checks?: string[]; commits?: string[] } }
/** Step id → the commits made for it, oldest first. */
export type StepCommits = Map<string, string[]>;

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const SHA = /^[a-f0-9]{7,40}$/;
const STATUSES = new Set(['done', 'failed', 'skipped']);
const EVIDENCE = new Set(['checks', 'commits', 'notes']);
const MAX_LIST = 50;
/** A commit subject that names its step: `step s2: API` (git am drops the `[PATCH n/m]` prefix; a patch keeps it). */
const SUBJECT = /^(?:\[PATCH[^\]]*\]\s*)?step ([A-Za-z0-9_-]{1,40}):/i;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

/** The steps pinned in an assignment, in topological order (by `order`, which Canvas keeps consistent with it); [] for a legacy one. */
export function pinnedSteps(assignment: unknown): PlanStep[] {
  if (!isObject(assignment) || !Array.isArray(assignment.steps)) return [];
  const steps: PlanStep[] = [];
  for (const raw of assignment.steps) {
    if (!isObject(raw) || typeof raw.id !== 'string' || !ID.test(raw.id) || typeof raw.title !== 'string') continue;
    steps.push({ id: raw.id, order: Number.isFinite(raw.order) ? Number(raw.order) : steps.length + 1, title: raw.title,
      acceptance: strings(raw.acceptance), dependsOn: strings(raw.dependsOn),
      ...(typeof raw.kind === 'string' ? { kind: raw.kind } : {}), ...(Array.isArray(raw.files) ? { files: strings(raw.files) } : {}) });
  }
  return steps.sort((a, b) => a.order - b.order);
}

const line = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The prompt's checklist and protocol for a card with steps; '' for a legacy card. */
export function stepChecklist(steps: PlanStep[], commitHint = 'in the worktree'): string {
  if (!steps.length) return '';
  const items = steps.map((s, i) => [
    `${i + 1}. [${s.id}] ${line(s.title)}${s.kind ? ` (${s.kind})` : ''}`,
    `   depends on: ${s.dependsOn.length ? s.dependsOn.join(', ') : 'nothing'}`,
    `   files: ${s.files?.length ? s.files.join(', ') : 'not limited'}`,
    ...s.acceptance.map(a => `   acceptance: ${line(a)}`),
  ].join('\n'));
  return `Plan steps (accepted, pinned in the assignment; work them strictly in this order):
${items.join('\n')}
Step protocol:
- Work strictly step by step in the order above; start a step only when every step it depends on is done.
- Make exactly one commit per step ${commitHint}, with the message "step <id>: <title>" (for example "step ${steps[0].id}: ${line(steps[0].title)}"). Office reads the commit SHAs from these messages; you don't report them.
- Before moving on, verify the step's acceptance: run the relevant tests or checks and keep their command and last output line.
- If a step's acceptance can't be met, stop there and report that step "failed" with the reason in its notes, and the steps after it "skipped". Don't improvise around it.
- Don't edit files outside the step's globs; if you must, say which and why in that step's notes.
- Report every step in result.stepResults: [{"stepId":"${steps[0].id}","status":"done|failed|skipped","evidence":{"notes":"what you did (required)","checks":["npm test: exit 0, 42 passing"]}}] (no other keys; each "checks" entry is one check you ran for that step, its command and outcome, at most 500 characters).`;
}

/** The `stepResults` problem Canvas would refuse the result for, or undefined when it would take them (mirrors validate_step_results). */
export function stepResultsProblem(value: unknown, steps: PlanStep[]): string | undefined {
  if (!Array.isArray(value) || value.length > steps.length) return 'stepResults must be a list with at most one item per pinned step';
  const known = new Set(steps.map(s => s.id)), seen = new Set<string>();
  for (const item of value) {
    if (!isObject(item) || Object.keys(item).length !== 3 || !('stepId' in item && 'status' in item && 'evidence' in item))
      return 'each stepResults item needs exactly stepId, status and evidence';
    if (typeof item.stepId !== 'string' || !known.has(item.stepId) || seen.has(item.stepId))
      return `stepResults names a step outside the pinned plan or twice (${String(item.stepId)})`;
    seen.add(item.stepId);
    if (typeof item.status !== 'string' || !STATUSES.has(item.status)) return `step ${item.stepId}: status is done, failed or skipped`;
    const evidence = item.evidence;
    if (!isObject(evidence) || !('notes' in evidence) || Object.keys(evidence).some(k => !EVIDENCE.has(k)))
      return `step ${item.stepId}: evidence needs notes (and optionally checks, commits)`;
    if (typeof evidence.notes !== 'string' || evidence.notes.length > 4000 || evidence.notes.includes('\0'))
      return `step ${item.stepId}: notes is text of at most 4000 characters`;
    if ('checks' in evidence && !(Array.isArray(evidence.checks) && evidence.checks.length <= MAX_LIST
      && evidence.checks.every(c => typeof c === 'string' && c.length > 0 && c.length <= 500)))
      return `step ${item.stepId}: checks is a list of at most ${MAX_LIST} texts of 1-500 characters`;
    if ('commits' in evidence && !(Array.isArray(evidence.commits) && evidence.commits.length <= MAX_LIST
      && evidence.commits.every(c => typeof c === 'string' && SHA.test(c))))
      return `step ${item.stepId}: commits is a list of at most ${MAX_LIST} SHAs`;
  }
  return undefined;
}

/** Step commits from `git log --reverse --format=%H%x1f%s` output (oldest first), for the pinned step ids only. */
export function commitsFromLog(log: string, steps: PlanStep[]): StepCommits {
  const known = new Set(steps.map(s => s.id)), out: StepCommits = new Map();
  for (const row of log.split(/\r?\n/)) {
    const [sha, subject = ''] = row.split('\x1f');
    const id = SUBJECT.exec(subject.trim())?.[1];
    if (!/^[a-f0-9]{40}$/.test(sha?.trim() ?? '') || !id || !known.has(id)) continue;
    out.set(id, [...(out.get(id) ?? []), sha.trim()]);
  }
  return out;
}

/** Step commits from a `git format-patch --stdout` mailbox: each `From <sha>` line with its `Subject:`. */
export function commitsFromPatch(patch: string, steps: PlanStep[]): StepCommits {
  const rows: string[] = [];
  let sha: string | undefined;
  for (const text of patch.split(/\r?\n/)) {
    const from = /^From ([a-f0-9]{40}) /.exec(text);
    if (from) { sha = from[1]; continue; }
    const subject = /^Subject: (.*)$/.exec(text);
    if (sha && subject) { rows.push(`${sha}\x1f${subject[1]}`); sha = undefined; }
  }
  return commitsFromLog(rows.join('\n'), steps);
}

/**
 * The result as Canvas gets it: legacy card → `stepResults` dropped (Canvas takes none without pinned
 * steps); otherwise each step's `evidence.commits` replaced by the commits git found for it (removed
 * when there are none), then validated. `problem` says why Canvas would refuse them.
 */
export function withStepCommits(result: Record<string, unknown>, steps: PlanStep[], commits: StepCommits):
  { result: Record<string, unknown>; problem?: string } {
  if (!('stepResults' in result)) return { result };
  const { stepResults, ...rest } = result;
  if (!steps.length) return { result: rest };
  const items = Array.isArray(stepResults) ? stepResults.map(item => {
    if (!isObject(item) || !isObject(item.evidence) || typeof item.stepId !== 'string') return item;
    const { commits: _claimed, ...evidence } = item.evidence;
    const found = (commits.get(item.stepId) ?? []).slice(-MAX_LIST);
    return { ...item, evidence: found.length ? { ...evidence, commits: found } : evidence };
  }) : stepResults;
  return { result: { ...rest, stepResults: items }, problem: stepResultsProblem(items, steps) };
}

/** The PR body's "Kroky plánu" lines: every pinned step with its reported status and the PR's commits for it. */
export function stepsSection(steps: PlanStep[], stepResults: unknown, commits: StepCommits): string | undefined {
  if (!steps.length) return undefined;
  const reported = new Map<string, Record<string, unknown>>();
  if (Array.isArray(stepResults)) for (const item of stepResults) if (isObject(item) && typeof item.stepId === 'string') reported.set(item.stepId, item);
  return steps.map(s => {
    const item = reported.get(s.id);
    const status = typeof item?.status === 'string' ? item.status : 'not reported';
    const shas = (commits.get(s.id) ?? []).map(sha => `\`${sha.slice(0, 12)}\``);
    const checks = isObject(item?.evidence) ? strings(item.evidence.checks).slice(0, 5).map(c => line(c).slice(0, 200).replaceAll('`', "'")) : [];
    return [`- \`${s.id}\` ${line(s.title).slice(0, 200)}: **${status}**${shas.length ? ` (${shas.join(', ')})` : ' (no commit)'}`,
      ...checks.map(c => `  - \`${c}\``)].join('\n');
  }).join('\n');
}

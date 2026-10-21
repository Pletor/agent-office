import path from 'node:path';
import type { ReviewAgent } from './review-agent.js';
import { prepareCheckout, type Checkout, type Git } from './review-checkout.js';
import type { Candidate, ReviewAssignment, ReviewJob, Severity } from './review-client.js';
import { reviewPrompts, type PromptVariant, type ReviewKind, type ReviewPrompts } from './review-kinds.js';
import { checkFinder, checkVoter, parseAnswer, type FinderSubmission } from './review-output.js';
import { finderPrompt, voterPrompt } from './review-prompt.js';

/**
 * The reviewer eval (Canvas's docs/oporahub-review-identity.md, "Jak eval spustit"): every revert and
 * incident Canvas recorded is a case. Each case is replayed through the same finder → voter pipeline
 * the review workers run (the same prompts, answer checks and fingerprints), every slot a fresh model
 * context in a fresh checkout at the case's head, without seeing the case's recorded findings. It
 * scores recall (did a confirmed finding touch what the revert changed, or what the incident names?)
 * and noise (confirmed findings that touched none of it). A prompt variant is kept only when its score
 * goes up and its recall doesn't go down. Model runs are budgeted, and nothing is written to Canvas.
 */

export interface EvalFinding { fingerprint?: string; severity?: string; status?: string; round?: number; path?: string; line?: number | null; title?: string }
export interface EvalCase {
  schemaVersion: 1; caseId: string; kind: 'revert' | 'incident'; repository: string; number: number; workspace?: string;
  diffRef?: { base?: string | null; head?: string; range?: string; url?: string };
  baseSha: string | null; headSha: string; mergeSha?: string | null; revertSha?: string | null; revertNumber?: number | null;
  incident?: { reference?: string; summary?: string } | null; rounds?: number; findings?: EvalFinding[]; rejectedFingerprints?: string[];
}
export interface EvalOptions {
  kind: ReviewKind; finders: number; voters: number; requiredVotes: number;
  maxCases: number; maxRuns: number; noiseWeight: number;
}
export interface ConfirmedFinding { fingerprint: string; path: string; line?: number; severity: Severity; title: string; votes: number; touches: 'line' | 'file' | 'incident' | null }
export interface CaseResult {
  caseId: string; kind: EvalCase['kind']; status: 'scored' | 'unscorable' | 'skipped' | 'error'; reason?: string;
  targets: { files: string[]; ranges: Record<string, [number, number][]> };
  confirmed: ConfirmedFinding[]; rejected: number; invalidAnswers: number;
  caught: boolean; caughtLine: boolean; noisy: number; priorKept?: number; priorTotal?: number; modelRuns: number;
}
export interface VariantReport {
  label: string; cases: CaseResult[];
  totals: { cases: number; scored: number; caught: number; caughtLine: number; recall: number | null; lineRecall: number | null;
    confirmed: number; noisy: number; noiseRate: number | null; noisePerCase: number | null; modelRuns: number };
  score: number | null;
}
export interface EvalReport {
  generatedAt: string; options: EvalOptions; source: string; caseCount: number;
  baseline?: VariantReport; variant?: VariantReport;
  decision?: { keep: boolean; reason: string; baselineScore: number | null; variantScore: number | null };
  budget: { maxRuns: number; used: number; exhausted: boolean };
}
export interface EvalDeps { git: Git; agent: ReviewAgent; repo: string; root: string; now?: () => Date }

const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** The export's JSONL, one case per line; lines that aren't a well-formed case are dropped and counted. */
export function parseCases(jsonl: string): { cases: EvalCase[]; dropped: number } {
  const cases: EvalCase[] = [];
  let dropped = 0;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let c: EvalCase;
    try { c = JSON.parse(line) as EvalCase; } catch { dropped++; continue; }
    const ok = c && c.schemaVersion === 1 && typeof c.caseId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(c.caseId)
      && (c.kind === 'revert' || c.kind === 'incident') && REPO.test(c.repository) && Number.isSafeInteger(c.number) && c.number > 0
      && SHA.test(c.headSha) && (c.baseSha === null || SHA.test(c.baseSha)) && (c.revertSha == null || SHA.test(c.revertSha));
    if (ok && !cases.some((x) => x.caseId === c.caseId)) cases.push(c); else dropped++;
  }
  return { cases, dropped };
}

/** GET …/review-evals/export.jsonl as the office's agent (an agent identity is enough). */
export async function fetchCases(base: string, agent: string, scope: { project: string; workspace?: string }, transport: typeof fetch = fetch): Promise<string> {
  const url = new URL('/api/oporahub/review-evals/export.jsonl', base);
  url.searchParams.set('project', scope.project);
  if (scope.workspace) url.searchParams.set('workspace', scope.workspace);
  const response = await transport(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Accept: 'application/x-ndjson, application/json', Origin: new URL(base).origin, 'X-Opora-Actor': `agent; name=${agent}` } });
  if (!response.ok) throw new Error(`Canvas refused the eval export (${response.status})`);
  return response.text();
}

/** What a revert changed, on the reverted side (`revertSha^`): files and the line ranges the bad change had there. */
export function revertTargets(unifiedZeroDiff: string): CaseResult['targets'] {
  const files: string[] = [];
  const ranges: Record<string, [number, number][]> = {};
  let current: string | undefined;
  for (const line of unifiedZeroDiff.split(/\r?\n/)) {
    const file = /^--- (?:a\/(.+)|\/dev\/null)$/.exec(line);
    if (file) { current = file[1]; if (current && !files.includes(current)) files.push(current); continue; }
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus && !current) { current = plus[1]; if (!files.includes(current)) files.push(current); continue; }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]), count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      (ranges[current] ??= []).push([start, start + Math.max(count, 1) - 1]);
    }
  }
  return { files, ranges };
}

const NEAR = 3;
function touches(f: { path: string; line?: number }, c: EvalCase, t: CaseResult['targets']): ConfirmedFinding['touches'] {
  if (t.files.includes(f.path)) {
    const hit = f.line !== undefined && (t.ranges[f.path] ?? []).some(([a, b]) => f.line! >= a - NEAR && f.line! <= b + NEAR);
    return hit ? 'line' : 'file';
  }
  if (c.kind === 'incident') {
    const text = `${c.incident?.reference ?? ''}\n${c.incident?.summary ?? ''}`;
    if (text.includes(f.path) || text.includes(path.posix.basename(f.path))) return 'incident';
  }
  return null;
}

/** Model runs left, across every case and variant of one eval. */
export class RunBudget {
  used = 0;
  constructor(readonly max: number) {}
  get left() { return this.max - this.used; }
  take(n = 1): boolean { if (this.left < n) return false; this.used += n; return true; }
}

const evalJob = (c: EvalCase, kind: ReviewKind): ReviewJob => ({ reviewJobId: `eval-${c.caseId}`.slice(0, 120).replace(/[^A-Za-z0-9._-]/g, '-'),
  repository: c.repository, number: c.number, baseSha: c.baseSha, headSha: c.headSha, round: 1, sinceSha: null, phase: 'find', kind });
const assignment = (job: ReviewJob, role: 'finder' | 'voter', slot: number, candidates?: Candidate[]): ReviewAssignment => ({
  reviewJobId: job.reviewJobId, taskId: `eval-${role}-${slot}`, role, slot, token: '', epoch: 1, expiresAt: 0, serverNow: 0,
  job: { ...job, phase: role === 'finder' ? 'find' : 'vote' }, knownFindings: [], ...(candidates ? { candidates } : {}) });
const RANK: Record<Severity, number> = { important: 3, pre_existing: 2, nit: 1 };

async function ask(deps: EvalDeps, cwd: string, system: string, prompt: string): Promise<unknown> {
  // Every slot is its own model run with no session: a fresh context, as in review-slot.ts.
  const text = await deps.agent({ cwd, system, prompt, signal: AbortSignal.timeout(60 * 60_000) });
  return parseAnswer(text);
}

/** One case through finders and voters with one set of prompts, scored. The caller has reserved the runs. */
async function replay(c: EvalCase, prompts: ReviewPrompts, o: EvalOptions, deps: EvalDeps, checkout: Checkout, targets: CaseResult['targets']): Promise<CaseResult> {
  const job = evalJob(c, prompts.kind);
  let runs = 0, invalid = 0;
  const groups = new Map<string, { f: FinderSubmission['findings'][number]; finders: number[] }>();
  for (let slot = 0; slot < o.finders; slot++) {
    const a = assignment(job, 'finder', slot);
    runs++;
    let checked;
    try { checked = checkFinder(await ask(deps, checkout.dir, prompts.finder, finderPrompt(a, checkout)), [], prompts.fingerprintPrefix); } catch { checked = { ok: false as const, errors: [] }; }
    if (!checked.ok) { invalid++; continue; }
    for (const f of checked.value.findings) {
      const g = groups.get(f.fingerprint);
      if (!g) groups.set(f.fingerprint, { f, finders: [slot] });
      else { g.finders.push(slot); if (RANK[f.severity] > RANK[g.f.severity]) g.f = { ...g.f, severity: f.severity }; }
    }
  }
  const candidates: Candidate[] = [...groups.values()].map((g, i) => ({ candidateId: `ec_${i}`, kind: 'finding', fingerprint: g.f.fingerprint, path: g.f.path,
    line: g.f.line ?? null, severity: g.f.severity, title: g.f.title, rationale: g.f.rationale, finders: g.finders }));
  const confirms = new Map<string, number>();
  if (candidates.length) for (let slot = 0; slot < o.voters; slot++) {
    const a = assignment(job, 'voter', slot, candidates);
    runs++;
    let checked;
    try { checked = checkVoter(await ask(deps, checkout.dir, prompts.voter, voterPrompt(a, checkout)), candidates); } catch { checked = { ok: false as const, errors: [] }; }
    if (!checked.ok) { invalid++; continue; }
    for (const v of checked.value.votes) if (v.verdict === 'confirm') confirms.set(v.candidateId, (confirms.get(v.candidateId) ?? 0) + 1);
  }
  const confirmed: ConfirmedFinding[] = [];
  let rejected = 0;
  for (const cand of candidates) {
    const votes = confirms.get(cand.candidateId) ?? 0;
    if (votes < o.requiredVotes) { rejected++; continue; }
    const f = { path: cand.path!, ...(typeof cand.line === 'number' ? { line: cand.line } : {}) };
    confirmed.push({ fingerprint: cand.fingerprint!, ...f, severity: cand.severity!, title: cand.title!, votes, touches: touches(f, c, targets) });
  }
  const scorable = targets.files.length > 0 || (c.kind === 'incident' && !!(c.incident?.summary || c.incident?.reference));
  const prior = (c.findings ?? []).filter((p) => p.path);
  const priorKept = prior.filter((p) => confirmed.some((f) => f.path === p.path && (p.line == null || f.line === undefined || Math.abs(f.line - p.line) <= 5))).length;
  return {
    caseId: c.caseId, kind: c.kind, status: scorable ? 'scored' : 'unscorable', ...(scorable ? {} : { reason: 'nothing to score against: no revert diff and no incident text' }),
    targets, confirmed, rejected, invalidAnswers: invalid,
    caught: confirmed.some((f) => f.touches !== null), caughtLine: confirmed.some((f) => f.touches === 'line'),
    noisy: confirmed.filter((f) => f.touches === null).length, ...(prior.length ? { priorKept, priorTotal: prior.length } : {}), modelRuns: runs,
  };
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
export function summarize(label: string, cases: CaseResult[], noiseWeight: number): VariantReport {
  const scored = cases.filter((c) => c.status === 'scored');
  const caught = scored.filter((c) => c.caught).length, caughtLine = scored.filter((c) => c.caughtLine).length;
  const confirmed = scored.reduce((n, c) => n + c.confirmed.length, 0), noisy = scored.reduce((n, c) => n + c.noisy, 0);
  const recall = scored.length ? round4(caught / scored.length) : null;
  const noisePerCase = scored.length ? round4(noisy / scored.length) : null;
  return {
    label, cases,
    totals: { cases: cases.length, scored: scored.length, caught, caughtLine, recall, lineRecall: scored.length ? round4(caughtLine / scored.length) : null,
      confirmed, noisy, noiseRate: confirmed ? round4(noisy / confirmed) : null, noisePerCase, modelRuns: cases.reduce((n, c) => n + c.modelRuns, 0) },
    // Recall first; each noisy confirmed finding per case costs `noiseWeight`.
    score: recall === null ? null : round4(recall - noiseWeight * (noisePerCase ?? 0)),
  };
}

/** Keep the variant only if its score goes up and its recall doesn't go down (Canvas: "nesmí klesnout"). */
export function decide(baseline: Pick<VariantReport, 'score' | 'totals'>, variant: Pick<VariantReport, 'score' | 'totals'>): NonNullable<EvalReport['decision']> {
  const b = baseline.score, v = variant.score;
  const out = (keep: boolean, reason: string) => ({ keep, reason, baselineScore: b, variantScore: v });
  if (v === null || b === null) return out(false, 'no scored case on one side: nothing to compare');
  if ((variant.totals.recall ?? 0) < (baseline.totals.recall ?? 0)) return out(false, `recall went down (${baseline.totals.recall} → ${variant.totals.recall})`);
  if (v <= b) return out(false, `score did not go up (${b} → ${v})`);
  return out(true, `score went up (${b} → ${v})`);
}

async function targetsOf(c: EvalCase, deps: EvalDeps): Promise<CaseResult['targets']> {
  if (!c.revertSha) return { files: [], ranges: {} };
  const has = async (sha: string) => deps.git(['cat-file', '-e', `${sha}^{commit}`], deps.repo).then(() => true, () => false);
  if (!(await has(c.revertSha))) {
    if (c.revertNumber) await deps.git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/pull/${c.revertNumber}/head:refs/opora-eval/pr-${c.revertNumber}`], deps.repo).catch(() => '');
    if (!(await has(c.revertSha))) await deps.git(['fetch', '--no-tags', '--quiet', '--depth=2', 'origin', c.revertSha], deps.repo).catch(() => '');
  }
  return revertTargets(await deps.git(['diff', '--no-color', '--no-ext-diff', '--unified=0', `${c.revertSha}^`, c.revertSha], deps.repo));
}

/**
 * Runs the eval: the current prompts as the baseline and, given a variant, the variant on the very
 * same cases (each case in a fresh checkout per side), and decides. A case starts only if the budget
 * still holds every run it could need on both sides; the rest are reported as skipped.
 */
export async function runEval(cases: EvalCase[], o: EvalOptions, deps: EvalDeps,
  opts: { variant?: PromptVariant; source: string; baselineOnly?: boolean; priorBaseline?: VariantReport } = { source: 'export' }): Promise<EvalReport> {
  const budget = new RunBudget(o.maxRuns);
  const basePrompts = reviewPrompts(o.kind)!;
  const variantPrompts = opts.variant ? reviewPrompts(o.kind, opts.variant)! : undefined;
  const sides: { label: 'baseline' | 'variant'; prompts: ReviewPrompts }[] = [
    ...(opts.priorBaseline ? [] : [{ label: 'baseline' as const, prompts: basePrompts }]),
    ...(variantPrompts ? [{ label: 'variant' as const, prompts: variantPrompts }] : []),
  ];
  const results: Record<'baseline' | 'variant', CaseResult[]> = { baseline: [], variant: [] };
  const perCase = (o.finders + o.voters) * sides.length;
  let exhausted = false;
  for (const c of cases.slice(0, o.maxCases)) {
    const skip = (reason: string, status: CaseResult['status'] = 'skipped') => sides.forEach((s) => results[s.label].push({ caseId: c.caseId, kind: c.kind, status, reason,
      targets: { files: [], ranges: {} }, confirmed: [], rejected: 0, invalidAnswers: 0, caught: false, caughtLine: false, noisy: 0, modelRuns: 0 }));
    if (!budget.take(perCase)) { exhausted = true; skip('model-run budget exhausted'); continue; }
    let targets: CaseResult['targets'];
    try { targets = await targetsOf(c, deps); } catch (error) { budget.used -= perCase; skip(`revert diff unreadable: ${(error as Error).message.slice(0, 200)}`, 'error'); continue; }
    let spent = 0;
    for (const side of sides) {
      let checkout: Checkout | undefined;
      try {
        checkout = await prepareCheckout(deps.git, deps.repo, path.join(deps.root, 'checkouts'), evalJob(c, o.kind), `${side.label}-${c.caseId}`);
        const r = await replay(c, side.prompts, o, deps, checkout, targets);
        spent += r.modelRuns;
        results[side.label].push(r);
      } catch (error) {
        results[side.label].push({ caseId: c.caseId, kind: c.kind, status: 'error', reason: (error as Error).message.slice(0, 300), targets, confirmed: [],
          rejected: 0, invalidAnswers: 0, caught: false, caughtLine: false, noisy: 0, modelRuns: 0 });
      } finally { await checkout?.cleanup().catch(() => undefined); }
    }
    budget.used -= perCase - spent; // Give back what the case didn't use (no candidates: no voters).
  }
  const report: EvalReport = {
    generatedAt: (deps.now?.() ?? new Date()).toISOString(), options: o, source: opts.source, caseCount: cases.length,
    budget: { maxRuns: o.maxRuns, used: budget.used, exhausted },
  };
  const baseline = opts.priorBaseline ?? (sides.some((s) => s.label === 'baseline') ? summarize('baseline', results.baseline, o.noiseWeight) : undefined);
  if (baseline) report.baseline = baseline;
  if (variantPrompts) {
    report.variant = summarize('variant', results.variant, o.noiseWeight);
    if (baseline) report.decision = decide(baseline, report.variant);
  }
  return report;
}

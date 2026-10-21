import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { childEnv } from '../workers/env.js';
import { resolveCommand } from '../workers/process.js';
import { claudeReviewAgent, type ReviewAgent } from './review-agent.js';
import { fetchCases, parseCases, runEval, type EvalOptions, type VariantReport } from './review-eval.js';
import type { PromptVariant } from './review-kinds.js';

/**
 * `npm run opora:review-eval -- --project <id> [options]`: pulls Canvas's reviewer eval set, replays
 * it through the review prompts (review-eval.ts) and writes a JSON report. With `--variant <file>` it
 * replays the same cases with the variant's prompts too and says whether to keep it; the exit code is
 * 2 when the variant should not be kept. `--dry-run` answers every slot with "no findings" instead of
 * running a model, to check the plumbing (export, checkouts, revert diffs) without spending anything.
 */

const USAGE = `Usage: npm run opora:review-eval -- --project <id> [--workspace <id>] [options]
  --base <url>            Canvas (default AGENT_OFFICE_OPORA_URL or http://127.0.0.1:8740)
  --cases <file.jsonl>    read cases from a file instead of Canvas's export
  --repo <dir>            the project's checkout (default: current directory)
  --kind code|security    which prompts to evaluate (default code)
  --variant <file.json>   prompts to try: {"finder": "...", "voter": "..."} or {"code": {...}, "security": {...}}
  --baseline-report <f>   compare the variant against this earlier report's baseline instead of re-running it
  --finders 3 --voters 3 --required-votes 2
  --max-cases 20          cases to replay
  --max-runs 60           model runs in all (finders + voters, both sides)
  --noise-weight 0.1      score = recall - weight * noisy confirmed findings per case
  --model <name>          Claude Code model (default AGENT_OFFICE_OPORA_REVIEW_MODEL)
  --timeout-min 20        per model run
  --out <file.json>       the report (default .agent-office/opora-review-evals/report-<time>.json)
  --dry-run               no model runs: every slot answers "no findings"`;

const int = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : d;
};

/** A fake agent: no findings, and a reject for every candidate (there are none without findings). */
export const dryRunAgent: ReviewAgent = async ({ prompt }) => prompt.includes('Candidates to verify') ? '{"votes":[]}' : '{"findings":[],"fixed":[]}';

export function readVariant(file: string): PromptVariant {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const pick = (v: unknown) => {
    const o = (v ?? {}) as Record<string, unknown>;
    return { ...(typeof o.finder === 'string' && o.finder.trim() ? { finder: o.finder } : {}), ...(typeof o.voter === 'string' && o.voter.trim() ? { voter: o.voter } : {}) };
  };
  const variant: PromptVariant = raw.code || raw.security ? { ...(raw.code ? { code: pick(raw.code) } : {}), ...(raw.security ? { security: pick(raw.security) } : {}) } : { code: pick(raw), security: pick(raw) };
  if (!Object.values(variant).some((p) => p && (p.finder || p.voter))) throw new Error(`${file} has no finder or voter prompt`);
  return variant;
}

export async function main(argv: string[], io: { log(s: string): void; error(s: string): void } = console): Promise<number> {
  const { values: a } = parseArgs({ args: argv, options: {
    project: { type: 'string' }, workspace: { type: 'string' }, base: { type: 'string' }, cases: { type: 'string' }, repo: { type: 'string' },
    kind: { type: 'string' }, variant: { type: 'string' }, 'baseline-report': { type: 'string' }, finders: { type: 'string' }, voters: { type: 'string' },
    'required-votes': { type: 'string' }, 'max-cases': { type: 'string' }, 'max-runs': { type: 'string' }, 'noise-weight': { type: 'string' },
    model: { type: 'string' }, 'timeout-min': { type: 'string' }, out: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (a.help || (!a.project && !a.cases)) { io.log(USAGE); return a.help ? 0 : 1; }
  const kind = a.kind === 'security' ? 'security' : 'code';
  const finders = int(a.finders, 3, 1, 8), voters = int(a.voters, 3, 1, 8);
  const o: EvalOptions = { kind, finders, voters, requiredVotes: int(a['required-votes'], 2, 1, voters),
    maxCases: int(a['max-cases'], 20, 1, 500), maxRuns: int(a['max-runs'], 60, 1, 5000), noiseWeight: Math.max(0, Number(a['noise-weight'] ?? 0.1) || 0) };
  const repo = path.resolve(a.repo ?? process.cwd());
  const base = a.base ?? process.env.AGENT_OFFICE_OPORA_URL ?? 'http://127.0.0.1:8740';
  const text = a.cases ? readFileSync(a.cases, 'utf8') : await fetchCases(base, 'office-review-eval', { project: a.project!, ...(a.workspace ? { workspace: a.workspace } : {}) });
  const { cases, dropped } = parseCases(text);
  if (dropped) io.error(`${dropped} line(s) of the export were not well-formed cases and were left out`);
  let agent = dryRunAgent;
  if (!a['dry-run']) {
    const claude = resolveCommand('claude');
    if (!claude) { io.error('the claude CLI is not installed (use --dry-run to check the plumbing)'); return 1; }
    agent = claudeReviewAgent(claude, childEnv(), int(a['timeout-min'], 20, 1, 120) * 60_000, a.model ?? process.env.AGENT_OFFICE_OPORA_REVIEW_MODEL ?? undefined);
  }
  const git = (args: string[], cwd: string) => new Promise<string>((resolve, reject) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
    (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n').slice(-2).join(' ') || 'git failed')) : resolve(stdout))));
  const root = path.join(repo, '.agent-office', 'opora-review-evals');
  const priorBaseline = a['baseline-report'] ? (JSON.parse(readFileSync(a['baseline-report'], 'utf8')) as { baseline?: VariantReport }).baseline : undefined;
  if (a['baseline-report'] && !priorBaseline) { io.error(`${a['baseline-report']} has no baseline to compare against`); return 1; }
  const report = await runEval(cases, o, { git, agent, repo, root }, {
    source: a.cases ? `file:${path.basename(a.cases)}` : `${base} export${a['dry-run'] ? ' (dry run)' : ''}`,
    ...(a.variant ? { variant: readVariant(a.variant) } : {}), ...(priorBaseline ? { priorBaseline } : {}),
  });
  const out = path.resolve(a.out ?? path.join(root, `report-${report.generatedAt.replace(/[:.]/g, '-')}.json`));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  const line = (r?: VariantReport) => r ? `${r.label}: recall ${r.totals.recall ?? '-'} (line ${r.totals.lineRecall ?? '-'}), noise ${r.totals.noisy}/${r.totals.confirmed}, score ${r.score ?? '-'}, ${r.totals.scored}/${r.totals.cases} cases scored` : '';
  for (const r of [report.baseline, report.variant]) if (r) io.log(line(r));
  io.log(`model runs ${report.budget.used}/${report.budget.maxRuns}${report.budget.exhausted ? ' (budget exhausted)' : ''}; report: ${out}`);
  if (report.decision) io.log(`${report.decision.keep ? 'KEEP' : 'DROP'} the variant: ${report.decision.reason}`);
  return report.decision && !report.decision.keep ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => { console.error((error as Error).message); process.exitCode = 1; });
}

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KnownFinding, ReviewJob } from './review-client.js';

/**
 * A completed review job, posted to its pull request through `gh` without an LLM: one review of
 * event COMMENT (never APPROVE, never REQUEST_CHANGES, never a merge) whose body lists the round's
 * findings, each tagged with its severity and finding id, and an inline comment for each that has a
 * path and a line. A marker in the body makes it idempotent: a job already posted has its review's
 * body updated in place instead of a second review.
 */

/** Runs `gh` with these arguments and resolves to its stdout. */
export type Gh = (args: string[]) => Promise<string>;
export type PostOutcome = 'posted' | 'updated' | 'unchanged';

export const reviewMarker = (jobId: string) => `<!-- opora-review-job:${jobId} -->`;
const short = (sha: string) => sha.slice(0, 12);
const clip = (s: string | undefined, n: number) => (s ?? '').length > n ? `${(s ?? '').slice(0, n - 1)}…` : (s ?? '');
/** Text from a model in markdown: no HTML comments (no fake markers), no mentions that ping people. */
const safe = (s: string | undefined, n: number) => clip(s, n).replace(/<!--|-->/g, '').replace(/@(?=[A-Za-z0-9-])/g, '@​');
/** A security job's findings say so on GitHub (Canvas's "Zveřejnění"). */
const tag = (f: KnownFinding, job: ReviewJob) => `**[${job.kind === 'security' ? 'security · ' : ''}${f.severity}]** \`${f.findingId}\``;

/** The round's own findings, worst first, then by path and line, so the same job is the same body. */
export function roundFindings(job: ReviewJob, findings: KnownFinding[]): KnownFinding[] {
  const rank: Record<string, number> = { important: 0, pre_existing: 1, nit: 2 };
  return findings.filter((f) => f.reviewJobId === job.reviewJobId)
    .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || (a.path ?? '').localeCompare(b.path ?? '') || (a.line ?? 0) - (b.line ?? 0) || a.findingId.localeCompare(b.findingId));
}

export function reviewBody(job: ReviewJob, findings: KnownFinding[]): string {
  const mine = roundFindings(job, findings);
  const lines = [
    reviewMarker(job.reviewJobId),
    `### ${job.kind === 'security' ? '🔒 Opora automated security review' : '🔎 Opora automated review'}: round ${job.round} at \`${short(job.headSha)}\``,
    '',
    `Review job \`${job.reviewJobId}\`${job.sinceSha ? `, changes since \`${short(job.sinceSha)}\`` : ''}. Findings were proposed by independent finder agents and confirmed by voter agents; this is an agent review, not a human approval or request for changes.`,
    '',
  ];
  if (!mine.length) lines.push('No findings were confirmed in this round.');
  for (const f of mine) {
    const where = f.path ? ` \`${safe(f.path, 300)}${f.line ? `:${f.line}` : ''}\`` : '';
    lines.push(`- ${tag(f, job)}${where}: ${safe(f.title, 200)}${f.status !== 'open' ? ` (${f.status})` : ''}`);
    if (f.rationale) lines.push(`  <details><summary>Why</summary>\n\n  ${safe(f.rationale, 1500).replace(/\n/g, '\n  ')}\n\n  </details>`);
  }
  return lines.join('\n');
}

function inline(job: ReviewJob, findings: KnownFinding[]) {
  return roundFindings(job, findings).filter((f) => f.status === 'open' && f.path && Number.isSafeInteger(f.line) && (f.line as number) > 0)
    .map((f) => ({ path: f.path!, line: f.line as number, side: 'RIGHT', body: `${tag(f, job)} ${safe(f.title, 200)}\n\n${safe(f.rationale, 2000)}` }));
}

export class ReviewPoster {
  constructor(private gh: Gh, private stateFile: string) {}

  private saved(): Record<string, { digest: string; reviewId?: number }> {
    try { return JSON.parse(readFileSync(this.stateFile, 'utf8')); } catch { return {}; }
  }
  private save(jobId: string, digest: string, reviewId?: number) {
    try {
      const all = this.saved();
      all[jobId] = { digest, ...(reviewId ? { reviewId } : {}) };
      mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
      writeFileSync(this.stateFile, JSON.stringify(all, null, 2), { mode: 0o600 });
    } catch { /* the marker still stops a duplicate */ }
  }

  /** Posts or updates the job's review; resolves to what it did. Only for a job in phase `completed`. */
  async post(job: ReviewJob, findings: KnownFinding[]): Promise<PostOutcome> {
    if (job.phase !== 'completed') throw new Error('only a completed review job is posted');
    const body = reviewBody(job, findings);
    const comments = inline(job, findings);
    const digest = createHash('sha256').update(JSON.stringify({ body, comments })).digest('hex');
    if (this.saved()[job.reviewJobId]?.digest === digest) return 'unchanged';
    const pulls = `repos/${job.repository}/pulls/${job.number}/reviews`;
    const existing = (await this.gh(['api', pulls, '--paginate', '--jq', `.[] | select(.body | contains(${JSON.stringify(reviewMarker(job.reviewJobId))})) | .id`]))
      .split('\n').map((s) => Number(s.trim())).find((n) => Number.isSafeInteger(n) && n > 0);
    if (existing) {
      await this.withInput({ body }, (file) => this.gh(['api', '--method', 'PUT', `${pulls}/${existing}`, '--input', file]));
      this.save(job.reviewJobId, digest, existing);
      return 'updated';
    }
    const send = (withComments: boolean) => this.withInput({ commit_id: job.headSha, event: 'COMMENT', body, ...(withComments && comments.length ? { comments } : {}) },
      (file) => this.gh(['api', '--method', 'POST', pulls, '--input', file]));
    let out: string;
    // A line outside the diff makes GitHub refuse the inline comments (422): the body still lists every finding.
    try { out = await send(true); } catch (error) { if (!comments.length) throw error; out = await send(false); }
    let id: number | undefined;
    try { id = Number((JSON.parse(out) as { id?: unknown }).id) || undefined; } catch { /* no id */ }
    this.save(job.reviewJobId, digest, id);
    return 'posted';
  }

  private async withInput<T>(value: unknown, fn: (file: string) => Promise<T>): Promise<T> {
    const file = path.join(path.dirname(this.stateFile), `gh-input-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    try { return await fn(file); } finally { rmSync(file, { force: true }); }
  }
}

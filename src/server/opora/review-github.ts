import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KnownFinding, ReviewJob } from './review-client.js';
import { groupFindings, type FindingGroup } from './review-dedupe.js';
import { fetchCommentable, type Gh } from './review-diff-lines.js';

/**
 * A completed review job, posted to its pull request through `gh` without an LLM: one review of
 * event COMMENT (never APPROVE, never REQUEST_CHANGES, never a merge) whose body lists the round's
 * findings (the same bug reported by several finders shown once, review-dedupe.ts), each tagged
 * with its severity and finding id, and an inline comment for each that sits on a line of the diff.
 *
 * Exactly one review per job, even with two offices posting the same Canvas on one GitHub account:
 * a marker in the body finds a review already posted, which is updated in place; a new review is
 * first opened as PENDING (GitHub keeps one pending review per user per pull request, so the second
 * office's attempt is refused or sees the first's pending review and waits), checked once more, then
 * submitted. In one process the posts to a pull request run one at a time.
 */

export type { Gh } from './review-diff-lines.js';
/** `busy`: another poster has this job's review open right now; the next pass looks again. */
export type PostOutcome = 'posted' | 'updated' | 'unchanged' | 'busy';
type Log = (message: string, level: 'info' | 'warn') => void;
interface Found { id: number; state: string; body: string }
interface Inline { path: string; line: number; side: 'RIGHT'; body: string }

/** A pending review with the marker older than this is a poster that died between opening and submitting it. */
export const STALE_PENDING_MS = 120_000;

export const reviewMarker = (jobId: string) => `<!-- opora-review-job:${jobId} -->`;
const short = (sha: string) => sha.slice(0, 12);
const clip = (s: string | undefined, n: number) => (s ?? '').length > n ? `${(s ?? '').slice(0, n - 1)}…` : (s ?? '');
/** Text from a model in markdown: no HTML comments (no fake markers), no mentions that ping people. */
const safe = (s: string | undefined, n: number) => clip(s, n).replace(/<!--|-->/g, '').replace(/@(?=[A-Za-z0-9-])/g, '@​');
/** A security job's findings say so on GitHub (Canvas's "Zveřejnění"). */
const tag = (f: KnownFinding, job: ReviewJob) => `**[${job.kind === 'security' ? 'security · ' : ''}${f.severity}]** \`${f.findingId}\``;
const where = (f: KnownFinding) => (f.path ? `\`${safe(f.path, 300)}${f.line ? `:${f.line}` : ''}\`` : '');
const alsoLine = (g: FindingGroup) => `Reported by ${g.also.length + 1} finders; also ${g.also.map((f) => `\`${f.findingId}\`${f.path ? ` (${where(f)})` : ''}`).join(', ')}.`;
const sameText = (a: string, b: string) => a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim();

/** The round's own findings, worst first, then by path and line, so the same job is the same body. */
export function roundFindings(job: ReviewJob, findings: KnownFinding[]): KnownFinding[] {
  const rank: Record<string, number> = { important: 0, pre_existing: 1, nit: 2 };
  return findings.filter((f) => f.reviewJobId === job.reviewJobId)
    .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || (a.path ?? '').localeCompare(b.path ?? '') || (a.line ?? 0) - (b.line ?? 0) || a.findingId.localeCompare(b.findingId));
}

export function reviewBody(job: ReviewJob, findings: KnownFinding[]): string {
  const groups = groupFindings(roundFindings(job, findings));
  const lines = [
    reviewMarker(job.reviewJobId),
    `### ${job.kind === 'security' ? '🔒 Opora automated security review' : '🔎 Opora automated review'}: round ${job.round} at \`${short(job.headSha)}\``,
    '',
    `Review job \`${job.reviewJobId}\`${job.sinceSha ? `, changes since \`${short(job.sinceSha)}\`` : ''}. Findings were proposed by independent finder agents and confirmed by voter agents; this is an agent review, not a human approval or request for changes.`,
    '',
  ];
  if (!groups.length) lines.push('No findings were confirmed in this round.');
  for (const g of groups) {
    const f = g.lead;
    lines.push(`- ${tag(f, job)}${f.path ? ` ${where(f)}` : ''}: ${safe(f.title, 200)}${f.status !== 'open' ? ` (${f.status})` : ''}`);
    if (g.also.length) lines.push(`  ${alsoLine(g)}`);
    if (f.rationale) lines.push(`  <details><summary>Why</summary>\n\n  ${safe(f.rationale, 1500).replace(/\n/g, '\n  ')}\n\n  </details>`);
  }
  return lines.join('\n');
}

/** An inline comment for each open cluster's lead that has a path and a line. */
export function inlineComments(job: ReviewJob, findings: KnownFinding[]): Inline[] {
  return groupFindings(roundFindings(job, findings)).filter(({ lead: f }) => f.status === 'open' && f.path && Number.isSafeInteger(f.line) && (f.line as number) > 0)
    .map((g) => ({ path: g.lead.path!, line: g.lead.line as number, side: 'RIGHT' as const,
      body: `${tag(g.lead, job)} ${safe(g.lead.title, 200)}\n\n${safe(g.lead.rationale, 2000)}${g.also.length ? `\n\n${alsoLine(g)}` : ''}` }));
}

/** Posts to one pull request run one after another in this process. */
const processLanes = new Map<string, Promise<unknown>>();
function inLane<T>(lanes: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> {
  const run = (lanes.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  lanes.set(key, tail);
  void tail.then(() => { if (lanes.get(key) === tail) lanes.delete(key); });
  return run;
}

export interface PosterOptions {
  log?: Log;
  now?: () => number;
  /** The per-pull-request queue; the process's own unless a test stands in for another process. */
  lanes?: Map<string, Promise<unknown>>;
}

export class ReviewPoster {
  /** When this poster first saw each pending review with a marker (another poster's, or a dead one's). */
  private pendingSince = new Map<number, number>();

  private log: Log;
  private now: () => number;
  private lanes: Map<string, Promise<unknown>>;

  constructor(private gh: Gh, private stateFile: string, options: PosterOptions = {}) {
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.lanes = options.lanes ?? processLanes;
  }

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
    const comments = inlineComments(job, findings);
    const digest = createHash('sha256').update(JSON.stringify({ body, comments })).digest('hex');
    if (this.saved()[job.reviewJobId]?.digest === digest) return 'unchanged';
    return inLane(this.lanes, `${job.repository}#${job.number}`, () => this.postNow(job, body, comments, digest));
  }

  private pulls(job: ReviewJob) { return `repos/${job.repository}/pulls/${job.number}/reviews`; }
  private label(job: ReviewJob) { return `${job.repository}#${job.number} round ${job.round}`; }

  /** The job's reviews on GitHub (found by marker), oldest first; the account's own pending ones included. */
  private async find(job: ReviewJob): Promise<Found[]> {
    const out = await this.gh(['api', this.pulls(job), '--paginate', '--jq', `.[] | select((.body // "") | contains(${JSON.stringify(reviewMarker(job.reviewJobId))})) | {id, state, body}`]);
    return out.split('\n').flatMap((row) => {
      try {
        const r = JSON.parse(row) as { id?: unknown; state?: unknown; body?: unknown };
        return Number.isSafeInteger(r.id) && (r.id as number) > 0 ? [{ id: r.id as number, state: String(r.state ?? ''), body: String(r.body ?? '') }] : [];
      } catch { return []; }
    }).sort((a, b) => a.id - b.id);
  }

  /** What is already on GitHub decides: a submitted review is updated in place, a fresh pending one waited for, a stale one submitted. */
  private async settle(job: ReviewJob, found: Found[], body: string, digest: string, mine?: number): Promise<PostOutcome | undefined> {
    const posted = found.find((r) => r.state !== 'PENDING' && r.id !== mine);
    if (posted) {
      if (!sameText(posted.body, body)) await this.withInput({ body }, (file) => this.gh(['api', '--method', 'PUT', `${this.pulls(job)}/${posted.id}`, '--input', file]));
      this.save(job.reviewJobId, digest, posted.id);
      return sameText(posted.body, body) ? 'unchanged' : 'updated';
    }
    const pending = found.find((r) => r.state === 'PENDING' && r.id !== mine);
    if (!pending) return undefined;
    const since = this.pendingSince.get(pending.id) ?? this.now();
    this.pendingSince.set(pending.id, since);
    if (this.now() - since < STALE_PENDING_MS) return 'busy';
    // Its poster opened it and never submitted it: submit it with this body, so the job still gets its one review.
    await this.submit(job, pending.id, body);
    this.pendingSince.delete(pending.id);
    this.log(`🔎 Submitted a pending review of ${this.label(job)} that another poster left open`, 'info');
    this.save(job.reviewJobId, digest, pending.id);
    return 'posted';
  }

  private submit(job: ReviewJob, id: number, body: string) {
    return this.withInput({ event: 'COMMENT', body }, (file) => this.gh(['api', '--method', 'POST', `${this.pulls(job)}/${id}/events`, '--input', file]));
  }

  /** The comments GitHub will take: lines inside the diff's hunks. The rest are named in the body. */
  private async placeable(job: ReviewJob, comments: Inline[]): Promise<Inline[]> {
    if (!comments.length) return comments;
    let lines;
    try { lines = await fetchCommentable(this.gh, job); } catch (error) {
      this.log(`🔎 Couldn't read the diff of ${this.label(job)} (${(error as Error).message}); trying every inline comment`, 'warn');
      return comments;
    }
    const fit = comments.filter((c) => lines.get(c.path)?.has(c.line));
    const out = comments.filter((c) => !fit.includes(c));
    if (out.length) this.log(`🔎 ${out.length} finding(s) of ${this.label(job)} point outside the pull request's diff (${out.slice(0, 5).map((c) => `${c.path}:${c.line}`).join(', ')}): named in the review body only`, 'info');
    return fit;
  }

  private async open(job: ReviewJob, body: string, comments: Inline[]): Promise<number> {
    const out = await this.withInput({ commit_id: job.headSha, body, ...(comments.length ? { comments } : {}) },
      (file) => this.gh(['api', '--method', 'POST', this.pulls(job), '--input', file]));
    const id = Number((JSON.parse(out) as { id?: unknown }).id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('GitHub did not return the new review\'s id');
    return id;
  }

  private async postNow(job: ReviewJob, body: string, wanted: Inline[], digest: string): Promise<PostOutcome> {
    const already = await this.settle(job, await this.find(job), body, digest);
    if (already) return already;
    let comments = await this.placeable(job, wanted);
    let id: number | undefined;
    while (id === undefined) {
      try { id = await this.open(job, body, comments); } catch (error) {
        // Refused: another poster may have opened (or posted) this job's review just now.
        const now = await this.settle(job, await this.find(job), body, digest);
        if (now) return now;
        if (!comments.length) throw error;
        this.log(`🔎 GitHub refused the inline comments of ${this.label(job)} (${(error as Error).message}): posting the review with the findings in its body only`, 'warn');
        comments = [];
      }
    }
    // Another account's review of this job may have landed meanwhile: keep that one, drop this pending one.
    const raced = await this.settle(job, (await this.find(job)).filter((r) => r.state !== 'PENDING'), body, digest, id);
    if (raced) { await this.gh(['api', '--method', 'DELETE', `${this.pulls(job)}/${id}`]).catch(() => ''); return raced; }
    try { await this.submit(job, id, body); } catch (error) {
      await this.gh(['api', '--method', 'DELETE', `${this.pulls(job)}/${id}`]).catch(() => '');
      throw error;
    }
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

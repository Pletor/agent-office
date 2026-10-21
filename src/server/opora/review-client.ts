/**
 * The office's side of Canvas's review job API (`/api/oporahub/review-jobs`, Canvas's
 * docs/oporahub-review-jobs.md "Kontrakt pracovníka"). The slot token is the slot's authority: it
 * stays in this process, never in a prompt, a log, GitHub or the browser's state.
 */

export type ReviewRole = 'finder' | 'voter';
export type Severity = 'important' | 'nit' | 'pre_existing';

export interface ReviewJob {
  reviewJobId: string; executionId?: string; cardId?: string;
  repository: string; number: number; baseSha: string | null; headSha: string;
  round: number; sinceSha: string | null; phase: string; riskTier?: string;
  /** `code` or `security` (Canvas's "Druh úlohy"); missing on an older Canvas, which means `code`. */
  kind?: string; risk?: { reasons?: string[]; securityReasons?: string[] };
  finders?: number; voters?: number; requiredVotes?: number; completedAt?: string | null;
}
export interface KnownFinding {
  findingId: string; fingerprint: string; status: string; severity: Severity;
  reviewJobId?: string; round?: number; headSha?: string;
  path?: string; line?: number | null; title?: string; rationale?: string;
}
export interface Candidate {
  candidateId: string; kind: 'finding' | 'fix'; fingerprint?: string; path?: string; line?: number | null;
  severity?: Severity; title?: string; rationale: string; findingId?: string; finders?: number[];
}
export interface ReviewAssignment {
  reviewJobId: string; taskId: string; role: ReviewRole; slot: number; token: string; epoch: number;
  expiresAt: number; serverNow: number; job: ReviewJob; knownFindings: KnownFinding[]; candidates?: Candidate[];
}
export interface ReviewScope { project: string; workspace: string }
export interface ReviewListing { enabled: boolean; maxRounds?: number; jobs: ReviewJob[]; findings: KnownFinding[] }

export class ReviewJobError extends Error {
  constructor(readonly status: number, readonly code?: string, message = `Canvas review request refused (${status})`) { super(message); }
  /** Canvas has review jobs off (409 review_jobs_disabled), or predates them (404 on the API). */
  get disabled(): boolean { return (this.status === 409 && this.code === 'review_jobs_disabled') || this.status === 404; }
  /** Worth trying again with the same request id: the network, or Canvas busy. */
  get transient(): boolean { return this.status === 0 || this.status === 429 || this.status >= 500; }
}

const ROOT = '/api/oporahub/review-jobs';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

function validJob(j: ReviewJob | undefined): boolean {
  return !!j && typeof j === 'object' && ID.test(j.reviewJobId) && REPO.test(j.repository) && Number.isSafeInteger(j.number) && j.number > 0
    && SHA.test(j.headSha) && (j.baseSha === null || SHA.test(j.baseSha)) && (j.sinceSha === null || SHA.test(j.sinceSha))
    && Number.isSafeInteger(j.round) && typeof j.phase === 'string';
}

/** What Canvas assigned, checked before anything acts on it; anything off is a refusal, never a guess. */
export function validateAssignment(value: unknown): ReviewAssignment {
  const a = value as ReviewAssignment | null;
  const ok = !!a && typeof a === 'object' && ID.test(a.reviewJobId) && ID.test(a.taskId) && (a.role === 'finder' || a.role === 'voter')
    && Number.isSafeInteger(a.slot) && typeof a.token === 'string' && /^[a-f0-9]{64}$/.test(a.token)
    && Number.isSafeInteger(a.epoch) && a.epoch >= 1 && Number.isFinite(a.expiresAt) && Number.isFinite(a.serverNow)
    && validJob(a.job) && a.job.reviewJobId === a.reviewJobId && Array.isArray(a.knownFindings)
    && a.knownFindings.every((f) => f && typeof f.findingId === 'string' && typeof f.fingerprint === 'string' && typeof f.status === 'string')
    && (a.role === 'finder' || (Array.isArray(a.candidates) && a.candidates.every((c) => c && typeof c.candidateId === 'string' && ID.test(c.candidateId))));
  if (!ok) throw new ReviewJobError(409, 'invalid_assignment', 'Canvas returned an invalid review assignment');
  return a!;
}

export class ReviewJobClient {
  constructor(readonly base: string, readonly agent: string, private transport: typeof fetch = fetch) {}

  async claim(scope: ReviewScope, requestId: string, ttlSeconds: number, role?: ReviewRole): Promise<ReviewAssignment | null> {
    const out = await this.call<{ task?: unknown }>(`${ROOT}/claim`, { ...scope, requestId, ttlSeconds, ...(role ? { role } : {}) });
    return out && out.task ? validateAssignment(out.task) : null;
  }
  async heartbeat(scope: ReviewScope, a: ReviewAssignment, ttlSeconds: number): Promise<{ expiresAt: number }> {
    const out = await this.call<{ expiresAt?: number; epoch?: number }>(this.task(a, 'heartbeat'), { ...this.credentials(scope, a), ttlSeconds });
    if (out.epoch !== a.epoch || !Number.isFinite(out.expiresAt)) throw new ReviewJobError(409, 'review_conflict', 'Canvas review slot identity changed');
    return { expiresAt: out.expiresAt! };
  }
  async release(scope: ReviewScope, a: ReviewAssignment): Promise<void> {
    await this.call(this.task(a, 'release'), this.credentials(scope, a));
  }
  async submit(scope: ReviewScope, a: ReviewAssignment, requestId: string, submission: unknown): Promise<{ state: string; phase?: string }> {
    const out = await this.call<{ state?: string; phase?: string; taskId?: string }>(this.task(a, 'submit'), { ...this.credentials(scope, a), requestId, submission });
    if (out.taskId !== a.taskId || out.state !== 'submitted') throw new ReviewJobError(409, 'review_conflict', 'Canvas returned an invalid review receipt');
    return { state: out.state, phase: out.phase };
  }
  async list(scope: ReviewScope): Promise<ReviewListing> {
    const out = await this.call<ReviewListing>(`${ROOT}?${new URLSearchParams({ ...scope })}`, undefined);
    return { enabled: out?.enabled === true, maxRounds: out?.maxRounds, jobs: Array.isArray(out?.jobs) ? out.jobs.filter(validJob) : [],
      findings: Array.isArray(out?.findings) ? out.findings.filter((f) => f && typeof f.findingId === 'string') : [] };
  }

  private task(a: ReviewAssignment, action: string) {
    return `${ROOT}/${encodeURIComponent(a.reviewJobId)}/tasks/${encodeURIComponent(a.taskId)}/${action}`;
  }
  private credentials(scope: ReviewScope, a: ReviewAssignment) {
    return { project: scope.project, workspace: scope.workspace, token: a.token, epoch: a.epoch };
  }
  private async call<T>(endpoint: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.transport(new URL(endpoint, this.base), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: new URL(this.base).origin, 'X-Opora-Actor': `agent; name=${this.agent}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // Never reflect payloads (they carry the slot token) into errors.
      throw new ReviewJobError(0, undefined, 'Canvas review API unreachable');
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      let code: string | undefined;
      try { const c = (JSON.parse(text) as { code?: unknown }).code; if (typeof c === 'string' && c.length < 64) code = c; } catch { /* no code */ }
      throw new ReviewJobError(response.status, code);
    }
    if (text.length > 8 * 1024 * 1024) throw new ReviewJobError(409, 'too_large', 'Canvas review answer exceeds the supported size');
    try { return JSON.parse(text) as T; } catch { throw new ReviewJobError(0, undefined, 'Canvas returned invalid JSON'); }
  }
}

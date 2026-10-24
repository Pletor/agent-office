import { isDeepStrictEqual } from 'node:util';
import { sameBudget, validateBudget, validateContext, type ExecutionBudget, type ExecutionContext } from './execution-budget.js';
import { validateContextNegotiation, validateSparseAuthority, type ContextValidation, type ContextVersion } from './execution-context.js';

/** Server-private execution capability. Never include this object in browser state. */
export interface ExecutionLease {
  executionId: string; project: string; workspace: string; nodeId: string; token: string; epoch: number;
  acceptedRevision: string; assignmentDigest: string; assignment: Record<string, unknown>;
  serverNow: number; expiresAt: number; state: 'running';
  executionProtocolVersion?: 1 | 2; budget?: ExecutionBudget;
  contextProtocolVersion?: ContextVersion; contextValidation?: ContextValidation;
  /** Live step progress from `GET /{id}/assignment` (outside the assignment and its digest); claim only. */
  progress?: ExecutionProgress;
}
/** Which pinned steps this or an earlier run of the card already reported done, and the first one still open. */
export interface ExecutionProgress {
  total: number; done: number; current: string | null;
  steps: { id: string; status: string; executionId: string | null }[];
}
export interface ExecutionScope { project: string; workspace: string; nodeId: string }
export interface ExecutionClaim extends ExecutionScope {
  expectedAcceptedHead: string; expectedContextVersion: string; requestId: string; ttlSeconds: number;
  expectedBudgetPolicyHead?: string; previousExecutionId?: string | null;
  contextProtocolVersion?: ContextVersion;
}
export class ExecutionError extends Error {
  constructor(readonly status: number, readonly terminal: boolean, message = 'Canvas execution authority is unavailable') { super(message); }
}
/** How long one request to Opora may take: claim, context, assignment and release, and (separately) a heartbeat. */
export interface ExecutionTimeouts { requestMs: number; heartbeatMs: number }
const seconds = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value?.trim() && Number.isFinite(n) && n >= 1 ? Math.min(120, n) * 1000 : fallback * 1000;
};
/** `AGENT_OFFICE_OPORA_EXECUTION_TIMEOUT_S` (default 20) and `AGENT_OFFICE_OPORA_HEARTBEAT_TIMEOUT_S` (default 15), 1 to 120 s. */
export function executionTimeoutsFromEnvironment(env: NodeJS.ProcessEnv = process.env): ExecutionTimeouts {
  return { requestMs: seconds(env.AGENT_OFFICE_OPORA_EXECUTION_TIMEOUT_S, 20), heartbeatMs: seconds(env.AGENT_OFFICE_OPORA_HEARTBEAT_TIMEOUT_S, 15) };
}
/** What the office was doing, for the error a person sees. */
type Step = 'reading the card’s context' | 'claiming the card' | 'reading the assignment' | 'renewing the lease' | 'releasing the card';
/** Canvas's own reason for a refusal (`detail`), single-line, short, and with the request's secrets blanked out. */
function refusalDetail(text: string, secrets: string[]): string {
  let detail: unknown;
  try { detail = (JSON.parse(text) as { detail?: unknown }).detail; } catch { return ''; }
  if (object(detail)) detail = typeof detail.message === 'string' ? detail.message : detail.reason;
  if (typeof detail !== 'string') return '';
  let clean = detail.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const secret of secrets) if (secret.length >= 4) clean = clean.split(secret).join('[redacted]');
  return clean.length > 200 ? clean.slice(0, 199) + '…' : clean;
}
/** A network failure's code (`ECONNREFUSED`, `UND_ERR_SOCKET`, ...): only an identifier-like code, never the error's text. */
function networkCode(error: unknown): string {
  for (let e: unknown = error, depth = 0; e && typeof e === 'object' && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(code)) return code;
  }
  return '';
}
const ROOT = '/api/oporahub/executions';
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);

export function validateExecution(value: unknown, scope: ExecutionScope): ExecutionLease {
  const v = value as ExecutionLease | null;
  if (!v || !validId(v.executionId) || v.project !== scope.project || v.workspace !== scope.workspace || v.nodeId !== scope.nodeId
    || typeof v.token !== 'string' || !v.token || v.token.length > 512 || /[\r\n]/.test(v.token)
    || !Number.isSafeInteger(v.epoch) || v.epoch < 1 || !/^[a-f0-9]{40}$/.test(v.acceptedRevision)
    || !/^[a-f0-9]{64}$/.test(v.assignmentDigest) || !v.assignment || typeof v.assignment !== 'object' || Array.isArray(v.assignment)
    || !Number.isFinite(v.serverNow) || !Number.isFinite(v.expiresAt) || v.expiresAt <= v.serverNow || v.state !== 'running') {
    throw new ExecutionError(409, true, 'Canvas returned invalid execution authority');
  }
  if (v.executionProtocolVersion !== undefined && v.executionProtocolVersion !== 1 && v.executionProtocolVersion !== 2)
    throw new ExecutionError(409, true, 'Canvas returned unsupported execution authority');
  if (v.executionProtocolVersion === 2) {
    try { validateBudget(v.budget); } catch { throw new ExecutionError(409, true, 'Canvas returned invalid budget authority'); }
    if (v.expiresAt > v.budget!.runDeadlineAt || v.serverNow >= v.budget!.runDeadlineAt)
      throw new ExecutionError(409, true, 'Canvas budget authority expired or exceeded its fixed deadline');
  } else if (v.budget !== undefined) throw new ExecutionError(409, true, 'Canvas budget version is missing');
  try { validateSparseAuthority(v as unknown as Record<string, unknown>); }
  catch { throw new ExecutionError(409, true, 'Canvas returned invalid context authority'); }
  return v;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Claim and heartbeat ask for the lease alone (Opora M2); the assignment is read once from `GET /{id}/assignment`. */
const LEAN = '?assignment=omit';

/**
 * A lean lease (`?assignment=omit`: the authority plus `contextVersion`, no assignment) checked by every rule
 * `validateExecution` applies to a full one. Its `assignment` is only the context pin (`contextVersion`, and the
 * protocol marker for sparse context) until the real assignment replaces it; never hand it to a worker.
 * A Canvas that ignores `omit` still sends the whole lease, which is validated as before.
 */
export function validateClaimedAuthority(value: unknown, scope: ExecutionScope): ExecutionLease {
  if (object(value) && 'assignment' in value) return validateExecution(value, scope);
  if (!object(value) || typeof value.contextVersion !== 'string' || !value.contextVersion || value.contextVersion.length > 4096)
    throw new ExecutionError(409, true, 'Canvas returned invalid execution authority');
  const { contextVersion, ...rest } = value;
  return validateExecution({ ...rest, assignment: { contextVersion, ...(rest.contextProtocolVersion === 2 ? { contextProtocolVersion: 2 } : {}) } }, scope);
}

/** Live progress, kept only when it has the documented shape; it is advisory, so a bad one is dropped, never fatal. */
export function validProgress(value: unknown): ExecutionProgress | undefined {
  if (!object(value) || !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.done)
    || !(value.current === null || (typeof value.current === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value.current)))
    || !Array.isArray(value.steps) || value.steps.length > 50) return undefined;
  const steps = value.steps.filter(object).filter(item => typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(item.id) && typeof item.status === 'string')
    .map(item => ({ id: item.id as string, status: String(item.status).slice(0, 20), executionId: typeof item.executionId === 'string' ? item.executionId : null }));
  return { total: value.total as number, done: value.done as number, current: value.current as string | null, steps };
}

/** The assignment read for a lean claim must belong to exactly that execution and context; then it is the lease's. */
export function withAssignment(authority: ExecutionLease, read: unknown, scope: ExecutionScope): ExecutionLease {
  const mismatch = () => new ExecutionError(409, true, 'Canvas assignment does not match the claimed execution');
  if (!object(read) || !object(read.assignment)) throw mismatch();
  for (const key of ['executionId', 'project', 'workspace', 'nodeId', 'epoch', 'acceptedRevision', 'assignmentDigest'] as const)
    if (read[key] !== authority[key]) throw mismatch();
  if (read.assignment.contextVersion !== authority.assignment.contextVersion
    || (read.executionProtocolVersion ?? 1) !== (authority.executionProtocolVersion ?? 1)
    || (read.contextProtocolVersion ?? 1) !== (authority.contextProtocolVersion ?? 1)) throw mismatch();
  if (authority.executionProtocolVersion === 2) {
    try { if (!sameBudget(validateBudget(read.budget), authority.budget!)) throw mismatch(); } catch { throw mismatch(); }
  }
  const progress = validProgress(read.progress);
  return validateExecution({ ...authority, assignment: read.assignment, ...(progress ? { progress } : {}) }, scope);
}

export class ExecutionClient {
  constructor(readonly base: string, readonly agent: string, private transport: typeof fetch = fetch,
    readonly timeouts: ExecutionTimeouts = executionTimeoutsFromEnvironment()) {}

  async context(scope: ExecutionScope, version: ContextVersion = 1): Promise<ExecutionContext> {
    const value = await this.call<Record<string, unknown>>(version === 2 ? ROOT + '/context'
      : ROOT + '/context?' + new URLSearchParams({ ...scope }), version === 2 ? { ...scope, contextProtocolVersion: 2 } : undefined, 'reading the card’s context');
    try { validateContextNegotiation(value, version); return validateContext(value); }
    catch { throw new ExecutionError(409, true, 'Canvas returned unsupported execution context'); }
  }
  async claim(payload: ExecutionClaim): Promise<ExecutionLease> {
    const received: unknown = await this.call(ROOT + '/claim' + LEAN, payload, 'claiming the card');
    const lease = object(received) && 'assignment' in received ? validateExecution(received, payload)
      : await this.assignment(validateClaimedAuthority(received, payload), payload);
    if ((lease.contextProtocolVersion ?? 1) !== (payload.contextProtocolVersion ?? 1))
      throw new ExecutionError(409, true, 'Canvas returned a different context protocol');
    if (lease.acceptedRevision !== payload.expectedAcceptedHead || lease.assignment.contextVersion !== payload.expectedContextVersion)
      throw new ExecutionError(409, true, 'Canvas returned a different assignment context');
    const version = payload.expectedBudgetPolicyHead !== undefined ? 2 : 1;
    if ((lease.executionProtocolVersion ?? 1) !== version
      || (version === 2 && lease.budget!.policyHead !== payload.expectedBudgetPolicyHead))
      throw new ExecutionError(409, true, 'Canvas returned a different budget protocol or policy');
    return lease;
  }
  /** Reads the immutable assignment of a lean claim once; a terminal refusal gives the fresh claim back. */
  private async assignment(authority: ExecutionLease, scope: ExecutionScope): Promise<ExecutionLease> {
    try {
      const read = await this.call(`${ROOT}/${encodeURIComponent(authority.executionId)}/assignment?`
        + new URLSearchParams({ project: authority.project, workspace: authority.workspace }), undefined, 'reading the assignment', { 'X-Opora-Execution-Token': authority.token });
      return withAssignment(authority, read, scope);
    } catch (error) {
      if (error instanceof ExecutionError && error.terminal) await this.release(authority).catch(() => {});
      throw error;
    }
  }
  /** `withinMs` caps the wait to what is left of the authority's deadline, so a slow Opora can't hold a heartbeat past it. */
  async heartbeat(lease: ExecutionLease, ttlSeconds: number, withinMs?: number): Promise<ExecutionLease> {
    const received: unknown = await this.call(`${ROOT}/${encodeURIComponent(lease.executionId)}/heartbeat${LEAN}`, {
      ...this.credentials(lease), ttlSeconds,
    }, 'renewing the lease', {}, Math.max(1, Math.min(this.timeouts.heartbeatMs, withinMs ?? Infinity)));
    // Lean renewal: the digest (compared below) stands for the assignment; its context pin must not move either.
    const lean = !(object(received) && 'assignment' in received);
    const checked = validateClaimedAuthority(received, lease);
    if (lean && checked.assignment.contextVersion !== lease.assignment.contextVersion) throw new ExecutionError(409, true, 'Canvas execution identity changed');
    const { progress: _progress, ...rest } = checked;
    const next: ExecutionLease = lean ? { ...rest, assignment: lease.assignment } : rest;
    if (next.executionId !== lease.executionId || next.epoch !== lease.epoch || next.token !== lease.token
      || next.acceptedRevision !== lease.acceptedRevision || next.assignmentDigest !== lease.assignmentDigest
      || (next.executionProtocolVersion ?? 1) !== (lease.executionProtocolVersion ?? 1)
      || (next.contextProtocolVersion ?? 1) !== (lease.contextProtocolVersion ?? 1)
      || !isDeepStrictEqual(next.assignment, lease.assignment)
      || (lease.executionProtocolVersion === 2 && !sameBudget(next.budget!, lease.budget!))) {
      throw new ExecutionError(409, true, 'Canvas execution identity changed');
    }
    return next;
  }
  async release(lease: ExecutionLease): Promise<void> {
    await this.call(`${ROOT}/${encodeURIComponent(lease.executionId)}/release`, this.credentials(lease), 'releasing the card');
  }
  private credentials(lease: ExecutionLease) { return { project: lease.project, workspace: lease.workspace, token: lease.token, epoch: lease.epoch }; }
  /**
   * One request. Its failure says which of three it was, so a person can tell them apart: Opora too slow
   * (timeout, non-terminal), Opora unreachable (the network code, non-terminal), or Opora refusing (status and
   * Canvas's `detail`). Never the request body, the token or a raw error text.
   */
  private async call<T>(endpoint: string, body: unknown, step: Step, extra: Record<string, string> = {}, timeoutMs = this.timeouts.requestMs): Promise<T> {
    const secrets = [...Object.values(extra), ...(object(body) && typeof body.token === 'string' ? [body.token] : [])];
    try {
      const response = await this.transport(new URL(endpoint, this.base), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: new URL(this.base).origin, 'X-Opora-Actor': `agent; name=${this.agent}`, ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        const detail = refusalDetail(await response.text().catch(() => ''), secrets);
        throw new ExecutionError(response.status, response.status >= 400 && response.status < 500 && response.status !== 429,
          `Opora refused ${step} (HTTP ${response.status})${detail ? ': ' + detail : ''}`);
      }
      const text = await response.text();
      if (text.length > 4 * 1024 * 1024) throw new ExecutionError(409, true, 'Canvas assignment exceeds the supported size');
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      // Do not reflect response bodies, request payloads, or capability tokens into logs/UI.
      const name = (error as { name?: unknown } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError')
        throw new ExecutionError(0, false, `Opora didn’t answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 100) / 10} s` : `${timeoutMs} ms`} while ${step}; it may be busy, try again`);
      if (error instanceof SyntaxError) throw new ExecutionError(0, false, `Opora sent an unreadable answer while ${step}`);
      throw new ExecutionError(0, false, `Opora couldn’t be reached while ${step} (${networkCode(error) || 'network error'})`);
    }
  }
}

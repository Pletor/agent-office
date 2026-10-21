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

export class ExecutionClient {
  constructor(readonly base: string, readonly agent: string, private transport: typeof fetch = fetch) {}

  async context(scope: ExecutionScope, version: ContextVersion = 1): Promise<ExecutionContext> {
    const value = await this.call<Record<string, unknown>>(version === 2 ? ROOT + '/context'
      : ROOT + '/context?' + new URLSearchParams({ ...scope }), version === 2 ? { ...scope, contextProtocolVersion: 2 } : undefined);
    try { validateContextNegotiation(value, version); return validateContext(value); }
    catch { throw new ExecutionError(409, true, 'Canvas returned unsupported execution context'); }
  }
  async claim(payload: ExecutionClaim): Promise<ExecutionLease> {
    const lease = validateExecution(await this.call(ROOT + '/claim', payload), payload);
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
  async heartbeat(lease: ExecutionLease, ttlSeconds: number): Promise<ExecutionLease> {
    const next = validateExecution(await this.call(`${ROOT}/${encodeURIComponent(lease.executionId)}/heartbeat`, {
      ...this.credentials(lease), ttlSeconds,
    }), lease);
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
    await this.call(`${ROOT}/${encodeURIComponent(lease.executionId)}/release`, this.credentials(lease));
  }
  private credentials(lease: ExecutionLease) { return { project: lease.project, workspace: lease.workspace, token: lease.token, epoch: lease.epoch }; }
  private async call<T>(endpoint: string, body: unknown): Promise<T> {
    try {
      const response = await this.transport(new URL(endpoint, this.base), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: new URL(this.base).origin, 'X-Opora-Actor': `agent; name=${this.agent}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new ExecutionError(response.status, response.status >= 400 && response.status < 500 && response.status !== 429,
        `Canvas execution request refused (${response.status})`);
      const text = await response.text();
      if (text.length > 4 * 1024 * 1024) throw new ExecutionError(409, true, 'Canvas assignment exceeds the supported size');
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      // Do not reflect response bodies, request payloads, or capability tokens into logs/UI.
      throw new ExecutionError(0, false);
    }
  }
}

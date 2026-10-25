import { ExecutionBudgetClock } from './execution-budget-clock.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ExecutionClient, ExecutionError, type ExecutionClaim, type ExecutionLease, type ExecutionScope } from './execution-client.js';
import type { ContextVersion } from './execution-context.js';
import { emitProcess } from '../process/hub.js';
import { heartbeatEvent } from '../process/opora-events.js';

export const EXECUTION_TTL = 900;
/** The stop reason when Canvas ended an execution because its result is in: a normal end, not a failure. */
export const EXECUTION_FINISHED = 'Canvas finished the execution after its reported result';
type Watch = { lease: ExecutionLease; deadline: number; expiry?: ReturnType<typeof setTimeout>; beat?: ReturnType<typeof setTimeout>; stopped: boolean; failing?: boolean };
export function executionDeadline(lease: Pick<ExecutionLease, 'serverNow' | 'expiresAt'>, started: number) {
  const lifetime = Math.min(EXECUTION_TTL, lease.expiresAt - lease.serverNow) * 1000;
  if (!Number.isFinite(lifetime) || lifetime <= 0) throw new ExecutionError(409, true, 'Execution has expired');
  return started + lifetime;
}

/** Scope guards and monotonic deadlines survive slow/network-hung heartbeats without extending authority. */
export class ExecutionController {
  private caps = new ExecutionBudgetClock();
  private closed = false;
  private pending = new Set<string>();
  private watches = new Map<string, Watch>();
  private claims = new Map<string, ExecutionClaim>();
  /** Whether the execution's result receipt is stored: Canvas then refuses its heartbeat (409) because it is finished, not lost. */
  ended?: (executionId: string) => boolean;
  /** Asks Canvas whether a refused execution already has a stored result, and keeps it for the hand-off (execution-recovery.ts). */
  recover?: (lease: ExecutionLease) => Promise<boolean>;
  constructor(readonly client: ExecutionClient,
    private changed: (workerId: string, lease: ExecutionLease, deadlineUnixMs: number) => void,
    private stopped: (workerId: string, reason: string) => void,
    private clock: () => number = () => performance.now()) {}

  async guarded<T>(scope: ExecutionScope, run: () => Promise<T>): Promise<T> {
    const key = JSON.stringify(scope);
    if (this.pending.has(key)) throw new ExecutionError(409, true, 'This Canvas card is already being dispatched');
    this.pending.add(key);
    try { return await run(); } finally { this.pending.delete(key); }
  }
  async claim(scope: ExecutionScope, contextVersion: ContextVersion = 1): Promise<{ lease: ExecutionLease; deadline: number }> {
    if (this.closed) throw new ExecutionError(409, true, 'Office execution controller is shutting down');
    const key = JSON.stringify(scope);
    let payload = this.claims.get(key);
    if (payload && (payload.contextProtocolVersion ?? 1) !== contextVersion)
      throw new ExecutionError(409, true, 'Pending Canvas claim uses another context protocol');
    if (!payload) {
      const context = await this.client.context(scope, contextVersion);
      if (!context.available || !context.acceptedHead || !context.contextVersion) throw new ExecutionError(409, true, 'Canvas needs an accepted, unchanged plan before dispatch');
      payload = { ...scope, expectedAcceptedHead: context.acceptedHead, expectedContextVersion: context.contextVersion, requestId: randomUUID(), ttlSeconds: EXECUTION_TTL };
      if (contextVersion === 2) payload.contextProtocolVersion = 2;
      if (context.executionProtocolVersion === 2) {
        if (!context.budget?.enrolled || !context.budget.policyHead || context.budget.blockedReason)
          throw new ExecutionError(409, true, 'Canvas budget policy is unavailable');
        payload.expectedBudgetPolicyHead = context.budget.policyHead;
        payload.previousExecutionId = context.budget.latestExecutionId;
      }
      this.claims.set(key, payload);
    }
    let claimed: ExecutionLease | undefined;
    try {
      const started = this.clock();
      claimed = await this.client.claim(payload);
      const cap = this.caps.observe(claimed, started);
      if (this.closed || this.clock() >= cap) throw new ExecutionError(409, true, 'Office execution controller is shutting down');
      // Idempotent claim replay can contain the original serverNow. Renew before launch.
      const renewed = await this.revalidate(claimed);
      // Renewal is lean and carries no live progress; the claim's assignment read does, so the resume point survives it.
      const lease = claimed.progress ? { ...renewed.lease, progress: claimed.progress } : renewed.lease, deadline = renewed.deadline;
      if (this.clock() >= deadline) { void this.client.release(lease).catch(() => {}); throw new ExecutionError(409, true, 'Execution expired before dispatch'); }
      this.claims.delete(key);
      return { lease, deadline };
    } catch (error) {
      if (error instanceof ExecutionError && error.terminal) {
        this.claims.delete(key);
        if (claimed) await this.client.release(claimed).catch(() => {});
      }
      throw error;
    }
  }
  watch(workerId: string, lease: ExecutionLease, deadline: number) {
    if (this.closed) throw new ExecutionError(409, true, 'Office execution controller is shutting down');
    this.forget(workerId);
    const watch: Watch = { lease, deadline: Math.min(deadline, this.caps.observe(lease, this.clock())), stopped: false };
    this.watches.set(workerId, watch);
    this.arm(workerId, watch);
    this.schedule(workerId, watch, 30_000);
  }
  /** Restart must explicitly revalidate the original epoch; never silently claim a replacement. */
  async revalidate(lease: ExecutionLease): Promise<{ lease: ExecutionLease; deadline: number }> {
    const started = this.clock();
    const next = await this.client.heartbeat(lease, EXECUTION_TTL);
    const deadline = Math.min(executionDeadline(next, started), this.caps.observe(next, started));
    if (this.closed || deadline <= this.clock()) throw new ExecutionError(409, true, 'Restored execution already expired');
    return { lease: next, deadline };
  }
  allowed(workerId: string) { const watch = this.watches.get(workerId); return !!watch && !watch.stopped && this.clock() < watch.deadline; }
  /** Detached task data for the current worker only; never expose its execution capability. */
  assignmentFor(workerId: string) {
    const watch = this.watches.get(workerId);
    if (!watch || !this.allowed(workerId)) return undefined;
    const { executionId, project, workspace, nodeId, epoch, acceptedRevision, assignmentDigest, contextProtocolVersion, assignment } = watch.lease;
    return { executionId, project, workspace, nodeId, epoch, acceptedRevision, assignmentDigest,
      contextProtocolVersion: contextProtocolVersion ?? 1, assignment: structuredClone(assignment) };
  }
  forget(workerId: string) {
    const watch = this.watches.get(workerId);
    if (watch) { watch.stopped = true; clearTimeout(watch.expiry); clearTimeout(watch.beat); this.watches.delete(workerId); }
  }
  /**
   * Its worker stopped on the provider's usage limit until `resetsAt` (wall-clock ms; undefined: it
   * didn't say). Heartbeats go on only while it can resume before the execution's fixed run deadline
   * (budget v2); one that can't (or won't say when) is stopped now as at that deadline, worktree kept.
   * Without a fixed deadline (v1) there is nothing it would overrun: authority stays, the pause is shown.
   */
  usageLimit(workerId: string, resetsAt: number | undefined, wallNow = Date.now()): 'kept' | 'stopped' | undefined {
    const watch = this.watches.get(workerId);
    if (!watch || watch.stopped) return undefined;
    const fixed = this.caps.fixed(watch.lease.executionId);
    const keep = !Number.isFinite(fixed) || (resetsAt !== undefined && this.clock() + (resetsAt - wallNow) < fixed);
    if (keep) {
      emitProcess(this.client.agent, heartbeatEvent(watch.lease, workerId, 'paused', Number.isFinite(fixed) ? 'limit se obnoví před pevným termínem běhu' : 'běh nemá pevný termín'));
      return 'kept';
    }
    const when = resetsAt === undefined ? 'an unstated time' : new Date(resetsAt).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
    this.stop(workerId, watch, `Provider usage limit until ${when} is past the execution's fixed deadline: authority released, worktree kept`);
    return 'stopped';
  }
  shutdown() {
    this.closed = true;
    for (const [id, watch] of this.watches) {
      if (watch.lease.executionProtocolVersion === 2 || watch.lease.contextProtocolVersion === 2) this.stop(id, watch, 'Office shutdown: Canvas worker stop requested');
      else this.forget(id);
    }
  }
  private stop(workerId: string, watch: Watch, reason: string) {
    if (watch.stopped) return;
    this.forget(workerId);
    emitProcess(this.client.agent, heartbeatEvent(watch.lease, workerId, reason === EXECUTION_FINISHED ? 'finished' : 'stopped', reason));
    this.stopped(workerId, reason);
  }
  private arm(workerId: string, watch: Watch) {
    clearTimeout(watch.expiry);
    const remaining = watch.deadline - this.clock();
    if (remaining <= 0) { this.stop(workerId, watch, 'Canvas execution deadline expired'); return; }
    watch.expiry = setTimeout(() => this.stop(workerId, watch, 'Canvas execution deadline expired'), remaining);
    watch.expiry.unref?.();
    this.changed(workerId, watch.lease, Date.now() + remaining);
  }
  private schedule(workerId: string, watch: Watch, delay: number) {
    if (watch.stopped) return;
    watch.beat = setTimeout(() => void this.beat(workerId, watch), Math.min(delay, Math.max(1, (watch.deadline - this.clock()) / 2)));
    watch.beat.unref?.();
  }
  private async beat(workerId: string, watch: Watch) {
    const started = this.clock();
    try {
      // A slow Opora gets at most what is left before the deadline; the deadline itself never moves for it.
      const lease = await this.client.heartbeat(watch.lease, EXECUTION_TTL, watch.deadline - started);
      if (watch.stopped) return;
      if (this.clock() >= watch.deadline) { this.stop(workerId, watch, 'Canvas execution deadline expired'); return; }
      watch.lease = lease;
      if (watch.failing) { watch.failing = false; emitProcess(this.client.agent, heartbeatEvent(lease, workerId, 'recovered')); }
      watch.deadline = Math.min(executionDeadline(lease, started), this.caps.observe(lease, started));
      this.arm(workerId, watch);
      this.schedule(workerId, watch, 30_000);
    } catch (error) {
      if (watch.stopped) return;
      // After a reported result Canvas ends authority, so the next heartbeat's 409 is the run's normal end, also when
      // the worker's helper never saw its receipt (a slow Opora): Canvas is asked whether the result is stored.
      if (error instanceof ExecutionError && error.terminal && error.status === 409) {
        const finished = this.ended?.(watch.lease.executionId) || await this.recover?.(watch.lease).catch(() => false);
        if (!watch.stopped) this.stop(workerId, watch, finished ? EXECUTION_FINISHED : error.message);
      } else if (error instanceof ExecutionError && error.terminal) this.stop(workerId, watch, error.message);
      else if (this.clock() >= watch.deadline) this.stop(workerId, watch, 'Canvas execution deadline expired');
      else { if (!watch.failing) { watch.failing = true; emitProcess(this.client.agent, heartbeatEvent(watch.lease, workerId, 'retrying')); } this.schedule(workerId, watch, 2000); }
    }
  }
}

import path from 'node:path';
import type { WorkerInfo } from '../../shared/protocol.js';
import type { WorkerLaunchGuard } from '../workers/launch-guards.js';
import { ExecutionClient, validateExecution, type ExecutionLease, type ExecutionScope } from './execution-client.js';
import { ExecutionController } from './execution-controller.js';
import { executionPrompt } from './execution-prompt.js';
import { validateBudgetFiles } from './execution-budget-files.js';
import { contextVersionFromEnvironment } from './execution-context.js';
import { PullRequestHandoff, type HandoffTools } from './pull-request-handoff.js';
import type { SelfCheckReporter } from './self-checks.js';
import { emitProcess, processHub } from '../process/hub.js';
import { claimEvent, handoffEvent, releaseEvent } from '../process/opora-events.js';

export interface ExecutionHeld { workerId?: string; execution?: ExecutionLease; deadlineUnixMs?: number; leaseUntil?: string; state?: string }

/** The bridge composes this feature; all execution authority remains server-private. */
export class ExecutionDispatch {
  readonly client: ExecutionClient;
  readonly controller: ExecutionController;
  /** Pushes a reported execution's commits and opens its pull request (see pull-request-handoff.ts). */
  readonly pullRequests: PullRequestHandoff;
  private readonly contextVersion = contextVersionFromEnvironment();
  /** The last worker info seen per worker, so a worker already sent home still hands its worktree off. */
  private worktrees = new Map<string, WorkerInfo>();
  private seating?: { lease: ExecutionLease; deadline: number; prompt: string; workerId?: string };
  /** Claims of different cards go to Opora one at a time: a Take made while another claims waits its turn. */
  private turn: Promise<unknown> = Promise.resolve();
  private inTurn<T>(run: () => Promise<T>): Promise<T> {
    const mine = this.turn.then(run, run);
    this.turn = mine.catch(() => {});
    return mine;
  }
  constructor(base: string, private agent: string, private directory: string,
    private runs: () => ExecutionHeld[],
    changed: () => void, private stop: (workerId: string, reason: string) => void, tools?: HandoffTools,
    /** Runs the configured checks on each pull request's head and tells Canvas (self-checks.ts). */
    private selfChecks?: SelfCheckReporter) {
    this.client = new ExecutionClient(base, agent);
    this.pullRequests = new PullRequestHandoff(directory, base, agent, tools);
    this.controller = new ExecutionController(this.client, (id, lease, deadline) => {
      const run = this.runs().find(run => run.workerId === id);
      if (run) { run.execution = lease; run.deadlineUnixMs = deadline; run.leaseUntil = new Date(lease.expiresAt * 1000).toISOString(); changed(); }
    }, stop);
  }
  readonly guard: WorkerLaunchGuard = {
    applies: info => info.via === 'opora' || this.runs().some(run => run.workerId === info.id),
    keepOnRestart: info => {
      const lease = this.runs().find(run => run.workerId === info.id)?.execution;
      return lease?.executionProtocolVersion !== 2 && lease?.contextProtocolVersion !== 2;
    },
    check: info => {
      if (!this.controller.allowed(info.id) && this.seating && info.prompt === this.seating.prompt
        && !this.runs().some(run => run.workerId === info.id) && (!this.seating.workerId || this.seating.workerId === info.id)) {
        this.seating.workerId = info.id;
        this.controller.watch(info.id, this.seating.lease, this.seating.deadline);
      }
      return this.controller.allowed(info.id) ? undefined : 'Canvas execution authority is missing or expired; take the card again';
    },
    restore: async info => {
      const run = this.runs().find(run => run.workerId === info.id);
      if (run?.state === 'gone' || run?.state === 'reported') return 'This Canvas execution has ended; worktree kept';
      try {
        if (!run?.execution) throw new Error('missing authority');
        const lease = validateExecution(run.execution, run.execution);
        validateBudgetFiles(this.directory, this.client.base, this.agent, lease);
        const restored = await this.controller.revalidate(lease);
        this.controller.watch(info.id, restored.lease, restored.deadline);
        return undefined;
      } catch {
        const reason = 'Saved Canvas execution could not be revalidated; worktree kept. Take the card again.';
        this.stop(info.id, reason);
        return reason;
      }
    },
  };
  async dispatch(scope: ExecutionScope, prepare: () => Promise<string>, seat: (prompt: string) => WorkerInfo | string, decorate: (prompt: string) => string = value => value,
    /** A design card's addendum (design-brief.ts), read before the claim like `prepare`. */
    design: () => Promise<string> = async () => '') {
    return this.controller.guarded(scope, async () => {
      const context = this.contextVersion === 2 ? '' : await prepare();
      const brief = await design().catch(() => '');
      const grant = await this.inTurn(() => this.controller.claim(scope, this.contextVersion)).catch((e: Error) => { emitProcess(this.agent, claimEvent(scope, { error: e.message })); throw e; });
      let seatedId: string | undefined;
      try {
        const immutablePrompt = executionPrompt(this.directory, this.client.base, this.agent, grant.lease, context, brief);
        const prompt = (this.contextVersion === 2 ? immutablePrompt : decorate(immutablePrompt)).trim();
        this.seating = { ...grant, prompt };
        let worker: WorkerInfo | string;
        try { worker = seat(prompt); } finally { seatedId = this.seating?.workerId; this.seating = undefined; }
        if (typeof worker === 'string') throw new Error(worker);
        seatedId = worker.id;
        if (worker.status === 'exited') throw new Error('Worker failed to start; Canvas reservation released');
        this.controller.watch(worker.id, grant.lease, grant.deadline);
        if (!this.controller.allowed(worker.id)) throw new Error('Execution expired while starting worker');
        processHub.noteExecution(worker.id, grant.lease.executionId); emitProcess(this.agent, claimEvent(scope, { executionId: grant.lease.executionId, workerId: worker.id, workerName: worker.name }));
        return { worker, execution: grant.lease, deadlineUnixMs: Date.now() + Math.max(0, grant.deadline - performance.now()) };
      } catch (error) {
        if (seatedId) { this.controller.forget(seatedId); this.stop(seatedId, 'Worker failed to start; worktree kept'); }
        await this.client.release(grant.lease).catch(() => {}); throw error;
      }
    });
  }
  /** Hands a reported execution's work off as a pull request, from the worker's worktree under `floorDir`. */
  handOff(run: ExecutionHeld & { cardName?: string }, info: WorkerInfo | undefined, floorDir: string,
    notify: (message: string, level: 'info' | 'warn' | 'error') => void) {
    if (run.workerId && info?.worktree) this.worktrees.set(run.workerId, info);
    const wt = (info ?? (run.workerId ? this.worktrees.get(run.workerId) : undefined))?.worktree;
    if (!run.execution || !wt?.base) return undefined;
    const lease = run.execution, dir = path.join(floorDir, wt.path);
    const handoff = this.pullRequests.handOff({ lease, cardName: run.cardName, dir, baseCommit: wt.base, baseBranch: wt.from }, notify);
    // The evidence runs after the pull request is out, without holding the lease for it.
    void handoff?.then(out => { emitProcess(this.agent, handoffEvent(lease, out)); if (out.state === 'opened' || out.state === 'reused') return this.selfChecks?.report({
      project: lease.project, workspace: lease.workspace, executionId: lease.executionId, headSha: out.headSha, dir }); }).catch(() => {});
    return handoff;
  }
  async release(run: ExecutionHeld) {
    await this.pullRequests.settled(run.execution?.executionId);
    if (run.workerId) this.worktrees.delete(run.workerId);
    if (run.workerId) this.controller.forget(run.workerId);
    if (run.execution) emitProcess(this.agent, releaseEvent(run.execution, run.workerId));
    processHub.noteExecution(run.workerId, undefined);
    if (run.execution) await this.client.release(run.execution).catch(() => {});
  }
}

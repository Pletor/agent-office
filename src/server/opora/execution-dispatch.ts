import type { WorkerInfo } from '../../shared/protocol.js';
import type { WorkerLaunchGuard } from '../workers/launch-guards.js';
import { ExecutionClient, validateExecution, type ExecutionLease, type ExecutionScope } from './execution-client.js';
import { ExecutionController } from './execution-controller.js';
import { executionPrompt } from './execution-prompt.js';
import { validateBudgetFiles } from './execution-budget-files.js';
import { contextVersionFromEnvironment } from './execution-context.js';

export interface ExecutionHeld { workerId?: string; execution?: ExecutionLease; deadlineUnixMs?: number; leaseUntil?: string; state?: string }

/** The bridge composes this feature; all execution authority remains server-private. */
export class ExecutionDispatch {
  readonly client: ExecutionClient;
  readonly controller: ExecutionController;
  private readonly contextVersion = contextVersionFromEnvironment();
  private seating?: { lease: ExecutionLease; deadline: number; prompt: string; workerId?: string };
  constructor(base: string, private agent: string, private directory: string,
    private runs: () => ExecutionHeld[],
    changed: () => void, private stop: (workerId: string, reason: string) => void) {
    this.client = new ExecutionClient(base, agent);
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
  async dispatch(scope: ExecutionScope, prepare: () => Promise<string>, seat: (prompt: string) => WorkerInfo | string, decorate: (prompt: string) => string = value => value) {
    return this.controller.guarded(scope, async () => {
      const context = this.contextVersion === 2 ? '' : await prepare();
      const grant = await this.controller.claim(scope, this.contextVersion);
      let seatedId: string | undefined;
      try {
        const immutablePrompt = executionPrompt(this.directory, this.client.base, this.agent, grant.lease, context);
        const prompt = (this.contextVersion === 2 ? immutablePrompt : decorate(immutablePrompt)).trim();
        this.seating = { ...grant, prompt };
        let worker: WorkerInfo | string;
        try { worker = seat(prompt); } finally { seatedId = this.seating?.workerId; this.seating = undefined; }
        if (typeof worker === 'string') throw new Error(worker);
        seatedId = worker.id;
        if (worker.status === 'exited') throw new Error('Worker failed to start; Canvas reservation released');
        this.controller.watch(worker.id, grant.lease, grant.deadline);
        if (!this.controller.allowed(worker.id)) throw new Error('Execution expired while starting worker');
        return { worker, execution: grant.lease, deadlineUnixMs: Date.now() + Math.max(0, grant.deadline - performance.now()) };
      } catch (error) {
        if (seatedId) { this.controller.forget(seatedId); this.stop(seatedId, 'Worker failed to start; worktree kept'); }
        await this.client.release(grant.lease).catch(() => {}); throw error;
      }
    });
  }
  async release(run: ExecutionHeld) {
    if (run.workerId) this.controller.forget(run.workerId);
    if (run.execution) await this.client.release(run.execution).catch(() => {});
  }
}

import path from 'node:path';
import type { WorkerInfo } from '../../shared/protocol.js';
import type { WorkerLaunchGuard } from '../workers/launch-guards.js';
import { assignmentModel, NO_HANDOUT_REASON, runOf, type CardModel } from './card-model.js';
import { verifyWorkerReadiness, type PreparedWorker } from './execution-worker-readiness.js';
import { ExecutionClient, validateExecution, type ExecutionLease, type ExecutionScope } from './execution-client.js';
import { ExecutionController } from './execution-controller.js';
import { executionPrompt } from './execution-prompt.js';
import { prepareExecution } from './execution-preflights.js';
import { validateBudgetFiles } from './execution-budget-files.js';
import { contextVersionFromEnvironment } from './execution-context.js';
import { PullRequestHandoff, type HandoffTools } from './pull-request-handoff.js';
import type { SelfCheckReporter } from './self-checks.js';
import { emitProcess, processHub } from '../process/hub.js';
import { recoverStoredResult } from './execution-recovery.js';
import { applyResume, resumePlan, type EarlierRun, type ResumePlan } from './execution-resume.js';
import { claimEvent, handoffEvent, releaseEvent } from '../process/opora-events.js';

export interface ExecutionHeld { workerId?: string; execution?: ExecutionLease; deadlineUnixMs?: number; leaseUntil?: string; state?: string;
  /** The worker and the branch (and base commit) its worktree was on, so a later run of the card can pick up its step commits (execution-resume.ts). */
  workerName?: string; branch?: string; worktreeBase?: string }

/** The bridge composes this feature; all execution authority remains server-private. */
export class ExecutionDispatch {
  readonly client: ExecutionClient;
  readonly controller: ExecutionController;
  /** Pushes a reported execution's commits and opens its pull request (see pull-request-handoff.ts). */
  readonly pullRequests: PullRequestHandoff;
  private readonly contextVersion = contextVersionFromEnvironment();
  /** The last worker info seen per worker, so a worker already sent home still hands its worktree off. */
  private worktrees = new Map<string, WorkerInfo>();
  private seating?: { lease: ExecutionLease; deadline: number; prompt: string; workerId?: string; resume?: ResumePlan };
  /** The floor's checkout, where earlier runs' branches are; without it a resumed run is told its commits aren't there. */
  floorDir?: string;
  /** Step commits of earlier runs still to be picked onto a worker's branch, right before its first launch. */
  private picks = new Map<string, ResumePlan>();
  /** Claims of different cards go to Opora one at a time: a Take made while another claims waits its turn. */
  private turn: Promise<unknown> = Promise.resolve();
  private inTurn<T>(run: () => Promise<T>): Promise<T> {
    const mine = this.turn.then(run, run);
    this.turn = mine.catch(() => {});
    return mine;
  }
  /** Hand-off outcomes already told to the process wall, per execution, PR and head (or reason), so callers joining one hand-off, and polls finding it done, don't repeat it. */
  private told = new Set<string>();
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
    // A 409 on the heartbeat once the result's receipt is stored is the run's normal end (execution-controller.ts).
    this.controller.ended = id => this.pullRequests.hasReceipt(id);
    // A result Canvas stored though the helper never saw its receipt is a finished run too (execution-recovery.ts).
    this.controller.recover = lease => recoverStoredResult(this.client, directory, lease);
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
        if (this.seating.resume) { this.picks.set(info.id, this.seating.resume); this.seating.resume = undefined; }
      }
      if (!this.controller.allowed(info.id)) return 'Canvas execution authority is missing or expired; take the card again';
      this.pick(info);
      return undefined;
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
  async dispatch(scope: ExecutionScope, prepare: () => Promise<string>, seat: (prompt: string, cardModel?: CardModel) => WorkerInfo | string, decorate: (prompt: string) => string = value => value,
    /** A design card's addendum (design-brief.ts), read before the claim like `prepare`. */
    design: () => Promise<string> = async () => '', prepareWorker?: () => Promise<PreparedWorker>) {
    return this.controller.guarded(scope, async () => {
      const context = this.contextVersion === 2 ? '' : await prepare();
      const brief = await design().catch(() => '');
      const prepared = await prepareExecution({ client: this.client, scope, contextVersion: this.contextVersion });
      const reserved = await prepareWorker?.(); let committed = false;
      try {
        const grant = await this.inTurn(() => this.controller.claim(scope, this.contextVersion)).catch((e: Error) => { emitProcess(this.agent, claimEvent(scope, { error: e.message })); throw e; });
        let seatedId: string | undefined;
        try {
          prepared(grant.lease);
          // An XL card (`run.handout: false`) is the heart's to split, never a worker's: its lease goes back.
          if (runOf(grant.lease.assignment)?.handout === false) throw new Error(NO_HANDOUT_REASON);
          await verifyWorkerReadiness(this.controller, grant, reserved);
          const resume = this.resumePlan(grant.lease);
          const immutablePrompt = executionPrompt(this.directory, this.client.base, this.agent, grant.lease, context, brief, resume);
          const prompt = (this.contextVersion === 2 ? immutablePrompt : decorate(immutablePrompt)).trim();
          this.seating = { ...grant, prompt, resume };
          let worker: WorkerInfo | string, unpicked: ResumePlan | undefined;
          try { const cardPick = assignmentModel(grant.lease.assignment); worker = reserved ? reserved.start(prompt, cardPick) : seat(prompt, cardPick); } finally { seatedId = this.seating?.workerId; unpicked = this.seating?.resume; this.seating = undefined; }
          if (typeof worker === 'string') throw new Error(worker);
          seatedId = worker.id;
          // Launched after its worktree setup: the commits go on its branch at that launch (guard.check).
          if (unpicked) this.picks.set(worker.id, unpicked);
          if (worker.status === 'exited') throw new Error('Worker failed to start; Canvas reservation released');
          this.controller.watch(worker.id, grant.lease, grant.deadline);
          if (!this.controller.allowed(worker.id)) throw new Error('Execution expired while starting worker');
          processHub.noteExecution(worker.id, grant.lease.executionId); emitProcess(this.agent, claimEvent(scope, { executionId: grant.lease.executionId, workerId: worker.id, workerName: worker.name }));
          committed = true;
          return { worker, execution: grant.lease, deadlineUnixMs: Date.now() + Math.max(0, grant.deadline - performance.now()) };
        } catch (error) {
          if (seatedId) { this.picks.delete(seatedId); this.controller.forget(seatedId); this.stop(seatedId, 'Worker failed to start; worktree kept'); }
          await this.client.release(grant.lease).catch(() => {}); throw error;
        }
      } finally { if (!committed) await reserved?.cancel(); }
    });
  }
  /** Earlier runs of this office with the branch their worktree was on, for a resumed card. */
  private earlier(): EarlierRun[] {
    return this.runs().flatMap(run => {
      const id = run.execution?.executionId, seen = run.workerId ? this.worktrees.get(run.workerId)?.worktree : undefined;
      // Runs saved before the branch was kept: a worker's branch is office/<name>-<first 4 of its id> (workers/manager.ts).
      const branch = run.branch ?? seen?.branch ?? (run.workerName && run.workerId ? `office/${run.workerName.toLowerCase()}-${run.workerId.slice(0, 4)}` : undefined);
      return id && branch ? [{ executionId: id, branch, base: run.worktreeBase ?? seen?.base }] : [];
    });
  }
  private resumePlan(lease: ExecutionLease): ResumePlan | undefined {
    if (!lease.progress?.done) return undefined;
    if (!this.floorDir) return { state: 'missing', done: lease.progress.steps.filter(s => s.status === 'done').map(s => s.id), resumeAt: lease.progress.current,
      first: lease.progress.steps[0]?.id ?? 'the first step', reason: 'this floor has no git checkout to look in' };
    try { return resumePlan(lease, this.earlier(), this.floorDir); } catch { return undefined; }
  }
  /** Right before a resumed worker's first launch: the earlier runs' step commits onto its fresh branch. */
  private pick(info: WorkerInfo) {
    const plan = this.picks.get(info.id);
    if (!plan || !info.worktree || !this.floorDir) return;
    this.picks.delete(info.id);
    const out = applyResume(path.join(this.floorDir, info.worktree.path), plan);
    const lease = this.runs().find(run => run.workerId === info.id)?.execution ?? this.seating?.lease;
    if (out.ok) console.log(`[opora] ${info.name}: picked ${plan.state === 'picks' ? plan.picks.length : 0} step commit(s) of an earlier run onto ${info.worktree.branch}${lease ? ` for ${lease.executionId}` : ''}`);
    else console.warn(`[opora] ${info.name}: couldn't pick the earlier run's step commits onto ${info.worktree.branch} (${out.reason}); it redoes them`);
  }
  /** Its worker paused on a usage limit, or carried on: authority follows execution-controller's rule, once per pause. */
  onWorker(info: WorkerInfo) {
    const key = info.paused ? `${info.paused.kind}@${info.paused.resetsAt ?? '?'}` : undefined;
    if (this.pauses.get(info.id) === key) return;
    if (key) this.pauses.set(info.id, key); else this.pauses.delete(info.id);
    if (info.paused) this.controller.usageLimit(info.id, info.paused.resetsAt);
  }
  private pauses = new Map<string, string>();
  /** Hands a reported execution's work off as a pull request, from the worker's worktree under `floorDir`. */
  handOff(run: ExecutionHeld & { cardName?: string }, info: WorkerInfo | undefined, floorDir: string,
    notify: (message: string, level: 'info' | 'warn' | 'error') => void) {
    if (run.workerId && info?.worktree) this.worktrees.set(run.workerId, info);
    const wt = (info ?? (run.workerId ? this.worktrees.get(run.workerId) : undefined))?.worktree;
    if (!run.execution || !wt?.base) return undefined;
    const lease = run.execution, dir = path.join(floorDir, wt.path);
    const handoff = this.pullRequests.handOff({ lease, cardName: run.cardName, dir, baseCommit: wt.base, baseBranch: wt.from }, notify);
    // The evidence runs after the pull request is out, without holding the lease for it.
    void handoff?.then(out => {
      const key = [lease.executionId, out.state, 'number' in out ? out.number : '', 'headSha' in out ? out.headSha ?? '' : '', 'reason' in out ? out.reason : ''].join('|');
      if (!this.told.has(key)) { this.told.add(key); emitProcess(this.agent, handoffEvent(lease, out)); }
      if (out.state === 'opened' || out.state === 'reused') return this.selfChecks?.report({
        project: lease.project, workspace: lease.workspace, executionId: lease.executionId, headSha: out.headSha, dir });
    }).catch(() => {});
    return handoff;
  }
  async release(run: ExecutionHeld) {
    await this.pullRequests.settled(run.execution?.executionId);
    if (run.workerId) this.worktrees.delete(run.workerId);
    if (run.workerId) this.controller.forget(run.workerId);
    for (const key of this.told) if (key.startsWith(run.execution?.executionId + '|')) this.told.delete(key);
    if (run.execution) emitProcess(this.agent, releaseEvent(run.execution, run.workerId));
    processHub.noteExecution(run.workerId, undefined);
    if (run.execution) await this.client.release(run.execution).catch(() => {});
  }
}

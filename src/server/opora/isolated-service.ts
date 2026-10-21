import path from 'node:path';
import { existsSync } from 'node:fs';
import type { OporaState } from '../../shared/protocol/opora.js';
import { inFocus } from '../../shared/opora-scope.js';
import { createIsolatedExecutorRoutes, IsolatedExecutorRouteError, type IsolatedOfficeAccess } from '../http/routes/isolated-executors.js';
import { ExecutionClient } from './execution-client.js';
import { ExecutionController } from './execution-controller.js';
import { contextVersionFromEnvironment, type ContextVersion } from './execution-context.js';
import { ExecutorJournal } from './executors/journal.js';
import { ManagedAgentsExecutor } from './executors/managed-agents.js';
import { ManagedAgentsHttp } from './executors/managed-http.js';
import { ExecutorRegistry } from './executors/registry.js';
import { canonical, digest } from './executors/validation.js';
import { PROVIDER, type ExecutionIntent, type ExecutorStatus } from './executors/types.js';
import { isolatedConfiguration, canvasBase, publishedRepository, type IsolatedConfiguration } from './isolated-config.js';
import { isolatedClaim } from './isolated-claim.js';
import { IsolatedObserver, observationPayload } from './isolated-observer.js';
import { IsolatedStore, type IsolatedRequest, type IsolatedRun } from './isolated-storage.js';
import { isolatedTransport } from './isolated-transport.js';
import { readRemoteReport, remoteReportInstructions } from './isolated-reports.js';
import { findIsolatedReceipt, nativeResultPayload, submitIsolatedResult } from './isolated-results.js';
import { IsolatedPullRequests, patchInstructions } from './isolated-pull-request.js';
import { createSelfCheckReporter } from './self-checks.js';

export interface IsolatedFloor { id: string; dir: string; view(): OporaState; alive(): boolean }
export interface IsolatedOptions {
  configuration?: IsolatedConfiguration | null; transport?: typeof fetch;
  repository?: () => ExecutionIntent['repository']; contextVersion?: ContextVersion; pollMs?: number; autoRecover?: boolean;
  /** Opens the run's pull request from its returned patch (isolated-pull-request.ts); null turns that off. */
  pullRequests?: IsolatedPullRequests | null;
}
/** Independent opt-in broker. No worker-manager, autopilot, CLI or local working-context access. */
export class IsolatedOfficeService implements IsolatedOfficeAccess {
  private closed = false;
  private config: IsolatedConfiguration | null;
  private store?: IsolatedStore;
  private journal?: ExecutorJournal;
  private broken = false;
  private transport: typeof fetch;
  private controllers = new Map<string, ExecutionController>();
  private executors = new Map<string, ManagedAgentsExecutor>();
  private queues = new Map<string, Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private registry = new ExecutorRegistry();
  private stopping = new Map<string, Promise<unknown>>();
  private pullRequests?: IsolatedPullRequests;
  constructor(private floor: IsolatedFloor, private options: IsolatedOptions = {}) {
    this.config = options.configuration === undefined ? isolatedConfiguration() : options.configuration;
    this.transport = isolatedTransport(options.transport ?? fetch);
    const directory = path.join(floor.dir, '.agent-office', 'isolated-executions');
    if (this.config || existsSync(directory)) {
      try { this.journal = new ExecutorJournal(path.join(directory, 'provider')); this.store = new IsolatedStore(path.join(directory, 'requests')); this.store.list(); }
      catch { this.broken = true; }
    }
    if (this.config && !this.broken) {
      const agent = `office-isolated-${floor.id}`, log = (m: string, level: string) => (level === 'info' ? console.log : console.warn)(`[opora] ${m}`);
      this.pullRequests = options.pullRequests === undefined ? new IsolatedPullRequests(floor.dir, path.join(directory, 'pull-requests'), this.config.canvas, agent,
        undefined, createSelfCheckReporter(this.config.canvas, agent, path.join(directory, 'pull-requests'), log)) : options.pullRequests ?? undefined;
      this.registry.register(new ManagedAgentsExecutor(new ManagedAgentsHttp(this.config.managed, this.config.secrets, this.transport), this.journal!));
      this.timer = setInterval(() => { if (!this.ticking) { this.ticking = true; void this.tick().finally(() => { this.ticking = false; }).catch(() => {}); } }, options.pollMs ?? 60000);
      this.timer.unref?.();
      if (options.autoRecover !== false) queueMicrotask(() => { void this.reconcileRuns(false).catch(() => {}); });
    }
  }
  private check(scope?: Pick<IsolatedRun, 'project' | 'workspace' | 'base'>) {
    if (this.closed || !this.floor.alive() || !this.config || this.broken || !this.store || !this.journal) throw new IsolatedExecutorRouteError('unavailable');
    const view = this.floor.view();
    if (!view.connected || !view.project || !view.workspace || canvasBase(view.url) !== this.config.canvas
      || (scope && (view.project.id !== scope.project || view.workspace !== scope.workspace || scope.base !== this.config.canvas)))
      throw new IsolatedExecutorRouteError('unavailable');
    return view;
  }
  private current(key: string) { const run = this.store?.read(key); if (!run) throw new IsolatedExecutorRouteError('conflict'); return run; }
  private patch(key: string, fields: Partial<IsolatedRun>) { const next = { ...this.current(key), ...fields }; this.store!.save(next); return next; }
  private serial<T>(key: string, action: () => Promise<T>) {
    const prior = this.queues.get(key) ?? Promise.resolve(), next = prior.catch(() => {}).then(action);
    this.queues.set(key, next); void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => {}); return next;
  }
  private controller(run: IsolatedRun) {
    let controller = this.controllers.get(run.key);
    if (!controller) {
      controller = new ExecutionController(new ExecutionClient(run.base, `office-isolated-${this.floor.id}`, this.transport),
        (_id, lease) => { this.patch(run.key, { lease }); },
        () => { this.markRevoked(run.key); void this.stopRun(run.key).catch(() => {}); });
      this.controllers.set(run.key, controller);
    }
    return controller;
  }
  private permitted(run: IsolatedRun, leased = false) {
    const view = this.check(run);
    if (!inFocus(view.scope, view.focus, run.input.cardId) || !view.cards.some(card => card.id === run.input.cardId)
      || ['unknown', 'failed', 'termination_pending', 'terminated'].includes(run.stage)
      || (leased && !this.controller(run).allowed(run.key))) throw new IsolatedExecutorRouteError('conflict');
    return view;
  }
  private executor(run: IsolatedRun) {
    let executor = this.executors.get(run.key);
    if (!executor) {
      const guarded: typeof fetch = async (url, init) => {
        const endpoint = new URL(String(url));
        const starts = init?.method === 'POST' && (endpoint.pathname === '/v1/sessions'
          || (endpoint.pathname.endsWith('/events') && String(init.body).includes('user.message')));
        if (starts) this.permitted(this.current(run.key), true);
        return this.transport(url, init);
      };
      executor = new ManagedAgentsExecutor(new ManagedAgentsHttp(this.config!.managed, this.config!.secrets, guarded), this.journal!);
      this.executors.set(run.key, executor);
    }
    return executor;
  }
  private observer(run: IsolatedRun) {
    if (!this.config || run.base !== this.config.canvas) throw new IsolatedExecutorRouteError('unavailable');
    return new IsolatedObserver(this.config.canvas, this.config.observer, this.transport);
  }
  async capabilities() {
    try {
      this.check();
      await this.registry.require(PROVIDER, { isolation: true }); this.check();
      return { executorId: PROVIDER, available: true, isolation: 'provider-cloud-container', usage: 'provider-api', invoiceHardLimit: false, exactTerminationDeadline: false };
    } catch { return { executorId: PROVIDER, available: false, isolation: 'unverified', usage: 'unavailable', invoiceHardLimit: false, exactTerminationDeadline: false }; }
  }
  async status() { return { items: (this.store?.list() ?? []).map(run => this.publicRun(run)) }; }
  private publicRun(run: IsolatedRun) {
    let provider: ExecutorStatus | null = null;
    if (run.intent && this.journal) {
      try { provider = this.executor(run).status(run.intent.intentId); } catch { /* Unknown private state is not verified execution. */ }
    }
    return { requestId: run.input.requestId, cardId: run.input.cardId, project: run.project, workspace: run.workspace,
      intentId: run.intent?.intentId ?? null, executionId: run.lease?.executionId ?? null, state: provider?.state ?? run.stage,
      sessionId: provider?.sessionId ?? null, observation: provider?.observation ?? null,
      accounting: run.pendingObservation ? 'pending' : run.observationHead ? 'canvas-recorded' : 'unavailable', observationHead: run.observationHead,
      authorityActive: this.authorityActive(run), providerStatus: provider?.observation?.status ?? null,
      providerStateSource: provider?.observation ? 'provider-api' : 'unavailable',
      providerFreshness: provider?.observation && Date.now() - provider.observation.observedAt <= 120000 ? 'recent-readback' : 'stale-or-unknown',
      receiptId: run.resultReceipt?.receiptId ?? null, resultStatus: run.resultReceipt ? 'reported' : run.pendingResult ? 'unconfirmed' : 'none',
      verification: run.resultReceipt ? 'agent-reported; not independently verified' : null };
  }
  private authorityActive(run: IsolatedRun) {
    try { this.permitted(run, true); return true; } catch { return false; }
  }
  async start(input: IsolatedRequest) {
    if (input.executorId !== PROVIDER) throw new IsolatedExecutorRouteError('unavailable');
    const view = this.check(), scope = { project: view.project!.id, workspace: view.workspace!, base: this.config!.canvas };
    return this.serial('scope:' + canonical(scope), async () => {
      const key = digest({ floor: this.floor.id, requestId: input.requestId });
      const existing = this.store!.read(key);
      if (existing) {
        if (canonical(existing.input) !== canonical(input) || existing.project !== scope.project || existing.workspace !== scope.workspace || existing.base !== scope.base)
          throw new IsolatedExecutorRouteError('conflict');
        return this.publicRun(existing);
      }
      const current = this.check(scope);
      if (!current.cards.some(card => card.id === input.cardId && card.status === 'frontier') || !inFocus(current.scope, current.focus, input.cardId)
        || this.store!.list().some(run => run.project === scope.project && run.workspace === scope.workspace && run.input.cardId === input.cardId
          && !['terminated', 'failed'].includes(run.stage))) throw new IsolatedExecutorRouteError('conflict');
      if (!(await this.capabilities()).available) throw new IsolatedExecutorRouteError('unavailable');
      const repository = (this.options.repository ?? (() => publishedRepository(this.floor.dir)))();
      this.check(scope);
      this.store!.save({ key, input: structuredClone(input), ...scope, stage: 'prepared', claim: null, lease: null, intent: null,
        observationHead: null, observationSequence: 0, pendingObservation: null, lastObservationSemantic: null,
        terminalPolls: 0, nextPollAt: 0, pendingResult: null, resultReceipt: null });
      try {
        let run = this.current(key);
        await isolatedClaim(this.store!, key, this.options.contextVersion ?? contextVersionFromEnvironment(), `office-isolated-${this.floor.id}`,
          this.transport, () => { this.permitted(this.current(key)); });
        run = this.current(key);
        const controller = this.controller(run), renewed = await controller.revalidate(run.lease!);
        this.patch(key, { lease: renewed.lease }); controller.watch(key, renewed.lease, renewed.deadline);
        run = this.current(key); this.permitted(run, true);
        const lease = run.lease!;
        const intent = await this.observer(run).bind({ requestId: run.claim!.requestId, provider: PROVIDER, project: run.project, workspace: run.workspace,
          nodeId: input.cardId, executionId: lease.executionId, epoch: lease.epoch, acceptedRevision: lease.acceptedRevision,
          assignmentDigest: lease.assignmentDigest, contextProtocolVersion: lease.contextProtocolVersion ?? 1, contextVersion: String(lease.assignment.contextVersion),
          executionProtocolVersion: 2, budget: lease.budget!, authorityDeadlineAt: lease.budget!.runDeadlineAt, repository,
          ...this.config!.managed });
        run = this.patch(key, { intent, stage: 'bound' });
        await this.report(key, null); this.permitted(this.current(key), true);
        const result = await this.executor(run).start(intent, remotePrompt(lease.assignment) + '\n' + patchInstructions(intent) + '\n' + remoteReportInstructions(intent), async () => {
          try {
            this.permitted(this.current(key), true);
            await this.report(key, this.executor(this.current(key)).status(intent.intentId));
            this.permitted(this.current(key), true);
            const fresh = await controller.revalidate(this.current(key).lease!);
            this.patch(key, { lease: fresh.lease }); controller.watch(key, fresh.lease, fresh.deadline);
            this.permitted(this.current(key), true); return true;
          } catch { return false; }
        });
        this.permitted(this.current(key), true);
        this.patch(key, { stage: 'running' }); await this.report(key, result);
        return this.publicRun(this.current(key));
      } catch {
        this.markRevoked(key); await this.stopRun(key).catch(() => {});
        throw new IsolatedExecutorRouteError('unavailable');
      }
    });
  }
  private async report(key: string, status: ExecutorStatus | null) {
    return this.serial('observation:' + key, () => this.reportOnce(key, status));
  }
  private async reportOnce(key: string, status: ExecutorStatus | null) {
    let run = this.current(key); if (!run.intent) return;
    if (status && this.journal?.read(run.intent.intentId)) status = this.executor(run).status(run.intent.intentId);
    if (run.pendingObservation) {
      const pending = run.pendingObservation, previous = await this.observer(run).observation(pending);
      run = this.patch(key, { observationHead: previous.id, observationSequence: Number(previous.sequence), pendingObservation: null,
        lastObservationSemantic: observationSemantic(pending) });
    }
    const payload = observationPayload(run.intent!, status, run.observationHead, run.observationSequence + 1);
    const semantic = observationSemantic(payload);
    if (run.lastObservationSemantic === semantic) return;
    this.patch(key, { pendingObservation: payload });
    const accepted = await this.observer(run).observation(payload);
    this.patch(key, { observationHead: accepted.id, observationSequence: Number(accepted.sequence), pendingObservation: null, lastObservationSemantic: semantic });
  }
  private markRevoked(key: string) {
    this.controllers.get(key)?.forget(key);
    try { if (this.current(key).stage !== 'terminated') this.patch(key, { stage: 'termination_pending' }); }
    catch { this.broken = true; }
  }
  private async stopRun(key: string) {
    const existing = this.stopping.get(key); if (existing) return existing;
    const stopping = this.performStop(key); this.stopping.set(key, stopping);
    void stopping.finally(() => this.stopping.delete(key)).catch(() => {});
    return stopping;
  }
  private async performStop(key: string) {
    const run = this.current(key); this.markRevoked(key);
    let status: ExecutorStatus | null = null;
    if (run.intent && this.journal?.read(run.intent.intentId)) status = await this.executor(run).revoke(run.intent.intentId);
    if (status?.state === 'terminated') this.patch(key, { stage: 'terminated' });
    else if (!run.intent || !this.journal?.read(run.intent.intentId)) this.patch(key, { stage: run.claim ? 'unknown' : 'failed' });
    if (run.lease) await new ExecutionClient(run.base, `office-isolated-${this.floor.id}`, this.transport).release(run.lease).catch(() => {});
    if (run.intent) await this.report(key, status);
    return this.publicRun(this.current(key));
  }
  async stop(input: { intentId: string }) {
    const run = this.store?.list().find(value => value.intent?.intentId === input.intentId);
    if (!run || !this.config) throw new IsolatedExecutorRouteError('conflict');
    this.markRevoked(run.key); return this.stopRun(run.key);
  }
  async reconcile() { return this.reconcileRuns(true); }
  private async reconcileRuns(explicit: boolean) {
    if (!this.config || !this.store || !this.journal || this.broken) throw new IsolatedExecutorRouteError('unavailable');
    for (const run of this.store.list()) {
      if (run.intent && this.journal.read(run.intent.intentId)) {
        const original = this.executor(run).status(run.intent.intentId);
        if (!explicit && original.state === 'terminated' && run.terminalPolls >= 3) continue;
        const status = original.state === 'terminated' ? await this.executor(run).observe(run.intent.intentId) : await this.executor(run).reconcile(run.intent.intentId);
        this.patch(run.key, { stage: status.state === 'terminated' ? 'terminated' : 'termination_pending' });
        if (!explicit && status.state === 'terminated') this.patch(run.key, { terminalPolls: Math.min(3, run.terminalPolls + 1) });
        if (run.pendingResult && !run.resultReceipt) await this.submitPendingResult(run.key);
        if (run.lease) await new ExecutionClient(run.base, `office-isolated-${this.floor.id}`, this.transport).release(run.lease).catch(() => {});
        await this.report(run.key, status);
      } else if (run.stage !== 'failed') { this.markRevoked(run.key); await this.stopRun(run.key); }
    }
    return this.status();
  }
  private async tick() {
    if (this.closed || !this.store) return;
    for (const run of this.store.list()) {
      if (run.nextPollAt > Date.now()) continue;
      try {
        if (run.stage === 'running' && run.intent) {
          this.patch(run.key, { nextPollAt: Date.now() + (this.options.pollMs ?? 60000) });
          this.permitted(run, true);
          const status = await this.executor(run).observe(run.intent.intentId); await this.report(run.key, status);
          if (await this.captureResult(run.key, status)) continue;
          if (status.state === 'terminated') { this.markRevoked(run.key); await this.stopRun(run.key); }
        } else if (run.stage === 'terminated' && run.intent && run.terminalPolls < 3) {
          this.patch(run.key, { terminalPolls: run.terminalPolls + 1, nextPollAt: Date.now() + (this.options.pollMs ?? 60000) });
          await this.report(run.key, await this.executor(run).observe(run.intent.intentId));
        } else if (run.stage === 'termination_pending') await this.stopRun(run.key);
      } catch { if (run.stage !== 'terminated') { this.markRevoked(run.key); await this.stopRun(run.key).catch(() => {}); } }
    }
  }
  private async captureResult(key: string, status: ExecutorStatus) {
    const run = this.current(key); if (!run.intent || !status.sessionId || !run.lease) return false;
    this.permitted(run, true);
    if (!run.pendingResult && !run.resultReceipt) {
      const http = new ManagedAgentsHttp(this.config!.managed, this.config!.secrets, this.transport);
      const report = await readRemoteReport(http, run.intent, status.sessionId);
      if (!report) return false;
      this.permitted(this.current(key), true);
      this.patch(key, { pendingResult: { report, payload: nativeResultPayload(run.lease, report), attempted: false } });
    }
    await this.submitPendingResult(key);
    // Its pull request goes out while the lease still holds, as a card worker's does (isolated-pull-request.ts).
    await this.pullRequests?.handOff(this.current(key), (m, level) => (level === 'info' ? console.log : console.warn)(`[opora] ${m}`)).catch(() => undefined);
    this.markRevoked(key); await this.stopRun(key); return true;
  }
  private async submitPendingResult(key: string) {
    return this.serial('result:' + key, async () => {
      const run = this.current(key); if (!run.pendingResult || run.resultReceipt || !run.lease) return;
      if (!this.config || run.base !== this.config.canvas) throw new IsolatedExecutorRouteError('unavailable');
      const pending = run.pendingResult;
      let receipt: Record<string, unknown> | null;
      if (!this.authorityActive(run)) {
        receipt = await findIsolatedReceipt(run.base, `office-isolated-${this.floor.id}`, run.lease, pending.report, this.transport);
        if (!receipt) throw new Error('Original result remains unconfirmed');
      } else {
        this.permitted(run, true);
        this.patch(key, { pendingResult: { ...pending, attempted: true } });
        receipt = await submitIsolatedResult(run.base, `office-isolated-${this.floor.id}`, run.lease, pending.report, pending.payload, this.transport);
      }
      this.patch(key, { resultReceipt: receipt }); this.controllers.get(key)?.forget(key);
    });
  }
  shutdown() {
    this.closed = true; clearInterval(this.timer);
    for (const controller of this.controllers.values()) controller.shutdown();
    let runs: IsolatedRun[] = [];
    try { runs = this.store?.list() ?? []; } catch { this.broken = true; }
    for (const run of runs) if (run.stage !== 'terminated') this.markRevoked(run.key);
    void Promise.allSettled(runs.map(run => this.stopRun(run.key))).finally(() => this.journal?.close());
  }
}
function observationSemantic(payload: Record<string, unknown>) {
  return digest({ status: payload.status, providerStatus: payload.providerStatus, sessionId: payload.sessionId, cumulative: payload.cumulative });
}
/** Contains the already redacted immutable assignment only, never a lease capability or local API route. */
export function remotePrompt(assignment: Record<string, unknown>) {
  return 'Work only on the accepted immutable assignment below in /workspace/repo. Do not claim independent verification. Return a concise result and changed files.\n'
    + canonical(assignment);
}
export const isolatedExecutorRoutes = createIsolatedExecutorRoutes((_ctx, floor) => floor.isolatedExecutions);

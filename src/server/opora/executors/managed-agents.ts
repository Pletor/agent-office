import { monotonic, validateIntent } from './validation.js';
import { ManagedAgentsHttp } from './managed-http.js';
import { ExecutorJournal } from './journal.js';
import { ExecutorFailure, PROVIDER, type ExecutionIntent, type ExecutionRecord, type ExecutorRequirements, type ExecutorStatus, type RemoteExecutor } from './types.js';

type Runtime = { intent: ExecutionIntent; sessionId?: string; revoked: boolean; abort: AbortController; timer?: ReturnType<typeof setTimeout>; deadline: number };
/** Only a trusted server composes this broker; workers never receive it, its journal or credentials. */
export class ManagedAgentsExecutor implements RemoteExecutor {
  readonly provider = PROVIDER;
  private queues = new Map<string, Promise<unknown>>();
  private runtimes = new Map<string, Runtime>();
  private stops = new Map<string, Promise<ExecutorStatus>>();
  constructor(private http: ManagedAgentsHttp, private journal: ExecutorJournal, private now = () => Date.now(),
    private monotonicNow = () => performance.now(), private validationTimeoutMs = 10000) {}
  async available(requirements: ExecutorRequirements) {
    if (requirements.isolation !== true || requirements.invoiceHardLimit || requirements.exactTerminationDeadline) return false;
    try { await this.http.verify(); return true; } catch { return false; }
  }
  private serial<T>(identifier: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(identifier) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    this.queues.set(identifier, next);
    void next.finally(() => { if (this.queues.get(identifier) === next) this.queues.delete(identifier); }).catch(() => {});
    return next;
  }
  private record(identifier: string): ExecutionRecord {
    const value = this.journal.read(identifier);
    if (!value) throw new ExecutorFailure();
    return value;
  }
  private arm(intent: ExecutionIntent): Runtime {
    const existing = this.runtimes.get(intent.intentId);
    if (existing) return existing;
    const remaining = Math.max(0, intent.authorityDeadlineAt * 1000 - this.now());
    const runtime: Runtime = { intent, revoked: remaining <= 0, abort: new AbortController(), deadline: this.monotonicNow() + remaining };
    this.runtimes.set(intent.intentId, runtime);
    const expire = () => { void this.revoke(intent.intentId).catch(() => {}); };
    runtime.timer = setTimeout(expire, Math.min(remaining, 2147483647)); runtime.timer.unref?.();
    return runtime;
  }
  private assertAuthority(intent: ExecutionIntent, runtime: Runtime) {
    if (runtime.revoked || runtime.abort.signal.aborted || this.now() >= intent.authorityDeadlineAt * 1000
      || this.monotonicNow() >= runtime.deadline) throw new ExecutorFailure();
  }
  status(identifier: string): ExecutorStatus {
    const value = this.record(identifier);
    return { intentId: identifier, executionId: value.intent.executionId, epoch: value.intent.epoch,
      state: value.state, sessionId: value.sessionId, observation: value.observation };
  }
  async start(input: ExecutionIntent, prompt: string, revalidate: () => Promise<boolean>): Promise<ExecutorStatus> {
    const intent = validateIntent(input);
    if (!this.http.matches(intent) || !prompt || Buffer.byteLength(prompt) > 1024 * 1024) throw new ExecutorFailure();
    return this.serial(intent.intentId, async () => {
      // Any existing intent is reconciliation-only, even if the first caller lost its response.
      if (this.journal.read(intent.intentId)) throw new ExecutorFailure();
      this.journal.create(intent);
      const runtime = this.arm(intent);
      let sessionId: string | undefined;
      try {
        this.assertAuthority(intent, runtime);
        await this.http.environment(runtime.abort.signal);
        this.assertAuthority(intent, runtime);
        this.journal.advance(intent.intentId, 'creating');
        try { sessionId = await this.http.create(intent, runtime.abort.signal); }
        catch { this.journal.advance(intent.intentId, 'creation_unknown'); throw new ExecutorFailure(); }
        runtime.sessionId = sessionId;
        try { this.journal.advance(intent.intentId, 'mapped', sessionId); }
        catch {
          // Mapping could not be made durable: never send work. Still attempt provider stop using the known ID.
          await this.stopUnmapped(intent, sessionId); throw new ExecutorFailure();
        }
        this.assertAuthority(intent, runtime);
        const observed = await this.http.observe(intent, sessionId, runtime.abort.signal);
        if (observed.status !== 'idle') throw new ExecutorFailure();
        this.journal.advance(intent.intentId, 'mapped', undefined, observed);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const valid = await Promise.race([revalidate(), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), this.validationTimeoutMs); })]);
          this.assertAuthority(intent, runtime);
          if (!valid) throw new ExecutorFailure();
        } finally { clearTimeout(timer); }
        this.journal.advance(intent.intentId, 'starting');
        await this.http.start(sessionId, prompt, runtime.abort.signal);
        this.assertAuthority(intent, runtime);
        this.journal.advance(intent.intentId, 'running');
        return this.status(intent.intentId);
      } catch {
        runtime.revoked = true; runtime.abort.abort(); clearTimeout(runtime.timer);
        if (sessionId) await this.revoke(intent.intentId).catch(() => {});
        throw new ExecutorFailure();
      }
    });
  }
  async observe(identifier: string): Promise<ExecutorStatus> {
    return this.serial(identifier, async () => {
      const record = this.record(identifier);
      if (!record.sessionId) throw new ExecutorFailure();
      if (record.state === 'terminated') {
        // Final usage may settle after archival. Refresh accounting without restoring execution authority.
        const observation = await this.http.observeForStop(record.intent, record.sessionId);
        if (observation.status !== 'terminated') throw new ExecutorFailure();
        monotonic(record.observation, observation);
        this.journal.advance(identifier, 'terminated', undefined, observation);
        return this.status(identifier);
      }
      if (record.state === 'termination_pending') return this.revoke(identifier);
      const runtime = this.arm(record.intent);
      if (runtime.revoked || this.monotonicNow() >= runtime.deadline) return this.revoke(identifier);
      try {
        const observation = await this.http.observe(record.intent, record.sessionId, runtime.abort.signal);
        this.assertAuthority(record.intent, runtime);
        monotonic(record.observation, observation);
        this.journal.advance(identifier, observation.status === 'terminated' ? 'terminated' : record.state, undefined, observation);
        if (observation.status === 'terminated') { runtime.revoked = true; clearTimeout(runtime.timer); }
        return this.status(identifier);
      } catch { await this.revoke(identifier).catch(() => {}); throw new ExecutorFailure(); }
    });
  }
  /** Revocation bypasses a blocked start/observe queue and aborts its HTTP wait immediately. */
  async revoke(identifier: string): Promise<ExecutorStatus> {
    const runtime = this.runtimes.get(identifier);
    if (runtime) { runtime.revoked = true; runtime.abort.abort(); clearTimeout(runtime.timer); }
    const current = this.stops.get(identifier); if (current) return current;
    const operation = this.stop(identifier).catch(async () => {
      if (runtime?.sessionId) await this.stopUnmapped(runtime.intent, runtime.sessionId);
      throw new ExecutorFailure();
    });
    this.stops.set(identifier, operation);
    void operation.finally(() => this.stops.delete(identifier)).catch(() => {});
    return operation;
  }
  private async stop(identifier: string): Promise<ExecutorStatus> {
    const record = this.record(identifier);
    if (record.state === 'terminated') return this.status(identifier);
    if (!record.sessionId) {
      if (record.state === 'creating') this.journal.advance(identifier, 'creation_unknown');
      return this.status(identifier);
    }
    if (record.state !== 'termination_pending') this.journal.advance(identifier, 'termination_pending');
    try {
      let observation = await this.http.observeForStop(record.intent, record.sessionId);
      if (observation.status !== 'terminated') {
        await this.http.interrupt(record.sessionId);
        observation = await this.http.observeForStop(record.intent, record.sessionId);
        if (observation.status === 'idle') {
          await this.http.archive(record.sessionId);
          observation = await this.http.observeForStop(record.intent, record.sessionId);
        }
      }
      monotonic(record.observation, observation);
      this.journal.advance(identifier, observation.status === 'terminated' ? 'terminated' : 'termination_pending', undefined, observation);
    } catch { /* Unknown provider outcome remains durable termination_pending, never a success claim. */ }
    return this.status(identifier);
  }
  private async stopUnmapped(intent: ExecutionIntent, sessionId: string) {
    try {
      await this.http.interrupt(sessionId);
      const observation = await this.http.observeForStop(intent, sessionId);
      if (observation.status === 'idle') await this.http.archive(sessionId);
    } catch { /* The poisoned journal blocks every further launch. Operator reconciliation is required. */ }
  }
  async reconcile(identifier: string): Promise<ExecutorStatus> {
    return this.serial(identifier, async () => {
      const record = this.record(identifier);
      if (record.state === 'creating') this.journal.advance(identifier, 'creation_unknown');
      // A restart never resends initial work or silently renews an old lease.
      if (record.sessionId && record.state !== 'terminated') return this.revoke(identifier);
      return this.status(identifier);
    });
  }
}

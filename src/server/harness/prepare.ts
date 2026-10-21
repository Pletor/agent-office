// The preparation runner (docs/harness.md "Preparation runner"): before the bridge claims an Opora card
// and seats its worker, a script, not the model, prepares the run from IDs: it resolves the card's
// profile, checks that every bound element and every adapter is available, writes the run snapshot,
// has each adapter prepare its part, and verifies the result. Only a run in `prepared` is claimed, and
// only a claimed one is seated (prepare-store.ts holds the state machine). Each step has a timeout and a
// retry budget, each failed attempt is recorded with its reason, and a step that fails for good rolls
// back everything the run created (adapters' work, the scoped folder, the snapshot) and leaves a report
// of what was done and what was undone; the card is not claimed. A dry run reports the whole plan and
// writes nothing. Preparing is idempotent per card and run: taking a card whose run was prepared and not
// yet claimed (an office restarted in between) finds that run, checks it still matches its inputs, and
// uses it, without writing or preparing anything a second time.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { HarnessError, HarnessProfiles, harnessRepoKey } from './profiles.js';
import { cardBinding, resolveHandoff, type ResolvedHandoff } from './handoff.js';
import { HARNESS_GUIDES } from './guides.js';
import { buildSnapshot, loadSnapshot, persistSnapshot, snapshotDir, type StoredSnapshot } from './snapshot.js';
import { contextAdapter, listAdapters, resolveAdapters, type AdapterContext, type AdapterResult, type Capability, type HarnessAdapter } from './adapters.js';
import { capabilitySection } from './capability-contract.js';
// The runner adapters this office has besides `context` (they register themselves): per-run MCP and permissions.
import './adapter-claude.js';
import { mergeLaunch, type RunLaunch } from './launch-scope.js';
import { cardLockFile, createRecord, listRecords, OWNER_FRESH_MS, ownerAlive, preparedDir, PROCESS_TOKEN, readRecord, removeRunFiles, removeScope, scopeDir, STEP_IDS, updateRecord, type PreparedRecord, type StepId, type StepReport } from './prepare-store.js';
import { withFileLock } from './lock.js';
import { harnessPath, type HierarchyNode } from '../../shared/harness-hierarchy.js';
import type { HarnessProfile } from '../../shared/harness-cascade.js';
import type { OporaPlace } from '../../shared/opora-identity.js';
import type { AgentProvider } from '../../shared/providers.js';

/** What a run is prepared for: the floor's checkout, the card and the canvas it was read on. */
export interface PrepareContext {
  dataDir: string;
  repo: string;
  place: OporaPlace;
  card: string;
  nodes: readonly HierarchyNode[];
  /** Whether machine (administrator) resources may be read, as for the handoff. */
  local: boolean;
  /** Adapters to use besides `context` and the ones the profile's `adapters` slot names. */
  adapters?: readonly string[];
  /** The runner the card's worker will be seated with: per-run MCP and permissions are per runner (adapter-claude.ts). */
  runner?: AgentProvider;
}
export interface RetryBudget { max: number; backoffMs: number }
export interface PrepareOptions {
  dryRun?: boolean;
  /** Each step's time, or per step. */
  timeoutMs?: number | Partial<Record<StepId, number>>;
  /** Extra attempts after the first, and the wait before the first retry (doubled each time). */
  retry?: Partial<RetryBudget>;
}
export const PREPARE_DEFAULTS = { timeoutMs: 30_000, retry: { max: 2, backoffMs: 250 } } as const;
/** The profile slot that names a card's adapters, as a comma-separated value (`{"value":"context"}`). */
export const ADAPTERS_SLOT = 'adapters';

/** The lease a run was claimed with, and the card as the bridge read it. */
export interface ClaimedLease { token: string; agent: string; card?: { name: string; group: 'dev' | 'design'; sectorName?: string } }
/** A run in `prepared`: what the worker's prompt gets, and the moves the bridge makes with it. */
export interface PreparedRun {
  runId: string;
  digest: string;
  context: string;
  /** True when an existing prepared run was found and used (nothing was prepared again). */
  resumed: boolean;
  capabilities: Capability[];
  /** What the worker's launch gets for this run only (launch-scope.ts), when an adapter contributed. */
  launch?: RunLaunch;
  /** prepared → claimed, with the lease (refused when the run isn't `prepared` any more: nothing is seated then). */
  claimed(lease: ClaimedLease): Promise<void>;
  /** claimed → seated. */
  seated(workerId: string): Promise<void>;
  /** Rolls back a run that wasn't seated (the claim or the seat failed); the bridge releases the lease first. */
  rollback(reason: string): Promise<void>;
}
/** What a dry run reports: every step with what it would do and write, the requirements, and what refuses it. */
export interface PreparePlan {
  dryRun: true;
  ok: boolean;
  card: OporaPlace & { nodeId: string };
  reason?: string;
  steps: { id: StepId; status: 'planned' | 'failed' | 'skipped'; detail: string; writes: string[] }[];
  adapters: string[];
  refused: { id: string; reason: string }[];
  requirements: Capability[];
  /** The snapshot digest the run would have now (what a later take compares to resume). */
  digest?: string;
  writes: string[];
  options: { timeoutMs: Record<StepId, number>; retry: RetryBudget };
}

/** A step that failed for good: its report, and the run's record after the rollback. */
export class PrepareError extends HarnessError {
  constructor(message: string, status: number, readonly record?: PreparedRecord) { super(message, status); }
}
class StepTimeout extends Error {
  constructor(message: string, readonly settled?: Promise<void>) { super(message); }
}
/** How long a timed-out attempt is waited for before its step is retried or rolled back. */
const SETTLE_MS = 5000;

/** Runs this process has under way (between creating or taking up a record and seating or rolling back). */
const inFlight = new Set<string>();
export const runsInFlight = (): ReadonlySet<string> => inFlight;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function stepTimeouts(options: PrepareOptions): Record<StepId, number> {
  const t = options.timeoutMs;
  return Object.fromEntries(STEP_IDS.map((id) => [id, Math.max(1, typeof t === 'number' ? t : t?.[id] ?? PREPARE_DEFAULTS.timeoutMs)])) as Record<StepId, number>;
}
function retryBudget(options: PrepareOptions): RetryBudget {
  return { max: Math.max(0, Math.min(10, Math.floor(options.retry?.max ?? PREPARE_DEFAULTS.retry.max))), backoffMs: Math.max(0, options.retry?.backoffMs ?? PREPARE_DEFAULTS.retry.backoffMs) };
}
/** A deterministic refusal (an element unavailable, a size limit, a foreign binding) gives the same answer however often it is asked. */
const retryable = (err: unknown) => err instanceof StepTimeout || !(err instanceof HarnessError) || err.status >= 500;

/**
 * Runs `work` with a time limit: past it the signal is aborted and a StepTimeout thrown; a result that
 * comes in after that is handed to `late` (to undo it), never used.
 */
async function bounded<T>(ms: number, work: (signal: AbortSignal) => Promise<T>, late?: (value: T | undefined) => void): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined, expired = false;
  const running = work(controller.signal);
  // The attempt itself, settled either way: a retry or a rollback waits for it (a little), so the two never write at once.
  const settled = running.then((value) => { if (expired) late?.(value); }, () => { if (expired) late?.(undefined); });
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; controller.abort(); reject(new StepTimeout(`timed out after ${ms} ms`, settled)); }, ms); });
  try { return await Promise.race([running, timeout]); } finally { clearTimeout(timer); }
}

/** The adapters a card's profile names in its `adapters` slot, plus the context's own. */
function namedAdapters(profile: HarnessProfile, extra: readonly string[] = []): string[] {
  const slot = profile.effective[ADAPTERS_SLOT]?.binding;
  const named = slot && 'value' in slot && typeof slot.value === 'string' ? slot.value.split(',') : [];
  return [...named, ...extra];
}

/** What the read-only steps establish, for a real run and a dry run alike. */
interface Resolved { card: OporaPlace & { nodeId: string }; binding: OporaPlace | null; profile: HarnessProfile; adapters: HarnessAdapter[]; refused: { id: string; reason: string }[]; handoff?: ResolvedHandoff }
function resolveStep(ctx: PrepareContext): Resolved {
  const card = { ...ctx.place, nodeId: ctx.card };
  const binding = cardBinding(ctx.dataDir, ctx.repo, ctx.place) ?? null;
  const profile = new HarnessProfiles(ctx.dataDir).view(ctx.repo, harnessPath(ctx.nodes, ctx.place, ctx.card));
  const { adapters, refused } = resolveAdapters(namedAdapters(profile, ctx.adapters), ctx.runner);
  return { card, binding, profile, adapters, refused };
}
async function availabilityStep(ctx: PrepareContext, r: Resolved): Promise<ResolvedHandoff> {
  if (r.refused.length) throw new HarnessError(`Unsupported adapter${r.refused.length === 1 ? '' : 's'}, refused before anything was prepared: ${r.refused.map((x) => `${x.id} (${x.reason})`).join('; ')}.`, 422);
  return resolveHandoff(ctx.dataDir, ctx.repo, r.profile.path, ctx.local, r.profile);
}

/**
 * The plan of a run without running it: the read-only steps (resolve, availability, the snapshot built
 * in memory) and each adapter's plan. Nothing is written: no record, no snapshot, no scoped file.
 */
export async function preparePlan(ctx: PrepareContext, options: PrepareOptions = {}): Promise<PreparePlan> {
  const card = { ...ctx.place, nodeId: ctx.card };
  const runId = '<runId>';
  const plan: PreparePlan = { dryRun: true, ok: true, card, steps: [], adapters: [], refused: [], requirements: [], writes: [], options: { timeoutMs: stepTimeouts(options), retry: retryBudget(options) } };
  const fail = (id: StepId, err: unknown) => {
    plan.ok = false;
    plan.reason = (err as Error).message;
    plan.steps.push({ id, status: 'failed', detail: plan.reason, writes: [] });
    for (const rest of STEP_IDS.slice(STEP_IDS.indexOf(id) + 1)) plan.steps.push({ id: rest, status: 'skipped', detail: 'not reached', writes: [] });
    return plan;
  };
  let r: Resolved;
  try { r = resolveStep(ctx); } catch (err) { return fail('resolve', err); }
  plan.adapters = r.adapters.map((a) => a.id);
  plan.refused = r.refused;
  plan.steps.push({ id: 'resolve', status: 'planned', detail: `profile revision ${r.profile.revision}, path ${r.profile.path.map((p) => p.level).join(' › ') || 'project'}, adapters ${[...plan.adapters, ...r.refused.map((x) => x.id + ' (refused)')].join(', ')}`, writes: [] });
  let handoff: ResolvedHandoff;
  try { handoff = await availabilityStep(ctx, r); } catch (err) { return fail('availability', err); }
  plan.steps.push({ id: 'availability', status: 'planned', detail: `${handoff.resources.length} bound element${handoff.resources.length === 1 ? '' : 's'} available: ${handoff.resources.map((x) => `${x.entry.id}@${x.entry.version}`).join(', ') || 'none'}`, writes: [] });
  let snapshot: StoredSnapshot;
  try { snapshot = buildSnapshot({ card, binding: r.binding, resolved: handoff, guides: HARNESS_GUIDES, runId: 'plan-' + randomUUID() }); } catch (err) { return fail('snapshot', err); }
  plan.digest = snapshot.digest;
  // Paths relative to the office data dir: the plan is read by sessions and workers, who don't need the server's folders.
  const rel = (p: string) => path.relative(ctx.dataDir, p);
  const files = { record: rel(path.join(preparedDir(ctx.dataDir), runId + '.json')), snapshot: rel(path.join(snapshotDir(ctx.dataDir), runId + '.json')), scope: path.join(preparedDir(ctx.dataDir), runId) };
  plan.steps.push({ id: 'snapshot', status: 'planned', detail: `snapshot sha256:${snapshot.digest} (${snapshot.eager.length} essential, ${snapshot.lazy.length} by ID)`, writes: [files.snapshot] });
  const actx = { runId, dataDir: ctx.dataDir, repo: ctx.repo, card, snapshot, scopeDir: files.scope, runner: ctx.runner };
  const writes = r.adapters.flatMap((a) => a.plan(actx).flatMap((s) => s.writes.map(rel)));
  plan.steps.push({ id: 'adapters', status: 'planned', detail: r.adapters.map((a) => `${a.id}: ${a.plan(actx).map((s) => s.detail).join('; ') || 'nothing to do'}`).join(' | '), writes });
  plan.requirements = r.adapters.flatMap((a) => a.capabilities(actx));
  plan.steps.push({ id: 'verify', status: 'planned', detail: `reload the snapshot against its digest, then verify ${plan.requirements.length} capabilit${plan.requirements.length === 1 ? 'y' : 'ies'} (declared → prepared → verified)`, writes: [] });
  plan.writes = [files.record, files.snapshot, ...(writes.length ? [rel(files.scope)] : [])];
  return plan;
}

/**
 * Prepares the run for a card, or takes up the one prepared for it before. Resolves to the run in
 * `prepared`; throws a PrepareError (the card is not claimed then) when a step fails for good, after
 * everything this run created has been rolled back, with the report in its record.
 */
export async function prepareRun(ctx: PrepareContext, options: PrepareOptions = {}): Promise<PreparedRun> {
  const repo = harnessRepoKey(ctx.repo);
  const card = { ...ctx.place, nodeId: ctx.card };
  mkdirSync(preparedDir(ctx.dataDir), { recursive: true });
  // Looking up the card's runs and starting one is one step, so two takes of a card never both prepare it.
  const found = await withFileLock(cardLockFile(ctx.dataDir, repo, card), { waitMs: 5000 }, async () => {
    const mine = listRecords(ctx.dataDir).records.filter((r) => r.repo === repo && r.card.project === card.project && r.card.workspace === card.workspace && r.card.nodeId === card.nodeId);
    for (const r of mine) {
      if (r.state === 'seated' || r.state === 'rolledBack') continue;
      const alive = ownerAlive(r.owner, inFlight, r.runId) && (r.owner.token === PROCESS_TOKEN || Date.now() - Date.parse(r.updatedAt) < OWNER_FRESH_MS);
      if (alive && r.state !== 'failed') throw new PrepareError(`Run ${r.runId} of this card is ${r.state} by ${r.owner.token === PROCESS_TOKEN ? 'this office' : 'another office process (pid ' + r.owner.pid + ')'}; it is not prepared or started a second time.`, 409);
      if (r.state === 'claimed') throw new PrepareError(`Run ${r.runId} of this card was claimed by an office that stopped; its lease is released at the next poll, then the card can be taken again.`, 409);
      if (r.state === 'prepared') {
        inFlight.add(r.runId);
        try { return await updateRecord(ctx.dataDir, r.runId, ['prepared'], undefined, (x) => { x.owner = { pid: process.pid, token: PROCESS_TOKEN }; }); }
        catch (err) { inFlight.delete(r.runId); throw err; }
      }
      // planned, preparing or failed by a process that is gone: what it left is undone first.
      await finishRollback(ctx.dataDir, r.runId, 'interrupted before it was prepared (the office stopped)');
    }
    const runId = randomUUID();
    inFlight.add(runId);
    try {
      return createRecord(ctx.dataDir, { runId, repo, card, owner: { pid: process.pid, token: PROCESS_TOKEN }, adapters: [], capabilities: [], contexts: {}, steps: STEP_IDS.map((id) => ({ id, status: 'pending', detail: '', attempts: [], writes: [] })) });
    } catch (err) { inFlight.delete(runId); throw err; }
  });
  try {
    if (found.state === 'prepared') {
      const resumed = await resumeRun(ctx, found, options);
      if (resumed) return resumed;
      return await prepareRun(ctx, options);
    }
    return await freshRun(ctx, found, options);
  } catch (err) {
    inFlight.delete(found.runId);
    throw err;
  }
}

/** The moves the bridge makes with a run in `prepared`. */
function handle(ctx: PrepareContext, record: PreparedRecord, context: string, resumed: boolean, undo: () => Promise<string[]>): PreparedRun {
  const { dataDir } = ctx, runId = record.runId;
  return {
    runId, digest: record.digest!, context, resumed, capabilities: record.capabilities, ...(record.launch ? { launch: record.launch } : {}),
    async claimed(lease) {
      await updateRecord(dataDir, runId, ['prepared'], 'claimed', (r) => { r.lease = { token: lease.token, agent: lease.agent, at: new Date().toISOString() }; if (lease.card) r.cardMeta = { ...lease.card }; });
    },
    async seated(workerId) {
      try { await updateRecord(dataDir, runId, ['claimed'], 'seated', (r) => { r.workerId = workerId; }); }
      finally { inFlight.delete(runId); }
    },
    async rollback(reason) {
      try {
        const errors = await undo();
        // After the claim it is the seat that failed; before it, the claim.
        await finishRollback(dataDir, runId, reason, errors, readRecord(dataDir, runId)?.state === 'claimed' ? 'seat' : 'claim');
      } finally { inFlight.delete(runId); }
    },
  };
}

/** Moves a run that won't be seated to `failed`, removes its files and, when nothing failed to go, to `rolledBack`. */
export async function finishRollback(dataDir: string, runId: string, reason: string, earlier: string[] = [], step: NonNullable<PreparedRecord['error']>['step'] = 'recover') {
  const before = readRecord(dataDir, runId);
  if (!before || before.state === 'rolledBack' || before.state === 'seated') return before;
  const failed = before.state === 'failed' ? before : await updateRecord(dataDir, runId, ['planned', 'preparing', 'prepared', 'claimed'], 'failed', (r) => { r.error ??= { step, reason }; }, reason);
  const recovered = await recoverAdapters(dataDir, runId, failed.adapterState);
  const { done, errors } = removeRunFiles(dataDir, runId);
  const all = [...earlier, ...recovered, ...errors];
  return updateRecord(dataDir, runId, ['failed'], all.length ? undefined : 'rolledBack', (r) => {
    r.rollback = { at: new Date().toISOString(), done, errors: all };
    for (const s of r.steps) if (s.status === 'done') s.status = 'rolledBack';
  }, all.length ? undefined : `rolled back: ${failed.error?.reason ?? reason}`);
}

/** Each adapter's `recover` with the state it persisted (idempotent: after a closure's rollback it finds nothing left). Returns what failed. */
async function recoverAdapters(dataDir: string, runId: string, state: PreparedRecord['adapterState']): Promise<string[]> {
  const errors: string[] = [];
  for (const [id, persisted] of Object.entries(state ?? {})) {
    const adapter = listAdapters().find((a) => a.id === id);
    if (!adapter?.recover) continue;
    try { for (const e of (await adapter.recover({ runId, dataDir, scopeDir: scopeDir(dataDir, runId) }, persisted)) ?? []) errors.push(`${id}: ${e}`); }
    catch (err) { errors.push(`${id}: ${(err as Error).message}`); }
  }
  return errors;
}

/** One step with its timeout and retry budget; each failed attempt goes into the record with its reason. */
async function runStep<T>(ctx: PrepareContext, runId: string, id: StepId, options: PrepareOptions, work: (signal: AbortSignal) => Promise<T>, undoAttempt?: () => Promise<void>, late?: (value: T | undefined) => void): Promise<T> {
  const timeout = stepTimeouts(options)[id], budget = retryBudget(options);
  await updateRecord(ctx.dataDir, runId, ['planned', 'preparing'], 'preparing', (r) => { step(r, id).status = 'running'; });
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      return await bounded(timeout, work, late);
    } catch (err) {
      const reason = (err as Error).message;
      const final = !retryable(err) || attempt > budget.max;
      await updateRecord(ctx.dataDir, runId, ['preparing'], undefined, (r) => { const s = step(r, id); s.attempts.push({ at: new Date().toISOString(), ms: Date.now() - started, error: reason }); if (final) s.status = 'failed'; });
      // A timed-out attempt may still be writing: wait for it (bounded) before undoing it or trying again.
      if (err instanceof StepTimeout && err.settled) await Promise.race([err.settled, sleep(SETTLE_MS)]);
      if (undoAttempt) await undoAttempt().catch(() => undefined);
      if (final) {
        const spent = attempt > 1 || budget.max > 0 ? ` after ${attempt} attempt${attempt === 1 ? '' : 's'} (retry budget ${budget.max})` : '';
        throw new PrepareError(`Preparation step ${id} failed${spent}: ${reason}`, err instanceof HarnessError ? err.status : err instanceof StepTimeout ? 504 : 500);
      }
      await sleep(budget.backoffMs * 2 ** (attempt - 1));
    }
  }
}
const step = (r: PreparedRecord, id: StepId) => r.steps.find((s) => s.id === id)!;
const doneStep = (dataDir: string, runId: string, id: StepId, detail: string, writes: string[] = [], status: StepReport['status'] = 'done') =>
  updateRecord(dataDir, runId, ['preparing'], undefined, (r) => { Object.assign(step(r, id), { status, detail, writes }); });

/** A new run: every step, then `prepared`. A step that fails for good rolls the run back and throws. */
async function freshRun(ctx: PrepareContext, record: PreparedRecord, options: PrepareOptions): Promise<PreparedRun> {
  const { dataDir } = ctx, runId = record.runId, scope = scopeDir(dataDir, runId);
  const undos: (() => void | Promise<void>)[] = [];
  let finished = false;
  const undoAll = async () => {
    const errors: string[] = [];
    for (const undo of undos.splice(0).reverse()) try { await undo(); } catch (err) { errors.push((err as Error).message); }
    return errors;
  };
  let current: StepId = 'resolve';
  try {
    const r = await runStep(ctx, runId, current, options, async () => resolveStep(ctx));
    await doneStep(dataDir, runId, current, `profile revision ${r.profile.revision}; adapters ${r.adapters.map((a) => a.id).join(', ')}`);
    current = 'availability';
    const handoff = await runStep(ctx, runId, current, options, async () => availabilityStep(ctx, r));
    await doneStep(dataDir, runId, current, `${handoff.resources.length} bound element${handoff.resources.length === 1 ? '' : 's'} available`);
    current = 'snapshot';
    const snapshot = await runStep(ctx, runId, current, options, async () => {
      const built = buildSnapshot({ card: { ...ctx.place, nodeId: ctx.card }, binding: r.binding, resolved: handoff, guides: HARNESS_GUIDES, runId });
      persistSnapshot(dataDir, built);
      return built;
    });
    await doneStep(dataDir, runId, current, `snapshot sha256:${snapshot.digest}`, [path.join(snapshotDir(dataDir), runId + '.json')]);
    await updateRecord(dataDir, runId, ['preparing'], undefined, (x) => { x.digest = snapshot.digest; x.adapters = r.adapters.map((a) => a.id); x.capabilities = r.adapters.flatMap((a) => a.capabilities({ runId, dataDir, repo: ctx.repo, card: snapshot.card, snapshot, scopeDir: scope, runner: ctx.runner })); });
    current = 'adapters';
    const results = await runStep(ctx, runId, current, options, async (signal) => {
      const out: { adapter: HarnessAdapter; result: AdapterResult }[] = [];
      try {
        for (const adapter of r.adapters) {
          if (signal.aborted) throw new Error('aborted: the step timed out');
          const result = await adapter.prepare({ runId, dataDir, repo: ctx.repo, card: snapshot.card, snapshot, scopeDir: scope, signal, runner: ctx.runner });
          out.push({ adapter, result });
          if (!result.ok) throw new HarnessError(`adapter ${adapter.id} could not prepare: ${result.reason ?? 'no reason given'}`, 500);
        }
        return out;
      } catch (err) {
        for (const { result } of out.reverse()) await Promise.resolve(result.rollback()).catch(() => undefined);
        throw err;
      }
    }, async () => removeScope(dataDir, runId), (late) => {
      // An attempt that came in after its time: undone, never used (and the run's files go again once it is rolled back).
      for (const { result } of late ?? []) void Promise.resolve(result.rollback()).catch(() => undefined);
      if (finished) removeRunFiles(dataDir, runId);
    });
    for (const { result } of results) undos.push(() => result.rollback());
    await doneStep(dataDir, runId, current, results.map(({ adapter, result }) => `${adapter.id}: ${result.steps.map((s) => s.detail).join('; ') || 'done'}`).join(' | '), results.flatMap(({ result }) => result.steps.flatMap((s) => s.writes)));
    const launch = mergeLaunch(runId, results.map(({ result }) => result.launch));
    await updateRecord(dataDir, runId, ['preparing'], undefined, (x) => {
      for (const c of x.capabilities) c.state = 'prepared';
      if (launch) x.launch = launch;
      const persisted = results.filter(({ result }) => result.persist).map(({ adapter, result }) => [adapter.id, result.persist!] as const);
      if (persisted.length) x.adapterState = Object.fromEntries(persisted);
    });
    current = 'verify';
    const checked = await runStep(ctx, runId, current, options, async (signal) => verifyRun(ctx, runId, snapshot.digest, results, signal, readRecord(dataDir, runId)?.capabilities ?? []));
    const context = checked.context + capabilitySection(checked.capabilities);
    const prepared = await updateRecord(dataDir, runId, ['preparing'], 'prepared', (x) => {
      x.capabilities = checked.capabilities;
      const ready = x.capabilities.filter((c) => c.state === 'verified').length;
      Object.assign(step(x, 'verify'), { status: 'done', detail: `${ready} of ${x.capabilities.length} capabilit${x.capabilities.length === 1 ? 'y' : 'ies'} verified` });
      x.contexts = Object.fromEntries(results.filter(({ adapter }) => adapter.id !== 'context').map(({ adapter, result }) => [adapter.id, result.context ?? '']).filter(([, text]) => text));
    });
    return handle(ctx, prepared, context, false, undoAll);
  } catch (err) {
    finished = true;
    const errors = await undoAll();
    const after = await finishRollback(dataDir, runId, (err as Error).message, errors, current).catch(() => readRecord(dataDir, runId));
    inFlight.delete(runId);
    const status = err instanceof HarnessError ? err.status : 500;
    const report = after ? ` Done before it failed: ${after.steps.filter((s) => s.status === 'rolledBack').map((s) => s.id).join(', ') || 'nothing'}; rolled back: ${after.rollback?.done.join(', ') || 'nothing'}${after.rollback?.errors.length ? `; could not roll back: ${after.rollback.errors.join('; ')} (a recovery retries)` : ''}. Run ${runId}, the card was not claimed.` : '';
    throw new PrepareError((err as Error).message + report, status, after);
  }
}

/**
 * The readiness check: the snapshot reloads whole with its digest, and every adapter's work verifies.
 * Returns the worker's prompt section and the capabilities as verified: an adapter's report sets the
 * state of each of its capabilities (a probe that didn't answer leaves one `prepared`); without a
 * report, passing verification makes all of the adapter's capabilities `verified`.
 */
async function verifyRun(ctx: PrepareContext, runId: string, digest: string, results: { adapter: HarnessAdapter; result: AdapterResult }[], signal: AbortSignal, declared: Capability[]): Promise<{ context: string; capabilities: Capability[] }> {
  const snapshot = loadSnapshot(ctx.dataDir, runId);
  if (snapshot.digest !== digest) throw new HarnessError(`Run snapshot ${runId} reloaded with another digest.`, 409);
  const actx: AdapterContext = { runId, dataDir: ctx.dataDir, repo: ctx.repo, card: snapshot.card, snapshot, scopeDir: scopeDir(ctx.dataDir, runId), signal, runner: ctx.runner };
  const capabilities: Capability[] = [];
  for (const { adapter, result } of results) {
    const out = await adapter.verify(actx, result);
    const why = typeof out === 'string' ? out : out?.reason;
    if (why) throw new HarnessError(`adapter ${adapter.id} did not verify: ${why}`, 422);
    const reported = typeof out === 'object' && out.capabilities ? out.capabilities.filter((c) => c.adapter === adapter.id) : undefined;
    capabilities.push(...(reported ?? declared.filter((c) => c.adapter === adapter.id).map((c) => ({ ...c, state: 'verified' as const }))));
  }
  return { context: results.map(({ result }) => result.context ?? '').join(''), capabilities };
}

/**
 * Takes up a run prepared before (by this office before a restart, or a take that stopped before its
 * claim). The read-only steps run again and the snapshot is rebuilt in memory only: when its digest is
 * the recorded one and the written snapshot still loads with it, the adapters' work is verified (not
 * redone) and the run is used as it is. When the inputs changed since, it is rolled back and undefined
 * returned, for a new run. Nothing is written but the record's report.
 */
async function resumeRun(ctx: PrepareContext, record: PreparedRecord, options: PrepareOptions): Promise<PreparedRun | undefined> {
  const { dataDir } = ctx, runId = record.runId;
  const timeouts = stepTimeouts(options);
  try {
    const r = await bounded(timeouts.resolve, async () => resolveStep(ctx));
    const handoff = await bounded(timeouts.availability, async () => availabilityStep(ctx, r));
    const rebuilt = buildSnapshot({ card: { ...ctx.place, nodeId: ctx.card }, binding: r.binding, resolved: handoff, guides: HARNESS_GUIDES, runId });
    const ids = r.adapters.map((a) => a.id);
    if (rebuilt.digest !== record.digest || ids.join(',') !== record.adapters.join(',') || (record.launch && record.launch.runner !== ctx.runner)) {
      await finishRollback(dataDir, runId, 'its inputs changed since it was prepared (profile, elements, adapters or runner); a new run is prepared');
      inFlight.delete(runId);
      return undefined;
    }
    const results = r.adapters.map((adapter) => ({ adapter, result: { ok: true, steps: [], context: adapter.id === 'context' ? undefined : record.contexts[adapter.id], rollback: () => undefined, ...(record.launch ? { launch: record.launch } : {}), ...(record.adapterState?.[adapter.id] ? { persist: record.adapterState[adapter.id] } : {}) } as AdapterResult }));
    const contract = await contextAdapter.prepare({ runId, dataDir, repo: ctx.repo, card: rebuilt.card, snapshot: loadSnapshot(dataDir, runId), scopeDir: scopeDir(dataDir, runId), signal: new AbortController().signal });
    results.find(({ adapter }) => adapter.id === 'context')!.result.context = contract.context;
    const checked = await bounded(timeouts.verify, (signal) => verifyRun(ctx, runId, record.digest!, results, signal, record.capabilities));
    const context = checked.context + capabilitySection(checked.capabilities);
    const now = await updateRecord(dataDir, runId, ['prepared'], undefined, (x) => { x.capabilities = checked.capabilities; x.history.push({ state: 'prepared', at: new Date().toISOString(), note: 'taken up again after a restart: inputs and snapshot unchanged, adapters verified, nothing prepared again' }); });
    return handle(ctx, now, context, true, async () => []);
  } catch (err) {
    await finishRollback(dataDir, runId, 'the prepared run could not be taken up again: ' + (err as Error).message).catch(() => undefined);
    inFlight.delete(runId);
    if (err instanceof HarnessError && err.status < 500 && !(err instanceof PrepareError)) throw new PrepareError((err as Error).message + ` (run ${runId} was rolled back; the card was not claimed)`, err.status);
    return undefined;
  }
}

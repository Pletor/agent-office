// The preparation runner (docs/harness.md "Preparation runner"): before the bridge claims an Opora card
// and seats its worker, a script, not the model, prepares the run from IDs: it resolves the card's
// profile, checks that every bound element and every adapter is available, writes the run snapshot,
// has each adapter prepare its part, and verifies the result. Only a run in `prepared` is claimed, and
// only a claimed one is seated (prepare-store.ts holds the state machine). Each step has a timeout and a
// retry budget, and each failed attempt is recorded with its reason. The read-only steps (resolve,
// availability, building the snapshot in memory) run before anything is written: a card refused there
// leaves no record, only the take's error, and the same failure isn't tried again for a while (a
// cooldown per card). A step that fails for good after that rolls back everything the run created
// (adapters' work, the scoped folder, the snapshot) and leaves a report of what was done and what was
// undone; the card is not claimed. A dry run reports the whole plan and writes nothing. Preparing is
// idempotent per card and run: taking a card whose run was prepared and not yet claimed (an office
// restarted in between) finds that run, checks it still matches its inputs, and uses it, without
// writing or preparing anything a second time.
import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarnessError, HarnessProfiles, harnessRepoKey } from './profiles.js';
import { cardBinding, resolveHandoff, type ResolvedHandoff } from './handoff.js';
import { HARNESS_GUIDES } from './guides.js';
import { buildSnapshot, loadSnapshot, persistSnapshot, snapshotDir, type StoredSnapshot } from './snapshot.js';
import { contextAdapter, resolveAdapters, writesOutside, type AdapterContext, type AdapterResult, type Capability, type HarnessAdapter } from './adapters.js';
import { attemptScope, cardKey, cardLockFile, claimFile, createRecord, dataRel, OWNER_FRESH_MS, ownerAlive, preparedDir, PROCESS_TOKEN, readRecord, recordScope, removeRunFiles, removeScope, scopeDir, STEP_IDS, updateRecord, type PreparedRecord, type StepAttempt, type StepId, type StepReport } from './prepare-store.js';
import { activeRecords } from './prepare-index.js';
import { withFileLock } from './lock.js';
import { harnessPath, type HierarchyNode } from '../../shared/harness-hierarchy.js';
import type { HarnessProfile } from '../../shared/harness-cascade.js';
import type { OporaPlace } from '../../shared/opora-identity.js';

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
  /** The floor the run is for, kept in its record (a recovery acts on its own floor's runs only). */
  floor?: string;
}
export interface RetryBudget { max: number; backoffMs: number }
export interface PrepareOptions {
  dryRun?: boolean;
  /** Each step's time, or per step. */
  timeoutMs?: number | Partial<Record<StepId, number>>;
  /** Extra attempts after the first, and the wait before the first retry (doubled each time). */
  retry?: Partial<RetryBudget>;
  /** How long a card whose preparation failed isn't tried again the same way: `baseMs`, doubled for each repeat of the same failure, up to `maxMs`. */
  cooldown?: Partial<{ baseMs: number; maxMs: number }>;
}
export const PREPARE_DEFAULTS = { timeoutMs: 30_000, retry: { max: 2, backoffMs: 250 }, cooldown: { baseMs: 60_000, maxMs: 15 * 60_000 } } as const;
/** The profile slot that names a card's adapters, as a comma-separated value (`{"value":"context"}`). */
export const ADAPTERS_SLOT = 'adapters';

/** The lease a run was claimed with, the card as the bridge read it, and the desk its worker goes to. */
export interface ClaimedLease { token: string; agent: string; card?: { name: string; group: 'dev' | 'design'; sectorName?: string }; deskId?: string }
/** A run in `prepared`: what the worker's prompt gets, and the moves the bridge makes with it. */
export interface PreparedRun {
  runId: string;
  digest: string;
  context: string;
  /** True when an existing prepared run was found and used (nothing was prepared again). */
  resumed: boolean;
  capabilities: Capability[];
  /** Records that the claim is about to be asked for (and the desk), so a restart knows a lease may exist. */
  claiming(agent: string, deskId?: string): Promise<void>;
  /** Writes the lease token next to the record, synchronously, the moment the claim answered (see PreparedRecord.claiming). */
  granted(lease: { token: string; agent: string }): void;
  /** prepared → claimed, with the lease (refused when the run isn't `prepared` any more: nothing is seated then). */
  claimed(lease: ClaimedLease): Promise<void>;
  /** claimed → seated. */
  seated(workerId: string): Promise<void>;
  /** The seat failed and Opora didn't confirm the release: the run stays `claimed` with the reason, for a recovery to release. */
  releaseFailed(reason: string): Promise<void>;
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

/** A step that failed for good: its report, and the run's record after the rollback (none when nothing was written). */
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
const aborted = (signal: AbortSignal) => { if (signal.aborted) throw new Error('aborted: the step timed out'); };

/** The last failure of each card (per data dir), and until when the same failure isn't tried again. */
const cooldowns = new Map<string, { print: string; reason: string; status: number; until: number; count: number }>();
function coolDown(key: string, print: string, reason: string, status: number, options: PrepareOptions) {
  const { baseMs, maxMs } = { ...PREPARE_DEFAULTS.cooldown, ...options.cooldown };
  if (baseMs <= 0) return;
  const before = cooldowns.get(key);
  const count = before && before.print === print && before.reason === reason ? before.count + 1 : 1;
  cooldowns.delete(key);
  cooldowns.set(key, { print, reason, status, count, until: Date.now() + Math.min(maxMs, baseMs * 2 ** (count - 1)) });
  if (cooldowns.size > 1000) cooldowns.delete(cooldowns.keys().next().value!);
}

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

/** One step's attempts: what each does, undoes after failing, and does with a result that came in after its time. */
interface StepHooks<T> {
  work(signal: AbortSignal, attempt: number): Promise<T>;
  undo?(attempt: number): void | Promise<void>;
  late?(value: T | undefined, attempt: number): void;
  /** Each failed attempt with its reason, and whether it was the last. */
  failed?(attempt: StepAttempt, final: boolean): Promise<void>;
}
/** One step with its timeout and retry budget. Throws a PrepareError naming the step once it failed for good. */
async function attempts<T>(id: StepId, options: PrepareOptions, hooks: StepHooks<T>): Promise<T> {
  const timeout = stepTimeouts(options)[id], budget = retryBudget(options);
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      return await bounded(timeout, (signal) => hooks.work(signal, attempt), (value) => hooks.late?.(value, attempt));
    } catch (err) {
      const reason = (err as Error).message;
      const final = !retryable(err) || attempt > budget.max;
      await hooks.failed?.({ at: new Date().toISOString(), ms: Date.now() - started, error: reason }, final);
      // A timed-out attempt may still be writing: wait for it (bounded) before undoing it or trying again.
      if (err instanceof StepTimeout && err.settled) await Promise.race([err.settled, sleep(SETTLE_MS)]);
      if (hooks.undo) await Promise.resolve().then(() => hooks.undo!(attempt)).catch(() => undefined);
      if (final) {
        const spent = attempt > 1 || budget.max > 0 ? ` after ${attempt} attempt${attempt === 1 ? '' : 's'} (retry budget ${budget.max})` : '';
        throw new PrepareError(`Preparation step ${id} failed${spent}: ${reason}`, err instanceof HarnessError ? err.status : err instanceof StepTimeout ? 504 : 500);
      }
      await sleep(budget.backoffMs * 2 ** (attempt - 1));
    }
  }
}
/** A step of a run with a record: marked running, and each failed attempt recorded with its reason. */
async function runStep<T>(ctx: PrepareContext, runId: string, id: StepId, options: PrepareOptions, hooks: StepHooks<T>): Promise<T> {
  await updateRecord(ctx.dataDir, runId, ['planned', 'preparing'], 'preparing', (r) => { step(r, id).status = 'running'; });
  return attempts(id, options, { ...hooks, failed: (a, final) => updateRecord(ctx.dataDir, runId, ['preparing'], undefined, (r) => { const s = step(r, id); s.attempts.push(a); if (final) s.status = 'failed'; }).then(() => undefined) });
}
const step = (r: PreparedRecord, id: StepId) => r.steps.find((s) => s.id === id)!;
const doneStep = (dataDir: string, runId: string, id: StepId, detail: string, writes: string[] = [], status: StepReport['status'] = 'done') =>
  updateRecord(dataDir, runId, ['preparing'], undefined, (r) => { Object.assign(step(r, id), { status, detail, writes }); });

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
  const { adapters, refused } = resolveAdapters(namedAdapters(profile, ctx.adapters));
  return { card, binding, profile, adapters, refused };
}
/** What makes a failure "the same" for the cooldown: the inputs the resolve step reads. */
const fingerprint = (r: Resolved | undefined) => r ? [r.profile.revision, r.adapters.map((a) => a.id).join(','), r.refused.map((x) => x.id).join(','), r.binding ? r.binding.project + '/' + r.binding.workspace : ''].join('|') : 'unresolved';
/** Every adapter supported and every bound element readable now; `persist: false` for a dry run (the library writes nothing). */
async function availabilityStep(ctx: PrepareContext, r: Resolved, signal: AbortSignal, persist = true): Promise<ResolvedHandoff> {
  if (r.refused.length) throw new HarnessError(`Unsupported adapter${r.refused.length === 1 ? '' : 's'}, refused before anything was prepared: ${r.refused.map((x) => `${x.id} (${x.reason})`).join('; ')}.`, 422);
  aborted(signal);
  const handoff = await resolveHandoff(ctx.dataDir, ctx.repo, r.profile.path, ctx.local, r.profile, { persist });
  aborted(signal);
  return handoff;
}

/** Absolute folders of the server replaced by names, for text a session or worker reads (a plan, an HTTP error). */
export function redactPaths(text: string, folders: Record<string, string>): string {
  let out = text;
  for (const [name, dir] of Object.entries(folders).filter(([, d]) => d).sort((a, b) => b[1].length - a[1].length)) {
    for (const form of new Set([dir, dir.split('\\').join('/'), dir.split('/').join('\\')])) out = out.split(form).join(name);
  }
  return out;
}

/**
 * The plan of a run without running it: the read-only steps (resolve, availability, the snapshot built
 * in memory) and each adapter's plan. Nothing is written: no record, no snapshot, no scoped file, and
 * the library is listed without updating its registry or digest cache.
 */
export async function preparePlan(ctx: PrepareContext, options: PrepareOptions = {}): Promise<PreparePlan> {
  const card = { ...ctx.place, nodeId: ctx.card };
  const runId = '<runId>';
  const plan: PreparePlan = { dryRun: true, ok: true, card, steps: [], adapters: [], refused: [], requirements: [], writes: [], options: { timeoutMs: stepTimeouts(options), retry: retryBudget(options) } };
  const fail = (id: StepId, err: unknown) => {
    plan.ok = false;
    plan.reason = redactPaths((err as Error).message, { '<dataDir>': ctx.dataDir, '<checkout>': ctx.repo });
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
  try { handoff = await bounded(plan.options.timeoutMs.availability, (signal) => availabilityStep(ctx, r, signal, false)); } catch (err) { return fail('availability', err); }
  plan.steps.push({ id: 'availability', status: 'planned', detail: `${handoff.resources.length} bound element${handoff.resources.length === 1 ? '' : 's'} available: ${handoff.resources.map((x) => `${x.entry.id}@${x.entry.version}`).join(', ') || 'none'}`, writes: [] });
  let snapshot: StoredSnapshot;
  try { snapshot = buildSnapshot({ card, binding: r.binding, resolved: handoff, guides: HARNESS_GUIDES, runId: 'plan-' + randomUUID() }); } catch (err) { return fail('snapshot', err); }
  plan.digest = snapshot.digest;
  // Paths relative to the office data dir: the plan is read by sessions and workers, who don't need the server's folders.
  const rel = (p: string) => dataRel(ctx.dataDir, p);
  const scope = path.join(preparedDir(ctx.dataDir), runId, '1');
  const files = { record: rel(path.join(preparedDir(ctx.dataDir), runId + '.json')), snapshot: rel(path.join(snapshotDir(ctx.dataDir), runId + '.json')) };
  plan.steps.push({ id: 'snapshot', status: 'planned', detail: `snapshot sha256:${snapshot.digest} (${snapshot.eager.length} essential, ${snapshot.lazy.length} by ID)`, writes: [files.snapshot] });
  const actx = { runId, dataDir: ctx.dataDir, repo: ctx.repo, card, snapshot, scopeDir: scope };
  const writes = r.adapters.flatMap((a) => a.plan(actx).flatMap((s) => s.writes.map((w) => rel(path.resolve(scope, w)))));
  plan.steps.push({ id: 'adapters', status: 'planned', detail: r.adapters.map((a) => `${a.id}: ${a.plan(actx).map((s) => s.detail).join('; ') || 'nothing to do'}`).join(' | '), writes });
  plan.requirements = r.adapters.flatMap((a) => a.capabilities(actx));
  plan.steps.push({ id: 'verify', status: 'planned', detail: `reload the snapshot against its digest, then verify ${plan.requirements.length} capabilit${plan.requirements.length === 1 ? 'y' : 'ies'} (declared → prepared → verified)`, writes: [] });
  plan.writes = [files.record, files.snapshot, ...(writes.length ? [rel(path.join(preparedDir(ctx.dataDir), runId))] : [])];
  return plan;
}

/** What the read-only steps produced for a take, before its record exists, with each failed attempt. */
interface Preflight { r: Resolved; handoff: ResolvedHandoff; snapshot: StoredSnapshot; tries: Record<'resolve' | 'availability' | 'snapshot', StepAttempt[]> }
async function preflight(ctx: PrepareContext, runId: string, options: PrepareOptions, first: Resolved | undefined): Promise<Preflight> {
  const tries: Preflight['tries'] = { resolve: [], availability: [], snapshot: [] };
  const log = (id: keyof Preflight['tries']) => async (a: StepAttempt) => { tries[id].push(a); };
  const r = await attempts('resolve', options, { work: async () => first ?? resolveStep(ctx), failed: log('resolve') });
  const handoff = await attempts('availability', options, { work: (signal) => availabilityStep(ctx, r, signal), failed: log('availability') });
  const snapshot = await attempts('snapshot', options, { work: async () => buildSnapshot({ card: { ...ctx.place, nodeId: ctx.card }, binding: r.binding, resolved: handoff, guides: HARNESS_GUIDES, runId }), failed: log('snapshot') });
  return { r, handoff, snapshot, tries };
}

/** Whether another take is working on a record now (this office, or a live process that touched it lately). */
const busy = (r: PreparedRecord) => ownerAlive(r.owner, inFlight, r.runId) && (r.owner.token === PROCESS_TOKEN || Date.now() - Date.parse(r.updatedAt) < OWNER_FRESH_MS);

/**
 * Prepares the run for a card, or takes up the one prepared for it before. Resolves to the run in
 * `prepared`; throws a PrepareError (the card is not claimed then) when a step fails for good: before
 * anything was written without a record, after it once everything this run created is rolled back,
 * with the report in its record.
 */
export async function prepareRun(ctx: PrepareContext, options: PrepareOptions = {}): Promise<PreparedRun> {
  const repo = harnessRepoKey(ctx.repo);
  const card = { ...ctx.place, nodeId: ctx.card };
  const key = ctx.dataDir + '\0' + cardKey(repo, card);
  let first: Resolved | undefined;
  try { first = resolveStep(ctx); } catch { /* the resolve step reports it */ }
  const print = fingerprint(first), cool = cooldowns.get(key);
  if (cool && cool.print === print && Date.now() < cool.until) {
    throw new PrepareError(`${cool.reason.replace(/\.$/, '')}. It failed the same way ${cool.count} time${cool.count === 1 ? '' : 's'} in a row, so it is not tried again before ${new Date(cool.until).toISOString()} (a change to the card's profile lets it be tried at once).`, cool.status);
  }
  const runId = randomUUID();
  let pre: Preflight;
  try { pre = await preflight(ctx, runId, options, first); }
  catch (err) {
    const status = err instanceof HarnessError ? err.status : 500;
    // Only a deterministic refusal is cooled down, and only it means a run prepared earlier can't be taken up any more.
    if (status < 500) {
      coolDown(key, print, (err as Error).message, status, options);
      await dropPrepared(ctx, repo, card, (err as Error).message).catch(() => undefined);
    }
    throw new PrepareError(`${(err as Error).message.replace(/\.$/, '')}. Nothing was written; the card was not claimed.`, status);
  }
  mkdirSync(preparedDir(ctx.dataDir), { recursive: true });
  // Looking up the card's runs (its markers in the index) and starting one is one step, so two takes of a card never both prepare it.
  const found = await withFileLock(cardLockFile(ctx.dataDir, repo, card), { waitMs: 5000 }, async () => {
    for (const r of await activeRecords(ctx.dataDir, { repo, card })) {
      if (r.state === 'seated') continue;
      if (busy(r) && r.state !== 'failed') throw new PrepareError(`Run ${r.runId} of this card is ${r.state} by ${r.owner.token === PROCESS_TOKEN ? 'this office' : 'another office process (pid ' + r.owner.pid + ')'}; it is not prepared or started a second time.`, 409);
      if (r.state === 'claimed' || (r.state === 'prepared' && r.claiming)) throw new PrepareError(`Run ${r.runId} of this card was ${r.state === 'claimed' ? 'claimed' : 'being claimed'} by an office that stopped; its lease is released at the next poll, then the card can be taken again.`, 409);
      if (r.state === 'prepared') {
        inFlight.add(r.runId);
        try { return await updateRecord(ctx.dataDir, r.runId, ['prepared'], undefined, (x) => { x.owner = { pid: process.pid, token: PROCESS_TOKEN }; }); }
        catch (err) { inFlight.delete(r.runId); throw err; }
      }
      // planned, preparing or failed by a process that is gone: what it left is undone first.
      await finishRollback(ctx.dataDir, r.runId, 'interrupted before it was prepared (the office stopped)');
    }
    inFlight.add(runId);
    const done = (id: StepId, detail: string): StepReport => ({ id, status: 'done', detail, attempts: pre.tries[id as keyof Preflight['tries']], writes: [] });
    try {
      return createRecord(ctx.dataDir, { runId, repo, ...(ctx.floor ? { floor: ctx.floor } : {}), card, owner: { pid: process.pid, token: PROCESS_TOKEN }, adapters: [], capabilities: [], contexts: {}, steps: [
        done('resolve', `profile revision ${pre.r.profile.revision}; adapters ${pre.r.adapters.map((a) => a.id).join(', ')}`),
        done('availability', `${pre.handoff.resources.length} bound element${pre.handoff.resources.length === 1 ? '' : 's'} available`),
        { id: 'snapshot', status: 'pending', detail: '', attempts: pre.tries.snapshot, writes: [] },
        ...(['adapters', 'verify'] as const).map((id) => ({ id, status: 'pending' as const, detail: '', attempts: [], writes: [] })),
      ] });
    } catch (err) { inFlight.delete(runId); throw err; }
  });
  try {
    if (found.state === 'prepared') {
      const resumed = await resumeRun(ctx, found, options, pre);
      if (resumed) return resumed;
      // Rolled back (its inputs changed): a new run. Still prepared means its rollback failed: refused, never prepared again in a loop.
      if (readRecord(ctx.dataDir, found.runId)?.state === 'prepared') throw new PrepareError(`Run ${found.runId} of this card could not be rolled back to prepare it again; a recovery finishes it, then the card can be taken.`, 409);
      return await prepareRun(ctx, options);
    }
    const run = await freshRun(ctx, found, options, pre);
    cooldowns.delete(key);
    return run;
  } catch (err) {
    inFlight.delete(found.runId);
    if (found.state !== 'prepared' && err instanceof PrepareError && err.status < 500 && err.status !== 409) coolDown(key, print, err.message.split(' Done before it failed')[0], err.status, options);
    throw err;
  }
}

/** Rolls back the card's prepared runs nobody is taking (their inputs fail now), under the card's lock. */
async function dropPrepared(ctx: PrepareContext, repo: string, card: OporaPlace & { nodeId: string }, reason: string) {
  // Looked up first without the lock, so a refusal of a card with no prepared run writes nothing at all (not even a lock file).
  if (!(await activeRecords(ctx.dataDir, { repo, card })).some((r) => r.state === 'prepared')) return;
  await withFileLock(cardLockFile(ctx.dataDir, repo, card), { waitMs: 5000 }, async () => {
    for (const r of await activeRecords(ctx.dataDir, { repo, card })) {
      if (r.state === 'prepared' && !r.claiming && !busy(r)) await finishRollback(ctx.dataDir, r.runId, 'the prepared run could not be taken up again: ' + reason);
    }
  });
}

/** The moves the bridge makes with a run in `prepared`. */
function handle(ctx: PrepareContext, record: PreparedRecord, context: string, resumed: boolean, undo: () => Promise<string[]>): PreparedRun {
  const { dataDir } = ctx, runId = record.runId;
  return {
    runId, digest: record.digest!, context, resumed, capabilities: record.capabilities,
    async claiming(agent, deskId) {
      await updateRecord(dataDir, runId, ['prepared'], undefined, (r) => { r.claiming = { agent, at: new Date().toISOString() }; if (deskId) r.deskId = deskId; });
    },
    granted(lease) {
      // The token goes to disk the moment the claim answered, before the record's lock is waited for: a restart in between finds it to release it.
      writeFileSync(claimFile(dataDir, runId), JSON.stringify({ token: lease.token, agent: lease.agent, at: new Date().toISOString() }), { mode: 0o600 });
    },
    async claimed(lease) {
      // A caller that skipped `granted` still gets the token on disk before the lock is waited for.
      try { writeFileSync(claimFile(dataDir, runId), JSON.stringify({ token: lease.token, agent: lease.agent, at: new Date().toISOString() }), { mode: 0o600 }); } catch { /* the record below carries it */ }
      await updateRecord(dataDir, runId, ['prepared'], 'claimed', (r) => {
        r.lease = { token: lease.token, agent: lease.agent, at: new Date().toISOString() };
        delete r.claiming;
        if (lease.card) r.cardMeta = { ...lease.card };
        if (lease.deskId) r.deskId = lease.deskId;
      });
      try { unlinkSync(claimFile(dataDir, runId)); } catch { /* gone */ }
    },
    async seated(workerId) {
      try { await updateRecord(dataDir, runId, ['claimed'], 'seated', (r) => { r.workerId = workerId; }); }
      finally { inFlight.delete(runId); }
    },
    async releaseFailed(reason) {
      try { await updateRecord(dataDir, runId, ['claimed'], undefined, (r) => { r.error = { step: 'seat', reason: `${reason}; Opora did not confirm the release of the lease: the run stays claimed and a recovery releases it at the next poll` }; }); }
      finally { inFlight.delete(runId); }
    },
    async rollback(reason) {
      try {
        const errors = await undo();
        // After the claim it is the seat that failed (and the bridge released the lease); before it, the claim.
        const claimed = readRecord(dataDir, runId)?.state === 'claimed';
        await finishRollback(dataDir, runId, reason, errors, claimed ? 'seat' : 'claim', claimed);
        try { unlinkSync(claimFile(dataDir, runId)); } catch { /* none */ }
      } finally { inFlight.delete(runId); }
    },
  };
}

/**
 * Moves a run that won't be seated to `failed`, removes its files and, when nothing failed to go, to
 * `rolledBack`. `leaseReleased`: Opora confirmed the run's lease is gone, so the record drops the token.
 */
export async function finishRollback(dataDir: string, runId: string, reason: string, earlier: string[] = [], step: NonNullable<PreparedRecord['error']>['step'] = 'recover', leaseReleased = false, guard: (r: PreparedRecord) => void = () => undefined) {
  const before = readRecord(dataDir, runId);
  if (!before || before.state === 'rolledBack' || before.state === 'seated') return before;
  const released = (r: PreparedRecord) => { if (leaseReleased && r.lease?.token) { delete r.lease.token; r.lease.released = new Date().toISOString(); } };
  const failed = before.state === 'failed'
    ? (leaseReleased ? await updateRecord(dataDir, runId, ['failed'], undefined, released) : before)
    : await updateRecord(dataDir, runId, ['planned', 'preparing', 'prepared', 'claimed'], 'failed', (r) => { guard(r); r.error ??= { step, reason }; released(r); }, reason);
  const { done, errors } = removeRunFiles(dataDir, runId);
  const all = [...earlier, ...errors];
  return updateRecord(dataDir, runId, ['failed'], all.length ? undefined : 'rolledBack', (r) => {
    r.rollback = { at: new Date().toISOString(), done, errors: all };
    for (const s of r.steps) if (s.status === 'done') s.status = 'rolledBack';
  }, all.length ? undefined : `rolled back: ${failed.error?.reason ?? reason}`);
}

type Prepared = { adapter: HarnessAdapter; result: AdapterResult }[];

/** A new run, its read-only steps done: the snapshot written, the adapters, the verification, then `prepared`. A step that fails for good rolls the run back and throws. */
async function freshRun(ctx: PrepareContext, record: PreparedRecord, options: PrepareOptions, pre: Preflight): Promise<PreparedRun> {
  const { dataDir } = ctx, runId = record.runId, { r, snapshot } = pre;
  const undos: (() => void | Promise<void>)[] = [];
  const outs = new Map<number, Prepared>();
  let finished = false;
  const undoAll = async () => {
    const errors: string[] = [];
    for (const undo of undos.splice(0).reverse()) try { await undo(); } catch (err) { errors.push((err as Error).message); }
    return errors;
  };
  let current: StepId = 'snapshot';
  try {
    await runStep(ctx, runId, current, options, { work: async (signal) => { aborted(signal); persistSnapshot(dataDir, snapshot); } });
    await doneStep(dataDir, runId, current, `snapshot sha256:${snapshot.digest}`, [dataRel(dataDir, path.join(snapshotDir(dataDir), runId + '.json'))]);
    await updateRecord(dataDir, runId, ['preparing'], undefined, (x) => { x.digest = snapshot.digest; x.adapters = r.adapters.map((a) => a.id); x.capabilities = r.adapters.flatMap((a) => a.capabilities({ runId, dataDir, repo: ctx.repo, card: snapshot.card, snapshot, scopeDir: attemptScope(dataDir, runId, 1) })); });
    current = 'adapters';
    const made = await runStep(ctx, runId, current, options, {
      async work(signal, attempt) {
        const dir = attemptScope(dataDir, runId, attempt), out: Prepared = [];
        outs.set(attempt, out);
        try {
          for (const adapter of r.adapters) {
            aborted(signal);
            const result = await adapter.prepare({ runId, dataDir, repo: ctx.repo, card: snapshot.card, snapshot, scopeDir: dir, signal });
            out.push({ adapter, result });
            aborted(signal);
            if (!result.ok) throw new HarnessError(`adapter ${adapter.id} could not prepare: ${result.reason ?? 'no reason given'}`, 500);
            const outside = writesOutside(dir, result.steps);
            if (outside.length) throw new HarnessError(`adapter ${adapter.id} reported writes outside its scoped folder, refused: ${outside.map((w) => redactPaths(w, { '<dataDir>': dataDir, '<checkout>': ctx.repo })).join(', ')}`, 422);
          }
          return { out, dir };
        } catch (err) {
          // A timed-out attempt is undone by `late` once it settles: nothing of it runs here after its deadline.
          if (!signal.aborted) for (const { result } of out.splice(0).reverse()) await Promise.resolve().then(() => result.rollback()).catch(() => undefined);
          throw err;
        }
      },
      undo: (attempt) => removeScope(attemptScope(dataDir, runId, attempt)),
      late: (value, attempt) => {
        // An attempt that came in after its time: undone, never used; only its own folder goes (never its retry's).
        for (const { result } of [...(value?.out ?? outs.get(attempt) ?? [])].reverse()) void Promise.resolve().then(() => result.rollback()).catch(() => undefined);
        try { removeScope(attemptScope(dataDir, runId, attempt)); if (finished) removeScope(scopeDir(dataDir, runId)); } catch { /* the recovery's sweep */ }
      },
    });
    for (const { result } of made.out) undos.push(() => result.rollback());
    const writes = made.out.flatMap(({ result }) => result.steps.flatMap((s) => s.writes.map((w) => dataRel(dataDir, path.resolve(made.dir, w)))));
    await doneStep(dataDir, runId, current, made.out.map(({ adapter, result }) => `${adapter.id}: ${result.steps.map((s) => s.detail).join('; ') || 'done'}`).join(' | '), writes);
    await updateRecord(dataDir, runId, ['preparing'], undefined, (x) => { x.scope = dataRel(dataDir, made.dir); for (const c of x.capabilities) c.state = 'prepared'; });
    current = 'verify';
    const context = await runStep(ctx, runId, current, options, { work: (signal) => verifyRun(ctx, runId, snapshot.digest, made.out, signal, made.dir) });
    const prepared = await updateRecord(dataDir, runId, ['preparing'], 'prepared', (x) => {
      Object.assign(step(x, 'verify'), { status: 'done', detail: `${x.capabilities.length} capabilit${x.capabilities.length === 1 ? 'y' : 'ies'} verified` });
      for (const c of x.capabilities) c.state = 'verified';
      x.contexts = Object.fromEntries(made.out.filter(({ adapter }) => adapter.id !== 'context').map(({ adapter, result }) => [adapter.id, result.context ?? '']).filter(([, text]) => text));
    });
    return handle(ctx, prepared, context, false, undoAll);
  } catch (err) {
    finished = true;
    const errors = await undoAll();
    const after = await finishRollback(dataDir, runId, (err as Error).message, errors, current).catch(() => readRecord(dataDir, runId));
    inFlight.delete(runId);
    const status = err instanceof HarnessError ? err.status : 500;
    const message = (err as Error).message.replace(/\.$/, '') + '.';
    const report = after ? ` Done before it failed: ${after.steps.filter((s) => s.status === 'rolledBack').map((s) => s.id).join(', ') || 'nothing'}; rolled back: ${after.rollback?.done.join(', ') || 'nothing written'}${after.rollback?.errors.length ? `; could not roll back: ${after.rollback.errors.join('; ')} (a recovery retries)` : ''}. Run ${runId}, the card was not claimed.` : '';
    throw new PrepareError(message + report, status, after);
  }
}

/** The readiness check: the snapshot reloads whole with its digest, and every adapter's work verifies. Returns the worker's prompt section. */
async function verifyRun(ctx: PrepareContext, runId: string, digest: string, results: Prepared, signal: AbortSignal, scope: string): Promise<string> {
  const snapshot = loadSnapshot(ctx.dataDir, runId);
  if (snapshot.digest !== digest) throw new HarnessError(`Run snapshot ${runId} reloaded with another digest.`, 409);
  const actx: AdapterContext = { runId, dataDir: ctx.dataDir, repo: ctx.repo, card: snapshot.card, snapshot, scopeDir: scope, signal };
  for (const { adapter, result } of results) {
    aborted(signal);
    const why = await adapter.verify(actx, result);
    if (why) throw new HarnessError(`adapter ${adapter.id} did not verify: ${why}`, 422);
  }
  return results.map(({ result }) => result.context ?? '').join('');
}

/**
 * Takes up a run prepared before (by this office before a restart, or a take that stopped before its
 * claim). The read-only steps ran again for this take and built the snapshot in memory only: when its
 * digest is the recorded one and the written snapshot still loads with it, the adapters' work is
 * verified (not redone) and the run is used as it is. When the inputs changed since, it is rolled back
 * and undefined returned, for a new run. Nothing is written but the record's report.
 */
async function resumeRun(ctx: PrepareContext, record: PreparedRecord, options: PrepareOptions, pre: Preflight): Promise<PreparedRun | undefined> {
  const { dataDir } = ctx, runId = record.runId;
  try {
    const ids = pre.r.adapters.map((a) => a.id);
    if (pre.snapshot.digest !== record.digest || ids.join(',') !== record.adapters.join(',')) {
      await finishRollback(dataDir, runId, 'its inputs changed since it was prepared (profile, elements or adapters); a new run is prepared');
      inFlight.delete(runId);
      return undefined;
    }
    const scope = recordScope(dataDir, record);
    const results: Prepared = pre.r.adapters.map((adapter) => ({ adapter, result: { ok: true, steps: [], context: adapter.id === 'context' ? undefined : record.contexts[adapter.id], rollback: () => undefined } }));
    const contract = await contextAdapter.prepare({ runId, dataDir, repo: ctx.repo, card: pre.snapshot.card, snapshot: loadSnapshot(dataDir, runId), scopeDir: scope, signal: new AbortController().signal });
    results.find(({ adapter }) => adapter.id === 'context')!.result.context = contract.context;
    const context = await bounded(stepTimeouts(options).verify, (signal) => verifyRun(ctx, runId, record.digest!, results, signal, scope));
    const now = await updateRecord(dataDir, runId, ['prepared'], undefined, (x) => { x.history.push({ state: 'prepared', at: new Date().toISOString(), note: 'taken up again after a restart: inputs and snapshot unchanged, adapters verified, nothing prepared again' }); });
    return handle(ctx, now, context, true, async () => []);
  } catch (err) {
    await finishRollback(dataDir, runId, 'the prepared run could not be taken up again: ' + (err as Error).message).catch(() => undefined);
    inFlight.delete(runId);
    if (err instanceof HarnessError && err.status < 500 && !(err instanceof PrepareError)) throw new PrepareError((err as Error).message + ` (run ${runId} was rolled back; the card was not claimed)`, err.status);
    return undefined;
  }
}

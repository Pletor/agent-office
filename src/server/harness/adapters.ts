// Runner adapters for the preparation runner (prepare.ts, docs/harness.md "Preparation runner"). An
// adapter turns a run's pinned snapshot into what one runner needs before its worker is seated: the
// built-in `context` adapter renders the worker's contract from the snapshot (the behaviour every
// Opora take had before), and later adapters (MCP, hooks, permissions: H13/H15) will write their scoped
// configuration under the run's own folder. Nothing is active because it was named: an adapter's
// capabilities start `declared`, become `prepared` only when its prepare step said so, and `verified`
// only when the runner checked them afterwards. An adapter a profile names that this office doesn't
// have, or that says it can't run here, is refused with the reason, before anything is written.
import path from 'node:path';
import { runContract } from './run.js';
import { SNAPSHOT_LIMITS, type StoredSnapshot } from './snapshot.js';
import type { OporaPlace } from '../../shared/opora-identity.js';

/** declared: named by the profile or the adapter; prepared: the adapter's prepare step made it; verified: the runner checked it after. */
export type CapabilityState = 'declared' | 'prepared' | 'verified';
export interface Capability { id: string; adapter: string; state: CapabilityState; detail: string }

/** What an adapter is prepared with: the run, its pinned snapshot, and the folder its scoped files go in. */
export interface AdapterContext {
  runId: string;
  dataDir: string;
  repo: string;
  card: OporaPlace & { nodeId: string };
  snapshot: StoredSnapshot;
  /**
   * `<dataDir>/harness-prepared/<runId>/<attempt>/` (each attempt of the adapters step has its own): the
   * only place an adapter writes. It is removed when the attempt fails and with the run when it rolls back.
   * The runner refuses a result whose reported `writes` reach outside it (writesOutside); what an adapter
   * writes without reporting it is its own `rollback()`'s to undo.
   */
  scopeDir: string;
  /** Aborted when the step's time is up: an adapter stops and leaves its rollback to the runner. */
  signal: AbortSignal;
}

/** One thing an adapter did (or, in a plan, would do): its id, what it is, and the files it writes (absolute, or relative to `scopeDir`). */
export interface AdapterStep { id: string; detail: string; writes: string[] }

/** The reported writes of `steps` that aren't inside `scopeDir` (relative ones are taken from it): a result with any is refused. */
export function writesOutside(scopeDir: string, steps: readonly AdapterStep[]): string[] {
  const root = path.resolve(scopeDir);
  return steps.flatMap((s) => s.writes).filter((w) => { const at = path.resolve(root, w); return at !== root && !at.startsWith(root + path.sep); });
}

/** What `prepare` returns: whether it worked, what it did, the worker's prompt section, and how to undo it. */
export interface AdapterResult {
  ok: boolean;
  steps: AdapterStep[];
  /** Text this adapter adds to the worker's prompt (the context adapter: the run contract). */
  context?: string;
  /** Why it did not work, when `ok` is false. */
  reason?: string;
  /** Undoes what `prepare` did that isn't inside `scopeDir` (the runner removes that folder itself). Must be safe to call twice. */
  rollback(): void | Promise<void>;
}

export interface HarnessAdapter {
  readonly id: string;
  readonly title: string;
  /** Why this adapter can't run on this office now, or undefined when it can. */
  unsupported?(): string | undefined;
  /** What the adapter provides for this run, all `declared`. */
  capabilities(ctx: Omit<AdapterContext, 'signal'>): Capability[];
  /** What `prepare` would do, for a dry run: nothing is written. */
  plan(ctx: Omit<AdapterContext, 'signal'>): AdapterStep[];
  prepare(ctx: AdapterContext): Promise<AdapterResult>;
  /** Checks what `prepare` made is in place and usable: returns the reason when it isn't. */
  verify(ctx: AdapterContext, result: AdapterResult): Promise<string | undefined>;
}

const adapters = new Map<string, HarnessAdapter>();
const ADAPTER_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** Adds an adapter to the registry; returns what takes it out again. A second adapter with the same id is refused. */
export function registerAdapter(adapter: HarnessAdapter): () => void {
  if (!ADAPTER_ID.test(adapter.id)) throw new Error('Invalid adapter id: ' + adapter.id);
  if (adapters.has(adapter.id)) throw new Error('An adapter with id ' + adapter.id + ' is registered already');
  adapters.set(adapter.id, adapter);
  return () => { if (adapters.get(adapter.id) === adapter) adapters.delete(adapter.id); };
}

/** The registered adapters, in registration order. */
export function listAdapters(): HarnessAdapter[] {
  return [...adapters.values()];
}

/** Names that will be adapters of their own (H13/H15) and are refused here with that reason. */
const LATER: Record<string, string> = {
  mcp: 'MCP servers are configured by the runner adapters of H13; this office does not set them up yet',
  hooks: 'hook installation belongs to the runner adapters of H13; this office does not install hooks yet',
  permissions: 'runner permissions are configured by H13/H15; this office does not change a runner\'s permissions',
};

/**
 * The adapters a run uses, by id, in order, each once: `context` always first, then the ones named. An
 * id that isn't registered, or whose adapter says it can't run here, is refused with the reason; the
 * whole list is refused, so nothing is prepared for a run that couldn't be made ready.
 */
export function resolveAdapters(ids: readonly string[]): { adapters: HarnessAdapter[]; refused: { id: string; reason: string }[] } {
  const wanted = [...new Set(['context', ...ids.map((s) => s.trim().toLowerCase()).filter(Boolean)])];
  const out: HarnessAdapter[] = [], refused: { id: string; reason: string }[] = [];
  for (const id of wanted) {
    const adapter = adapters.get(id);
    if (!adapter) { refused.push({ id, reason: LATER[id] ?? (ADAPTER_ID.test(id) ? 'no adapter with this id is registered in this office' : 'not a valid adapter id') }); continue; }
    const why = adapter.unsupported?.();
    if (why) { refused.push({ id, reason: why }); continue; }
    out.push(adapter);
  }
  return { adapters: out, refused };
}

/**
 * The built-in adapter every run has: the worker's contract rendered from the pinned snapshot (run.ts
 * runContract), the essential elements embedded and the rest listed by ID. It writes no file: the
 * snapshot is the runner's own step. Verified when the contract names the run and its digest and fits
 * the prompt budget.
 */
export const contextAdapter: HarnessAdapter = {
  id: 'context',
  title: 'Context only (contract + snapshot)',
  capabilities: (ctx) => [
    { id: 'context.contract', adapter: 'context', state: 'declared', detail: 'the worker contract with the essential elements embedded' },
    { id: 'context.lazy-reads', adapter: 'context', state: 'declared', detail: `office-harness --read from snapshot ${ctx.runId}` },
  ],
  plan: (ctx) => [{ id: 'context.contract', detail: `render the worker contract from snapshot ${ctx.runId} (${ctx.snapshot.eager.length} essential, ${ctx.snapshot.lazy.length} by ID)`, writes: [] }],
  async prepare(ctx) {
    const context = runContract(ctx.snapshot);
    return { ok: true, steps: [{ id: 'context.contract', detail: `contract of ${Buffer.byteLength(context)} bytes`, writes: [] }], context, rollback: () => undefined };
  },
  async verify(ctx, result) {
    const text = result.context ?? '';
    if (!text.includes('Run: ' + ctx.runId) || !text.includes(ctx.snapshot.digest)) return 'the contract does not name its run and snapshot digest';
    const budget = SNAPSHOT_LIMITS.eagerBytes + 32 * 1024;
    if (Buffer.byteLength(text) > budget) return `the worker's harness contract exceeds ${budget / 1024} KiB; choose smaller resources`;
    return undefined;
  },
};
registerAdapter(contextAdapter);

/** How a fake adapter behaves, for tests of the runner: each knob makes one step fail in one way. */
export interface FakeAdapterOptions {
  id?: string;
  /** Throw from prepare (the first `throwTimes` calls, or every call when undefined and `throws` is set). */
  throws?: string;
  throwTimes?: number;
  /** Resolve prepare only after this many ms (to exceed a step's timeout); only in the first `delayTimes` calls when that is set. */
  delayMs?: number;
  delayTimes?: number;
  /** Write the scoped config only after the delay, as a slow runner would (a write that lands after its step timed out). */
  lateWrite?: boolean;
  /** Return ok: false with this reason. */
  fails?: string;
  /** Fail verification with this reason. */
  verifyFails?: string;
  unsupported?: string;
  /** Also write (and report) this file, relative to the data dir: outside the scoped folder, which the runner refuses. */
  outside?: string;
}

/**
 * An adapter for tests: it writes `<scopeDir>/<id>.json` (a stand-in for a runner's scoped config),
 * counts its calls and rollbacks, and fails where its options say. It is not registered by default.
 */
export function fakeAdapter(options: FakeAdapterOptions = {}) {
  const id = options.id ?? 'fake';
  const calls = { prepare: 0, rollback: 0, verify: 0 };
  const adapter: HarnessAdapter = {
    id,
    title: 'Fake adapter (tests)',
    unsupported: () => options.unsupported,
    capabilities: () => [{ id: id + '.config', adapter: id, state: 'declared', detail: 'a scoped config file' }],
    plan: (ctx) => [{ id: id + '.config', detail: 'write the scoped config', writes: [ctx.scopeDir + '/' + id + '.json'] }],
    async prepare(ctx) {
      calls.prepare++;
      if (options.throws && (options.throwTimes === undefined || calls.prepare <= options.throwTimes)) throw new Error(options.throws);
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const file = ctx.scopeDir + '/' + id + '.json';
      const write = () => { mkdirSync(ctx.scopeDir, { recursive: true }); writeFileSync(file, JSON.stringify({ run: ctx.runId, digest: ctx.snapshot.digest })); };
      const delay = options.delayMs && (options.delayTimes === undefined || calls.prepare <= options.delayTimes) ? options.delayMs : 0;
      if (!options.lateWrite || !delay) write();
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (options.lateWrite && delay) write();
      const rollback = () => { calls.rollback++; };
      if (options.fails) return { ok: false, steps: [], reason: options.fails, rollback };
      const extra = options.outside ? [path.join(ctx.dataDir, options.outside)] : [];
      for (const other of extra) writeFileSync(other, 'outside');
      return { ok: true, steps: [{ id: id + '.config', detail: 'wrote the scoped config', writes: [file, ...extra] }], rollback };
    },
    async verify() {
      calls.verify++;
      return options.verifyFails;
    },
  };
  return { adapter, calls };
}

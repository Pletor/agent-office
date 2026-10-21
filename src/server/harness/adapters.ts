// Runner adapters for the preparation runner (prepare.ts, docs/harness.md "Preparation runner"). An
// adapter turns a run's pinned snapshot into what one runner needs before its worker is seated: the
// built-in `context` adapter renders the worker's contract from the snapshot (the behaviour every
// Opora take had before), and later adapters (MCP, hooks, permissions: H13/H15) will write their scoped
// configuration under the run's own folder. Nothing is active because it was named: an adapter's
// capabilities start `declared`, become `prepared` only when its prepare step said so, and `verified`
// only when the runner checked them afterwards. An adapter a profile names that this office doesn't
// have, or that says it can't run here, is refused with the reason, before anything is written.
import { runContract } from './run.js';
import { SNAPSHOT_LIMITS, type StoredSnapshot } from './snapshot.js';
import type { OporaPlace } from '../../shared/opora-identity.js';
import type { AgentProvider } from '../../shared/providers.js';

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
  /** `<dataDir>/harness-prepared/<runId>/`: the only place an adapter writes; it is removed whole when the run rolls back. */
  scopeDir: string;
  /** Aborted when the step's time is up: an adapter stops and leaves its rollback to the runner. */
  signal: AbortSignal;
  /** The runner the worker is seated with (the office default at prepare time), when known: per-run configuration is per runner. */
  runner?: AgentProvider;
}

/**
 * What an adapter hands the worker's launch for THIS run only (launch-scope.ts): files under `scopeDir`
 * the runner's own per-run flags point to. Never a secret, never a flag that widens what the runner may do.
 */
export interface LaunchContribution {
  runner: AgentProvider;
  /** A per-run MCP config file (Claude Code: --mcp-config), and whether only the listed servers load (--strict-mcp-config). */
  mcpConfig?: string;
  strictMcp?: boolean;
  /** A per-run file of narrowing permission rules (deny/ask), merged into the runner's settings at launch. */
  permissions?: string;
}
/** What `verify` may say beyond pass/fail: each capability's state as the probes found it (only `verified` ones are offered to the worker). */
export interface VerifyReport { reason?: string; capabilities?: Capability[] }
/** What a recovery hands an adapter after a restart, with no closure from `prepare` left. */
export interface RecoverContext { runId: string; dataDir: string; scopeDir: string }

/** One thing an adapter did (or, in a plan, would do): its id, what it is, and the files it writes. */
export interface AdapterStep { id: string; detail: string; writes: string[] }

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
  /** Per-run launch configuration for the worker (launch-scope.ts); kept in the run's record. */
  launch?: LaunchContribution;
  /** JSON state kept in the run's record (no secrets), handed to `recover` after a restart so a rollback survives it. */
  persist?: Record<string, unknown>;
}

export interface HarnessAdapter {
  readonly id: string;
  readonly title: string;
  /** Why this adapter can't run on this office now (for this runner), or undefined when it can. */
  unsupported?(ctx?: { runner?: AgentProvider }): string | undefined;
  /** What the adapter provides for this run, all `declared`. */
  capabilities(ctx: Omit<AdapterContext, 'signal'>): Capability[];
  /** What `prepare` would do, for a dry run: nothing is written. */
  plan(ctx: Omit<AdapterContext, 'signal'>): AdapterStep[];
  prepare(ctx: AdapterContext): Promise<AdapterResult>;
  /**
   * Checks what `prepare` made is in place and usable: returns the reason when it isn't. A report may set
   * each of the adapter's capabilities' state as its probes found it; without one, all become `verified`.
   */
  verify(ctx: AdapterContext, result: AdapterResult): Promise<string | undefined | VerifyReport>;
  /**
   * Undoes, after a restart, what this adapter did for a run that is being rolled back, from the state it
   * persisted (AdapterResult.persist). Idempotent; returns what could not be undone.
   */
  recover?(ctx: RecoverContext, persisted: Record<string, unknown>): Promise<string[] | void>;
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
export function resolveAdapters(ids: readonly string[], runner?: AgentProvider): { adapters: HarnessAdapter[]; refused: { id: string; reason: string }[] } {
  const wanted = [...new Set(['context', ...ids.map((s) => s.trim().toLowerCase()).filter(Boolean)])];
  const out: HarnessAdapter[] = [], refused: { id: string; reason: string }[] = [];
  for (const id of wanted) {
    const adapter = adapters.get(id);
    if (!adapter) { refused.push({ id, reason: LATER[id] ?? (ADAPTER_ID.test(id) ? 'no adapter with this id is registered in this office' : 'not a valid adapter id') }); continue; }
    const why = adapter.unsupported?.({ runner });
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
  /** Resolve prepare only after this many ms (to exceed a step's timeout). */
  delayMs?: number;
  /** Write the scoped config only after the delay, as a slow runner would (a write that lands after its step timed out). */
  lateWrite?: boolean;
  /** Return ok: false with this reason. */
  fails?: string;
  /** Fail verification with this reason. */
  verifyFails?: string;
  unsupported?: string;
  /** Capability ids it declares (default `<id>.config`). */
  capabilities?: string[];
  /** The state verify reports for each capability (default: no report, so all become verified). */
  verifyStates?: Record<string, CapabilityState>;
  /** State persisted in the record, for `recover`. */
  persist?: Record<string, unknown>;
}

/**
 * An adapter for tests: it writes `<scopeDir>/<id>.json` (a stand-in for a runner's scoped config),
 * counts its calls and rollbacks, and fails where its options say. It is not registered by default.
 */
export function fakeAdapter(options: FakeAdapterOptions = {}) {
  const id = options.id ?? 'fake';
  const calls = { prepare: 0, rollback: 0, verify: 0 };
  /** The persisted states its `recover` was handed. */
  const recovered: Record<string, unknown>[] = [];
  const caps = options.capabilities ?? [id + '.config'];
  const adapter: HarnessAdapter = {
    id,
    title: 'Fake adapter (tests)',
    unsupported: () => options.unsupported,
    capabilities: () => caps.map((c) => ({ id: c, adapter: id, state: 'declared' as const, detail: 'a scoped config file' })),
    plan: (ctx) => [{ id: id + '.config', detail: 'write the scoped config', writes: [ctx.scopeDir + '/' + id + '.json'] }],
    async prepare(ctx) {
      calls.prepare++;
      if (options.throws && (options.throwTimes === undefined || calls.prepare <= options.throwTimes)) throw new Error(options.throws);
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const file = ctx.scopeDir + '/' + id + '.json';
      const write = () => { mkdirSync(ctx.scopeDir, { recursive: true }); writeFileSync(file, JSON.stringify({ run: ctx.runId, digest: ctx.snapshot.digest })); };
      if (!options.lateWrite) write();
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (options.lateWrite) write();
      const rollback = () => { calls.rollback++; };
      if (options.fails) return { ok: false, steps: [], reason: options.fails, rollback };
      return { ok: true, steps: [{ id: id + '.config', detail: 'wrote the scoped config', writes: [file] }], rollback, ...(options.persist ? { persist: options.persist } : {}) };
    },
    async verify() {
      calls.verify++;
      if (options.verifyFails) return options.verifyFails;
      const states = options.verifyStates;
      return states ? { capabilities: caps.map((c) => ({ id: c, adapter: id, state: states[c] ?? 'prepared', detail: states[c] === 'verified' ? 'probed' : 'not probed' })) } : undefined;
    },
    async recover(_ctx, persisted) { recovered.push(persisted); },
  };
  return { adapter, calls, recovered };
}

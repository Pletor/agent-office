// A prepared run's launch configuration, for that run's worker only (docs/harness.md "Runner adapters and
// capabilities"). The preparation runner keeps what the adapters hand the launch (per-run MCP config,
// narrowing permission rules) in the run's record; the bridge seats the card's worker inside
// `seatWithRun`, and the worker's provider asks `runLaunchFor` as it builds the command line, on the
// first launch and on every relaunch after (a restart included: the record is found again by worker id).
// Nothing here edits a runner's global configuration: every file is under the run's scoped folder.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listRecords, readRecord, scopeDir } from './prepare-store.js';
import type { LaunchContribution } from './adapters.js';
import type { AgentProvider } from '../../shared/providers.js';

/** What a run's adapters handed its worker's launch, merged (kept in the record as `launch`). */
export interface RunLaunch extends LaunchContribution { runId: string }

let store: string | undefined;
const byWorker = new Map<string, RunLaunch | null>();
let pending: string | undefined;

/** Where the preparation records are (the office's data dir): set once as the office opens its floors. */
export function bindRunLaunches(dataDir: string) { store = dataDir; byWorker.clear(); }

/** Merges what each adapter contributed; two adapters for different runners, or two of the same file kind, are refused. */
export function mergeLaunch(runId: string, parts: readonly (LaunchContribution | undefined)[]): RunLaunch | undefined {
  const given = parts.filter((p): p is LaunchContribution => !!p);
  if (!given.length) return undefined;
  const out: RunLaunch = { runId, runner: given[0].runner };
  for (const p of given) {
    if (p.runner !== out.runner) throw new Error(`adapters prepared launches for two runners (${out.runner}, ${p.runner})`);
    for (const key of ['mcpConfig', 'permissions'] as const) if (p[key]) { if (out[key]) throw new Error(`two adapters set the run's ${key}`); out[key] = p[key]; }
    if (p.strictMcp) out.strictMcp = true;
  }
  return out;
}

/** Seats a card's worker for a prepared run: its first launch (inside `seat`) takes the run's launch configuration. */
export function seatWithRun<T>(runId: string | undefined, seat: () => T): T {
  const before = pending;
  pending = runId;
  try { return seat(); } finally { pending = before; }
}

/** A launch from a record, its files checked to be inside the run's scoped folder (a record edited by hand is not followed out of it). */
function launchOf(dataDir: string, runId: string, launch: RunLaunch | undefined): RunLaunch | null {
  if (!launch || launch.runId !== runId) return null;
  const scope = scopeDir(dataDir, runId);
  for (const file of [launch.mcpConfig, launch.permissions]) {
    if (file === undefined) continue;
    const rel = path.relative(scope, path.resolve(file));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`run ${runId}'s launch names a file outside its scoped folder`);
  }
  return launch;
}

/** The run launch of this worker, or undefined when it has none. Throws when its record names a file outside the run's scope. */
export function runLaunchFor(info: { id: string; provider?: AgentProvider }): RunLaunch | undefined {
  if (!store) return undefined;
  if (pending && !byWorker.has(info.id)) {
    const r = readRecord(store, pending);
    if (r && r.state === 'claimed' && !r.workerId) byWorker.set(info.id, launchOf(store, r.runId, r.launch));
  }
  if (!byWorker.has(info.id)) {
    const r = listRecords(store).records.find((x) => x.state === 'seated' && x.workerId === info.id);
    byWorker.set(info.id, r ? launchOf(store, r.runId, r.launch) : null);
  }
  return byWorker.get(info.id) ?? undefined;
}

/** The narrowing rules a run's permissions file holds (only deny and ask, as the adapter wrote them). */
export function readNarrowing(file: string): { deny: string[]; ask: string[] } {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { permissions?: { deny?: unknown; ask?: unknown } };
  const list = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : []);
  const p = parsed?.permissions ?? {};
  if (Object.keys(parsed ?? {}).some((k) => k !== 'permissions') || Object.keys(p).some((k) => k !== 'deny' && k !== 'ask')) throw new Error('the run\'s permissions file holds more than deny and ask');
  return { deny: list(p.deny), ask: list(p.ask) };
}

/**
 * The office's Claude Code settings with a run's narrowing added: its hooks and its allow list exactly as
 * they are, deny and ask extended. Nothing is removed and nothing is allowed that wasn't.
 */
export function mergeClaudeSettings(office: unknown, narrow: { deny: string[]; ask: string[] }): Record<string, unknown> {
  const base = office && typeof office === 'object' && !Array.isArray(office) ? structuredClone(office) as Record<string, any> : {};
  const perms = base.permissions && typeof base.permissions === 'object' ? base.permissions : {};
  const add = (have: unknown, more: string[]) => [...new Set([...(Array.isArray(have) ? have : []), ...more])];
  base.permissions = { ...perms, deny: add(perms.deny, narrow.deny), ask: add(perms.ask, narrow.ask) };
  return base;
}

/** What Claude Code's command line gets for a worker's run: the settings file to use, extra MCP configs, strict or not; or why it must not start. */
export interface ClaudeScoped { settings?: string; mcp: string[]; strict: boolean; error?: string }
export function claudeScopedLaunch(info: { id: string; provider?: AgentProvider }, officeSettings: string): ClaudeScoped {
  let launch: RunLaunch | undefined;
  try { launch = runLaunchFor(info); } catch (err) { return { mcp: [], strict: false, error: 'Harness run: ' + (err as Error).message }; }
  if (!launch) return { mcp: [], strict: false };
  if (launch.runner !== 'claude') return { mcp: [], strict: false, error: `Harness run ${launch.runId} was prepared for ${launch.runner}, not Claude Code: not started without its configuration` };
  const out: ClaudeScoped = { mcp: launch.mcpConfig ? [launch.mcpConfig] : [], strict: !!launch.strictMcp };
  if (launch.permissions) {
    // Fail closed: a worker whose run narrows its permissions never starts without them.
    try {
      const merged = mergeClaudeSettings(JSON.parse(readFileSync(officeSettings, 'utf8')), readNarrowing(launch.permissions));
      const file = path.join(path.dirname(launch.permissions), 'claude-settings.json');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
      out.settings = file;
    } catch (err) { out.error = `Harness run ${launch.runId}: its permission rules could not be applied (${(err as Error).message}); not started without them`; }
  }
  return out;
}

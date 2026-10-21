// What each runner on this machine can really do (docs/harness.md "Runner adapters and capabilities"),
// found by code, never by what a profile or a model claims: the executable on PATH, its version from a
// bounded `--version` call, and the per-run flags its own `--help` documents. Every call is an argument
// vector (no shell), with a timeout, a capped output and a scrubbed environment; a Windows `.cmd`/`.bat`
// launcher, which only a shell can start, is located but never run. A capability is `declared` when the
// runner documents it (or the office wires it) and `verified` only when a probe here proved it; one the
// runner can't do per run is `supported: false` with the reason. Results are cached for a short time.
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { AGENT_PROVIDERS, PROVIDER_META, type AgentProvider } from '../../shared/providers.js';
import type { CapabilityState } from './adapters.js';

/** One thing a runner can or can't do, with how that was found out. */
export interface RunnerCapability {
  id: 'runner.present' | 'runner.version' | 'mcp.per-run' | 'permissions.per-run' | 'hooks.lifecycle';
  state: CapabilityState;
  /** False when this runner can't do it per run (or at all) here: `detail` says why. */
  supported: boolean;
  detail: string;
  /** What the state rests on: the path found, the version line, the flags seen in --help. */
  evidence: string;
}
export interface RunnerReport { runner: AgentProvider; bin?: string; path?: string; version?: string; capabilities: RunnerCapability[]; checkedAt: number }

export interface SpawnResult { code: number | null; stdout: string; stderr: string; error?: string }
/** Runs `file` with `args` as a vector, bounded; never through a shell. */
export type Spawner = (file: string, args: readonly string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<SpawnResult>;
/** Finds an executable on PATH (with PATHEXT on Windows), or undefined. */
export type Locator = (bin: string) => string | undefined;

export const DETECT_LIMITS = { timeoutMs: 5000, outputBytes: 256 * 1024, ttlMs: 60_000 } as const;

/** The environment a probe runs in: what finding and starting an executable needs, nothing else (no tokens, no keys). */
export function probeEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (source[key] !== undefined) env[key] = source[key];
  env.NO_COLOR = '1';
  return env;
}

export const defaultSpawner: Spawner = (file, args, { timeoutMs, env }) => new Promise((resolve) => {
  execFile(file, [...args], { shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: DETECT_LIMITS.outputBytes, env, encoding: 'utf8' }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { code?: unknown; killed?: boolean }) | null;
    resolve({ code: e ? (typeof e.code === 'number' ? e.code : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), ...(e ? { error: e.killed ? `timed out after ${timeoutMs} ms` : e.message } : {}) });
  });
});

export const defaultLocator: Locator = (bin) => {
  const win = process.platform === 'win32';
  const exts = win && !path.extname(bin) ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  // Only absolute PATH entries: a relative one (`.`) would resolve against the office's working directory.
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d))) {
    for (const ext of exts) {
      const file = path.join(dir, bin + ext);
      try { accessSync(file, constants.X_OK); return file; } catch { /* keep looking */ }
    }
  }
  return undefined;
};

/** A launcher only a shell can run (Windows batch files): the office never starts one for a probe. */
export const needsShell = (file: string) => /\.(cmd|bat)$/i.test(file);

/** What each runner documents for per-run configuration, and what this office does with it. */
interface RunnerSpec {
  /** Flags `--help` must list for per-run MCP; undefined when the runner has no per-run mechanism the office uses. */
  mcpFlags?: string[];
  permissionFlags?: string[];
  /** Why per-run MCP / permissions are refused for this runner. */
  mcpRefusal: string;
  permissionRefusal: string;
  /** How the office wires its lifecycle hooks, or undefined when it doesn't. */
  hooks?: string;
}
const NO_ADAPTER = 'no adapter in this office writes its per-run configuration yet';
const SPECS: Record<AgentProvider, RunnerSpec> = {
  claude: { mcpFlags: ['--mcp-config', '--strict-mcp-config'], permissionFlags: ['--settings'], mcpRefusal: '', permissionRefusal: '', hooks: '--settings with the office hook commands (providers/claude.ts)' },
  codex: { mcpRefusal: `Codex takes MCP servers per run only as \`-c mcp_servers.*\` TOML overrides on its command line; ${NO_ADAPTER}`, permissionRefusal: `Codex's approval and sandbox policy is not narrowed per run by this office; ${NO_ADAPTER}`, hooks: 'the office hook route via AGENT_OFFICE_HOOK_URL (providers/codex.ts)' },
  cursor: { mcpRefusal: `Cursor Agent reads MCP servers from its own config folders, with no per-run file flag; ${NO_ADAPTER}`, permissionRefusal: `Cursor Agent has no per-run permission file the office can hand it; ${NO_ADAPTER}`, hooks: 'hook files in its worker folder (providers/cursor.ts)' },
  opencode: { mcpRefusal: `OpenCode's MCP servers come from its config, not a per-run flag this office uses; ${NO_ADAPTER}`, permissionRefusal: `OpenCode's permissions are not narrowed per run by this office; ${NO_ADAPTER}`, hooks: 'an OpenCode plugin posting to the office hook route (providers/opencode.ts)' },
  grok: { mcpRefusal: `Grok reads MCP servers from GROK_HOME, which is the worker's home, not a per-run file; ${NO_ADAPTER}`, permissionRefusal: `Grok's permissions are not narrowed per run by this office; ${NO_ADAPTER}`, hooks: 'hooks in its isolated GROK_HOME (providers/grok.ts)' },
  muse: { mcpRefusal: `Muse has no per-run MCP flag this office uses; ${NO_ADAPTER}`, permissionRefusal: `Muse's permissions are not narrowed per run by this office; ${NO_ADAPTER}`, hooks: 'hooks in its isolated XDG folders (providers/muse.ts)' },
  pi: { mcpRefusal: `Pi has no MCP support the office knows of; ${NO_ADAPTER}`, permissionRefusal: `Pi's permissions are not narrowed per run by this office; ${NO_ADAPTER}`, hooks: 'the office hook route via AGENT_OFFICE_HOOK_URL (providers/pi.ts)' },
  dsh: { mcpRefusal: `DeepSeek Harness runs over ACP with its own profile; ${NO_ADAPTER}`, permissionRefusal: `DeepSeek Harness approvals are answered by the office over ACP, not narrowed per run; ${NO_ADAPTER}` },
  custom: { mcpRefusal: 'a custom --agent is an executable the office knows nothing about: nothing is configured for it per run', permissionRefusal: 'a custom --agent is an executable the office knows nothing about: its permissions are never changed' },
};

const VERSION = /\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/;
const firstLine = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? '';
/** Whether a --help text lists a flag as an option (at a word boundary, not inside another flag). */
export const helpLists = (help: string, flag: string) => new RegExp(`(^|[\\s,])${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,=<]|$)`, 'm').test(help);

export interface DetectOptions { spawner?: Spawner; locator?: Locator; env?: NodeJS.ProcessEnv; timeoutMs?: number; ttlMs?: number; now?: () => number }

/** Detects one runner now, without the cache. */
export async function probeRunner(runner: AgentProvider, options: DetectOptions = {}): Promise<RunnerReport> {
  const spawner = options.spawner ?? defaultSpawner, locator = options.locator ?? defaultLocator;
  const env = probeEnv(options.env), timeoutMs = options.timeoutMs ?? DETECT_LIMITS.timeoutMs;
  const spec = SPECS[runner], bin = PROVIDER_META[runner]?.bin;
  const report: RunnerReport = { runner, ...(bin ? { bin } : {}), capabilities: [], checkedAt: (options.now ?? Date.now)() };
  const add = (c: RunnerCapability) => report.capabilities.push(c);
  const refuseRest = (why: string) => {
    add({ id: 'mcp.per-run', state: 'declared', supported: false, detail: spec.mcpFlags ? why : spec.mcpRefusal, evidence: why });
    add({ id: 'permissions.per-run', state: 'declared', supported: false, detail: spec.permissionFlags ? why : spec.permissionRefusal, evidence: why });
  };
  const hooks = () => add(spec.hooks
    ? { id: 'hooks.lifecycle', state: 'declared', supported: true, detail: 'the office wires its lifecycle hooks; a hook that fired is what verifies them (H15)', evidence: spec.hooks }
    : { id: 'hooks.lifecycle', state: 'declared', supported: false, detail: 'the office installs no lifecycle hooks for this runner', evidence: 'no hook route in its provider' });
  if (!bin) {
    add({ id: 'runner.present', state: 'declared', supported: false, detail: 'no known executable: nothing is probed', evidence: 'PROVIDER_META has no bin' });
    refuseRest('no known executable');
    hooks();
    return report;
  }
  const found = locator(bin);
  if (!found) {
    add({ id: 'runner.present', state: 'declared', supported: false, detail: `${bin} is not on PATH`, evidence: 'PATH lookup found nothing' });
    refuseRest(`${bin} is not on PATH`);
    hooks();
    return report;
  }
  report.path = found;
  add({ id: 'runner.present', state: 'verified', supported: true, detail: `${bin} found on PATH`, evidence: found });
  if (needsShell(found)) {
    const why = `${path.basename(found)} is a batch launcher only a shell can start; the office never runs one to probe`;
    add({ id: 'runner.version', state: 'declared', supported: true, detail: 'not probed: ' + why, evidence: found });
    refuseRest('not probed: ' + why);
    hooks();
    return report;
  }
  const version = await spawner(found, ['--version'], { timeoutMs, env });
  const line = firstLine(version.stdout) || firstLine(version.stderr);
  if (version.code === 0 && VERSION.test(line)) {
    report.version = line;
    add({ id: 'runner.version', state: 'verified', supported: true, detail: `answered --version within ${timeoutMs} ms`, evidence: line });
  } else add({ id: 'runner.version', state: 'declared', supported: true, detail: `--version did not answer with a version${version.error ? ': ' + version.error : ''}`, evidence: line || '(no output)' });
  if (!spec.mcpFlags && !spec.permissionFlags) { refuseRest(''); hooks(); return report; }
  const help = await spawner(found, ['--help'], { timeoutMs, env });
  const text = help.code === 0 ? help.stdout + '\n' + help.stderr : '';
  const flags = (id: 'mcp.per-run' | 'permissions.per-run', wanted: string[] | undefined, refusal: string) => {
    if (!wanted) return add({ id, state: 'declared', supported: false, detail: refusal, evidence: 'no per-run mechanism used by this office' });
    const missing = wanted.filter((f) => !helpLists(text, f));
    if (!missing.length) return add({ id, state: 'verified', supported: true, detail: `per run through ${wanted.join(' ')}`, evidence: `--help lists ${wanted.join(', ')}` });
    add({ id, state: 'declared', supported: false, detail: `this ${bin} does not list ${missing.join(', ')} in --help${help.error ? ' (' + help.error + ')' : ''}: refused rather than configured globally`, evidence: text ? `--help without ${missing.join(', ')}` : '--help did not answer' });
  };
  flags('mcp.per-run', spec.mcpFlags, spec.mcpRefusal);
  flags('permissions.per-run', spec.permissionFlags, spec.permissionRefusal);
  hooks();
  return report;
}

const cache = new Map<AgentProvider, { at: number; report: Promise<RunnerReport> }>();

/** One runner's capabilities, cached for `ttlMs` (a minute by default) within this office run. */
export function detectRunner(runner: AgentProvider, options: DetectOptions = {}): Promise<RunnerReport> {
  const now = (options.now ?? Date.now)(), ttl = options.ttlMs ?? DETECT_LIMITS.ttlMs;
  const hit = cache.get(runner);
  if (hit && now - hit.at < ttl) return hit.report;
  const report = probeRunner(runner, options);
  cache.set(runner, { at: now, report });
  report.catch(() => cache.delete(runner));
  return report;
}

/** Every provider the office knows, detected (cached). */
export function detectRunners(options: DetectOptions = {}): Promise<RunnerReport[]> {
  return Promise.all(AGENT_PROVIDERS.map((r) => detectRunner(r, options)));
}

export function clearRunnerCache() { cache.clear(); }

/** A runner's capability by id, from a report. */
export const runnerCapability = (report: RunnerReport, id: RunnerCapability['id']) => report.capabilities.find((c) => c.id === id);

/**
 * Why per-run MCP or permissions can't be configured for this runner in this office, or undefined when an
 * adapter does it (Claude Code). The runner's detection still has to verify the flags before it is used.
 */
export function perRunRefusal(runner: AgentProvider | undefined, kind: 'mcp' | 'permissions'): string | undefined {
  if (!runner) return `the runner this card's worker is seated with is not known, and ${kind} is configured per runner: refused rather than guessed`;
  const spec = SPECS[runner];
  if (!spec) return `unknown runner ${runner}`;
  const flags = kind === 'mcp' ? spec.mcpFlags : spec.permissionFlags;
  return flags ? undefined : `${PROVIDER_META[runner].name}: ${kind === 'mcp' ? spec.mcpRefusal : spec.permissionRefusal}`;
}

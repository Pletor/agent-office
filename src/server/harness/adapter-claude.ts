// The runner adapters for per-run MCP servers and narrowing permissions (docs/harness.md "Runner adapters
// and capabilities"). Claude Code is the runner that takes both per run, cleanly: `--mcp-config <file>`
// with `--strict-mcp-config`, and `--settings <file>`, each verified in its own `--help` on this machine
// (capabilities.ts) before it is used. For any other runner both adapters refuse with the reason, before
// anything is written. Everything they write is a file under the run's scoped folder, created new
// (never over an existing one), named by the office (never by a profile), and removed by the rollback;
// the user's ~/.claude, a project's .mcp.json or any other global configuration is never touched.
// Secrets are never written: an MCP server's environment is a list of names, rendered as `${NAME}`.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerAdapter, type AdapterContext, type Capability, type HarnessAdapter } from './adapters.js';
import { detectRunner, perRunRefusal, runnerCapability, type RunnerReport } from './capabilities.js';
import { PROBE_TIMEOUT_MS, stdioProber, type McpProber } from './mcp-probe.js';
import { HarnessError, HarnessProfiles } from './profiles.js';
import { approvedCommands, checkName, claudeMcpConfig, mcpServers, narrowing, ScopedConfigError, type McpServer, type Narrowing } from './scoped-config.js';
import type { AgentProvider } from '../../shared/providers.js';

/** The files the adapters write, by name inside the run's scoped folder. */
export const SCOPED_FILES = { mcp: 'claude-mcp.json', permissions: 'claude-permissions.json', probeHome: 'probe-home' } as const;

/** What the adapters use from outside, swappable by tests: the runner detection and the MCP handshake probe. */
export const claudeAdapterDeps: { detect: (runner: AgentProvider) => Promise<RunnerReport>; probe: McpProber; probeTimeoutMs: number } = {
  detect: (runner) => detectRunner(runner),
  probe: stdioProber(),
  probeTimeoutMs: PROBE_TIMEOUT_MS,
};

type Ctx = Omit<AdapterContext, 'signal'>;
const refusal = (why: string, status = 422) => new HarnessError(why, status);

/** A file the office names inside the run's scoped folder, checked to resolve inside it. */
export function scopedFile(scopeDir: string, name: string): string {
  try { checkName('generated file', name, /^[a-z][a-z0-9._-]{0,63}$/); } catch (err) { throw refusal((err as Error).message); }
  const file = path.resolve(scopeDir, name);
  const rel = path.relative(path.resolve(scopeDir), file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) throw refusal(`generated file ${JSON.stringify(name)} would land outside the run's scoped folder`);
  return file;
}

/** Writes a new file, never over one that exists (a second prepare of a run, or a planted file, is refused). */
function writeNew(file: string, data: unknown, signal: AbortSignal) {
  if (signal.aborted) throw new Error('aborted: the step timed out');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
}
const removeFile = (file: string) => { rmSync(file, { force: true }); };

/** The administrator who saved the global `mcp.approved` slot, from the profile audit (newest save that names it). */
function approver(dataDir: string): string | undefined {
  try { return new HarnessProfiles(dataDir).audit(200).find((a) => a.level === 'global' && a.slots.includes('mcp.approved'))?.by || undefined; }
  catch { return undefined; }
}

/** The MCP servers this run declares, checked (throws a 422 with the reason on the first value refused). */
function declaredServers(ctx: Ctx): McpServer[] {
  try {
    const approved = approvedCommands(ctx.snapshot.slots);
    return mcpServers(ctx.snapshot, { commands: approved.commands, ...(approved.commands.length ? { by: approver(ctx.dataDir) } : {}) });
  } catch (err) {
    if (err instanceof ScopedConfigError) throw refusal('refused, nothing was written: ' + err.message);
    throw err;
  }
}
function declaredRules(ctx: Ctx): Narrowing {
  try { return narrowing(ctx.snapshot); }
  catch (err) {
    if (err instanceof ScopedConfigError) throw refusal('refused, nothing was written: ' + err.message);
    throw err;
  }
}

/** The runner's own detection must have verified the per-run flags, or nothing is configured. */
async function requireFlags(runner: AgentProvider, id: 'mcp.per-run' | 'permissions.per-run') {
  const report = await claudeAdapterDeps.detect(runner);
  const cap = runnerCapability(report, id);
  if (!cap || cap.state !== 'verified' || !cap.supported) throw refusal(`${id} is not verified for ${runner} on this machine: ${cap?.detail ?? 'not detected'}; refused rather than configured globally`);
  return cap;
}

/** Claude Code's --mcp-config schema as the office writes it: problems found, or none. */
export function claudeMcpProblems(parsed: unknown): string[] {
  const out: string[] = [];
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!obj(parsed) || Object.keys(parsed).join() !== 'mcpServers' || !obj(parsed.mcpServers)) return ['the file is not {"mcpServers": {...}}'];
  for (const [name, s] of Object.entries(parsed.mcpServers)) {
    if (!obj(s)) { out.push(`${name}: not an object`); continue; }
    if (s.type !== 'stdio') out.push(`${name}: type is not stdio`);
    if (typeof s.command !== 'string' || !s.command) out.push(`${name}: no command`);
    if (!Array.isArray(s.args) || !s.args.every((a) => typeof a === 'string')) out.push(`${name}: args is not a string array`);
    if (s.env !== undefined && (!obj(s.env) || !Object.entries(s.env).every(([k, v]) => v === '${' + k + '}'))) out.push(`${name}: env holds a value, not a \${NAME} reference`);
    for (const k of Object.keys(s)) if (!['type', 'command', 'args', 'env'].includes(k)) out.push(`${name}: unknown key ${k}`);
  }
  return out;
}

const probeWanted = (ctx: Ctx) => { const b = ctx.snapshot.slots['mcp.probe']?.binding; return !(b && 'value' in b && (b.value === false || b.value === 'false')); };

export const mcpAdapter: HarnessAdapter = {
  id: 'mcp',
  title: 'MCP servers for this run (Claude Code --mcp-config, strict)',
  unsupported: (c) => perRunRefusal(c?.runner, 'mcp'),
  capabilities(ctx) {
    let servers: McpServer[] = [];
    try { servers = declaredServers(ctx); } catch (err) { return [{ id: 'mcp.config', adapter: 'mcp', state: 'declared', detail: (err as Error).message }]; }
    return [
      { id: 'mcp.config', adapter: 'mcp', state: 'declared', detail: servers.length ? `a per-run MCP config with ${servers.length} server${servers.length === 1 ? '' : 's'}` : 'no MCP server declared by the profile' },
      ...servers.map((s): Capability => ({ id: 'mcp.server.' + s.name, adapter: 'mcp', state: 'declared', detail: `${s.command} ${s.args.join(' ')}`.trim() })),
    ];
  },
  plan(ctx) {
    const servers = declaredServers(ctx);
    return servers.length ? [{ id: 'mcp.config', detail: `write ${SCOPED_FILES.mcp} (${servers.map((s) => s.name).join(', ')}) for --mcp-config --strict-mcp-config`, writes: [scopedFile(ctx.scopeDir, SCOPED_FILES.mcp)] }] : [];
  },
  async prepare(ctx) {
    const why = perRunRefusal(ctx.runner, 'mcp');
    if (why) throw refusal(why);
    const servers = declaredServers(ctx);
    const file = scopedFile(ctx.scopeDir, SCOPED_FILES.mcp);
    const rollback = () => removeFile(file);
    if (!servers.length) return { ok: true, steps: [{ id: 'mcp.config', detail: 'no MCP server declared: nothing written', writes: [] }], rollback: () => undefined };
    const flags = await requireFlags(ctx.runner!, 'mcp.per-run');
    try { writeNew(file, claudeMcpConfig(servers), ctx.signal); } catch (err) { rollback(); throw err; }
    const approved = servers.filter((s) => s.approvedBy).map((s) => `${s.name} approved by ${s.approvedBy}`);
    return {
      ok: true,
      steps: [{ id: 'mcp.config', detail: `wrote ${SCOPED_FILES.mcp} with ${servers.map((s) => s.name).join(', ')} (${flags.evidence})${approved.length ? '; ' + approved.join(', ') : ''}`, writes: [file] }],
      launch: { runner: 'claude', mcpConfig: file, strictMcp: true },
      persist: { files: [SCOPED_FILES.mcp], servers: servers.map((s) => s.name) },
      rollback,
    };
  },
  async verify(ctx, result) {
    const servers = declaredServers(ctx);
    if (!servers.length) return { capabilities: [{ id: 'mcp.config', adapter: 'mcp', state: 'declared', detail: 'no MCP server declared by the profile' }] };
    const file = scopedFile(ctx.scopeDir, SCOPED_FILES.mcp);
    if (result.launch?.mcpConfig !== file) return 'the launch does not point at the run\'s MCP config';
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { return `${SCOPED_FILES.mcp} does not parse: ${(err as Error).message}`; }
    const problems = claudeMcpProblems(parsed);
    if (problems.length) return `${SCOPED_FILES.mcp} is not a Claude Code MCP config: ${problems.join('; ')}`;
    if (JSON.stringify(parsed) !== JSON.stringify(claudeMcpConfig(servers))) return `${SCOPED_FILES.mcp} is not what the profile declares (changed after it was written)`;
    const caps: Capability[] = [{ id: 'mcp.config', adapter: 'mcp', state: 'verified', detail: `${SCOPED_FILES.mcp} parses as Claude Code's MCP config; only its servers load (--strict-mcp-config)` }];
    const probe = probeWanted(ctx);
    for (const s of servers) {
      if (!probe) { caps.push({ id: 'mcp.server.' + s.name, adapter: 'mcp', state: 'prepared', detail: 'configured; the handshake probe is off (slot mcp.probe), so it is not verified' }); continue; }
      const r = await claudeAdapterDeps.probe(s, { cwd: ctx.scopeDir, home: path.join(ctx.scopeDir, SCOPED_FILES.probeHome), timeoutMs: claudeAdapterDeps.probeTimeoutMs, signal: ctx.signal });
      caps.push({ id: 'mcp.server.' + s.name, adapter: 'mcp', state: r.ok ? 'verified' : 'prepared', detail: r.ok ? r.detail : 'configured, not verified: ' + r.detail });
    }
    return { capabilities: caps };
  },
  async recover(ctx, persisted) {
    // Everything it wrote is in the scoped folder, which the rollback removes; files named in the state are removed here too (idempotent).
    const files = Array.isArray(persisted.files) ? persisted.files.filter((f): f is string => f === SCOPED_FILES.mcp) : [];
    for (const f of files) removeFile(scopedFile(ctx.scopeDir, f));
    return [];
  },
};

export const permissionsAdapter: HarnessAdapter = {
  id: 'permissions',
  title: 'Narrowing permissions for this run (Claude Code --settings: deny/ask only)',
  unsupported: (c) => perRunRefusal(c?.runner, 'permissions'),
  capabilities(ctx) {
    let rules: Narrowing;
    try { rules = declaredRules(ctx); } catch (err) { return [{ id: 'permissions.narrowing', adapter: 'permissions', state: 'declared', detail: (err as Error).message }]; }
    return [{ id: 'permissions.narrowing', adapter: 'permissions', state: 'declared', detail: rules.deny.length + rules.ask.length ? `deny ${rules.deny.length}, ask ${rules.ask.length} rule(s); nothing is ever allowed by a profile` : 'no deny/ask rules declared by the profile' }];
  },
  plan(ctx) {
    const rules = declaredRules(ctx);
    return rules.deny.length + rules.ask.length ? [{ id: 'permissions.narrowing', detail: `write ${SCOPED_FILES.permissions} (deny ${rules.deny.length}, ask ${rules.ask.length}), merged into the worker's --settings at launch`, writes: [scopedFile(ctx.scopeDir, SCOPED_FILES.permissions)] }] : [];
  },
  async prepare(ctx) {
    const why = perRunRefusal(ctx.runner, 'permissions');
    if (why) throw refusal(why);
    const rules = declaredRules(ctx);
    const file = scopedFile(ctx.scopeDir, SCOPED_FILES.permissions);
    const rollback = () => removeFile(file);
    if (!rules.deny.length && !rules.ask.length) return { ok: true, steps: [{ id: 'permissions.narrowing', detail: 'no deny/ask rules declared: nothing written', writes: [] }], rollback: () => undefined };
    const flags = await requireFlags(ctx.runner!, 'permissions.per-run');
    try { writeNew(file, { permissions: { deny: rules.deny, ask: rules.ask } }, ctx.signal); } catch (err) { rollback(); throw err; }
    return {
      ok: true,
      steps: [{ id: 'permissions.narrowing', detail: `wrote ${SCOPED_FILES.permissions}: deny ${rules.deny.length}, ask ${rules.ask.length} (${flags.evidence})`, writes: [file] }],
      launch: { runner: 'claude', permissions: file },
      persist: { files: [SCOPED_FILES.permissions] },
      rollback,
    };
  },
  async verify(ctx, result) {
    const rules = declaredRules(ctx);
    if (!rules.deny.length && !rules.ask.length) return { capabilities: [{ id: 'permissions.narrowing', adapter: 'permissions', state: 'declared', detail: 'no deny/ask rules declared by the profile' }] };
    const file = scopedFile(ctx.scopeDir, SCOPED_FILES.permissions);
    if (result.launch?.permissions !== file || !existsSync(file)) return 'the launch does not point at the run\'s permission rules';
    let parsed: any;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { return `${SCOPED_FILES.permissions} does not parse: ${(err as Error).message}`; }
    const keys = Object.keys(parsed ?? {}), inner = Object.keys(parsed?.permissions ?? {});
    if (keys.join() !== 'permissions' || inner.some((k) => k !== 'deny' && k !== 'ask')) return `${SCOPED_FILES.permissions} holds more than permissions.deny and permissions.ask: it could widen the runner's policy`;
    if (JSON.stringify(parsed) !== JSON.stringify({ permissions: { deny: rules.deny, ask: rules.ask } })) return `${SCOPED_FILES.permissions} is not what the profile declares (changed after it was written)`;
    return { capabilities: [{ id: 'permissions.narrowing', adapter: 'permissions', state: 'verified', detail: `deny ${rules.deny.length}, ask ${rules.ask.length} rule(s) in Claude Code's settings format, added to the office's settings at launch (nothing allowed, nothing removed)` }] };
  },
  async recover(ctx, persisted) {
    const files = Array.isArray(persisted.files) ? persisted.files.filter((f): f is string => f === SCOPED_FILES.permissions) : [];
    for (const f of files) removeFile(scopedFile(ctx.scopeDir, f));
    return [];
  },
};

registerAdapter(mcpAdapter);
registerAdapter(permissionsAdapter);


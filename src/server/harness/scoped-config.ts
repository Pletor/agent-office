// The strict reading of what a profile asks a runner to be configured with for one run (docs/harness.md
// "Runner adapters and capabilities"): MCP server declarations from the snapshot's `mcp` elements and
// narrowing-only permission rules from its `permissions` elements. Every value that would reach a command
// line, an environment or a file is checked against an allow-list here, before anything is written; a
// value that doesn't pass is refused with the reason and the whole run is refused, never "cleaned up".
// Secrets are never values here: an MCP server's environment is a list of variable NAMES, rendered as
// `${NAME}` references the runner resolves from its own environment or store.
import type { StoredSnapshot } from './snapshot.js';

export const SCOPED_LIMITS = { servers: 16, args: 64, argBytes: 512, envNames: 32, rules: 128, ruleBytes: 256, blockBytes: 64 * 1024, approved: 32 } as const;

/** Commands an MCP server may run without an administrator's approval: interpreters and package runners, by bare name. */
export const MCP_COMMANDS: readonly string[] = ['node', 'npx', 'uvx', 'python', 'python3', 'deno', 'bun'];
/** Names the office's own MCP servers have: a profile can't shadow them. */
export const RESERVED_SERVERS: readonly string[] = ['agent-office', 'rea'];

const SERVER_NAME = /^[a-z][a-z0-9_-]{0,47}$/;
const BARE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** An argument: printable ASCII without shell or cmd.exe metacharacters (no %, quotes, $, backslashes or whitespace). */
const ARG = /^[A-Za-z0-9@+=:,./_~-]+$/;
export const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** A Claude Code permission rule: `Tool` or `Tool(specifier)`, printable ASCII, no newline. */
const RULE = /^[A-Za-z][A-Za-z0-9_]{0,79}(\([\x20-\x27\x2a-\x7e]{1,200}\))?$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export class ScopedConfigError extends Error {}
const refuse = (where: string, why: string): never => { throw new ScopedConfigError(`${where}: ${why}`); };

/** A value shown in a refusal: bounded, control characters made visible, so a refusal can't forge log lines. */
export function shown(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return JSON.stringify(s.length > 60 ? s.slice(0, 60) + '…' : s);
}

/** A path-free, shell-free name (a server name, a file name the office generates). */
export function checkName(where: string, value: unknown, pattern = SERVER_NAME): string {
  if (typeof value !== 'string') return refuse(where, 'must be a string');
  if (WINDOWS_RESERVED.test(value)) return refuse(where, `${shown(value)} is a reserved device name on Windows`);
  if (!pattern.test(value)) return refuse(where, `${shown(value)} is not allowed (${pattern.source})`);
  return value;
}

export function checkArg(where: string, value: unknown): string {
  if (typeof value !== 'string' || !value) return refuse(where, 'must be a non-empty string');
  if (Buffer.byteLength(value) > SCOPED_LIMITS.argBytes) return refuse(where, `longer than ${SCOPED_LIMITS.argBytes} bytes`);
  if (!ARG.test(value)) return refuse(where, `${shown(value)} has a character outside [A-Za-z0-9@+=:,./_~-] (no shell metacharacters, quotes, $, spaces, backslashes, control or non-ASCII characters)`);
  if (value.split('/').includes('..')) return refuse(where, `${shown(value)} climbs out with ..`);
  return value;
}

/** One MCP server as the run's configuration has it: a command, its arguments as a vector, and env NAMES only. */
export interface McpServer { name: string; command: string; args: string[]; env: string[]; source: string; approvedBy?: string }
/** What an administrator approved beyond MCP_COMMANDS: exact command strings, and who approved them (from the profile audit). */
export interface Approval { commands: readonly string[]; by?: string }

/** The JSON object an element's text carries: the whole text, or its first ```json fenced block. */
export function jsonBlock(text: string): unknown | undefined {
  const trimmed = text.trim();
  const fenced = /```json[^\n]*\n([\s\S]*?)```/.exec(text);
  const body = trimmed.startsWith('{') ? trimmed : fenced?.[1];
  if (body === undefined) return undefined;
  if (Buffer.byteLength(body) > SCOPED_LIMITS.blockBytes) throw new ScopedConfigError(`the JSON block is over ${SCOPED_LIMITS.blockBytes / 1024} KiB`);
  try { return JSON.parse(body); } catch (err) { throw new ScopedConfigError('the JSON block does not parse: ' + (err as Error).message); }
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function onlyKeys(where: string, o: Record<string, unknown>, keys: readonly string[]) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) refuse(where, `unknown key ${shown(k)} (allowed: ${keys.join(', ')})`);
}

/** A command: a bare name on the allow-list, or exactly one an administrator approved. Never a shell. */
export function checkCommand(where: string, value: unknown, approval: Approval): { command: string; approvedBy?: string } {
  if (typeof value !== 'string' || !value) return refuse(where, 'must be a non-empty string');
  if (MCP_COMMANDS.includes(value)) return { command: value };
  if (approval.commands.includes(value)) {
    if (!approval.by) return refuse(where, `${shown(value)} is on the approved list, but no administrator's save of it is on record`);
    checkArg(where, value.replace(/^[A-Za-z]:\//, '/'));
    return { command: value, approvedBy: approval.by };
  }
  if (BARE_COMMAND.test(value) && !WINDOWS_RESERVED.test(value)) return refuse(where, `${shown(value)} is not on the allow-list (${MCP_COMMANDS.join(', ')}) nor approved by an administrator (global slot mcp.approved)`);
  return refuse(where, `${shown(value)} is not a bare command name; a path or a command line is used only when an administrator approved exactly it`);
}

/** The MCP servers the snapshot's `mcp` elements declare, all checked; throws ScopedConfigError on the first value refused. */
export function mcpServers(snapshot: Pick<StoredSnapshot, 'elements' | 'content'>, approval: Approval): McpServer[] {
  const out: McpServer[] = [];
  for (const el of snapshot.elements.filter((e) => e.category === 'mcp')) {
    const at = `mcp element ${el.id}`;
    let block: unknown;
    try { block = jsonBlock(snapshot.content[el.id] ?? ''); } catch (err) { refuse(at, (err as Error).message); }
    if (block === undefined) continue; // prose only: read by ID, nothing to configure
    if (!plain(block)) refuse(at, 'the JSON block must be an object');
    const root = block as Record<string, unknown>;
    onlyKeys(at, root, ['mcpServers']);
    if (!plain(root.mcpServers)) refuse(at, 'mcpServers must be an object of servers by name');
    for (const [name, raw] of Object.entries(root.mcpServers as Record<string, unknown>)) {
      const where = `${at} server ${shown(name)}`;
      checkName(where + ' name', name);
      if (RESERVED_SERVERS.includes(name)) refuse(where, 'this name is the office\'s own MCP server');
      if (out.some((s) => s.name === name)) refuse(where, 'declared twice');
      if (!plain(raw)) refuse(where, 'must be an object');
      const s = raw as Record<string, unknown>;
      onlyKeys(where, s, ['type', 'command', 'args', 'env']);
      if (s.type !== undefined && s.type !== 'stdio') refuse(where, `transport ${shown(s.type)} is not supported per run (stdio only)`);
      const { command, approvedBy } = checkCommand(where + ' command', s.command, approval);
      if (s.args !== undefined && !Array.isArray(s.args)) refuse(where, 'args must be an array of strings (an argument vector)');
      const args = ((s.args as unknown[] | undefined) ?? []).map((a, i) => checkArg(`${where} args[${i}]`, a));
      if (args.length > SCOPED_LIMITS.args) refuse(where, `more than ${SCOPED_LIMITS.args} args`);
      out.push({ name, command, args, env: envNames(where, s.env), source: el.id, ...(approvedBy ? { approvedBy } : {}) });
      if (out.length > SCOPED_LIMITS.servers) refuse(at, `more than ${SCOPED_LIMITS.servers} servers`);
    }
  }
  return out;
}

/** An env declaration as NAMES: `["TOKEN"]`, or `{"TOKEN": "${TOKEN}"}` (a reference to itself). A literal value is refused. */
function envNames(where: string, env: unknown): string[] {
  if (env === undefined) return [];
  const names = Array.isArray(env) ? env : plain(env) ? Object.keys(env) : refuse(where, 'env must be a list of variable names');
  if (plain(env)) for (const [k, v] of Object.entries(env)) if (v !== '${' + k + '}') refuse(`${where} env ${shown(k)}`, 'values are never written: reference the variable by name (["NAME"] or {"NAME": "${NAME}"}); the runner resolves it from its own environment or store');
  if (names.length > SCOPED_LIMITS.envNames) refuse(where, `more than ${SCOPED_LIMITS.envNames} env names`);
  const seen = new Set<string>();
  return names.map((n) => {
    if (typeof n !== 'string' || !ENV_NAME.test(n)) refuse(`${where} env`, `${shown(n)} is not a variable name (${ENV_NAME.source})`);
    if (seen.has(n as string)) refuse(`${where} env`, `${shown(n)} is named twice`);
    seen.add(n as string);
    return n as string;
  });
}

/** Claude Code's --mcp-config for these servers: env as `${NAME}` references, never values. */
export function claudeMcpConfig(servers: readonly McpServer[]) {
  return { mcpServers: Object.fromEntries(servers.map((s) => [s.name, { type: 'stdio', command: s.command, args: [...s.args], ...(s.env.length ? { env: Object.fromEntries(s.env.map((n) => [n, '${' + n + '}'])) } : {}) }])) };
}

/** Narrowing-only permission rules: what is denied, and what must be asked for. There is no allow list. */
export interface Narrowing { deny: string[]; ask: string[]; sources: string[] }

/** The deny/ask rules the snapshot's `permissions` elements carry; anything that would widen (allow, a mode, a bypass) is refused. */
export function narrowing(snapshot: Pick<StoredSnapshot, 'elements' | 'content'>): Narrowing {
  const out: Narrowing = { deny: [], ask: [], sources: [] };
  for (const el of snapshot.elements.filter((e) => e.category === 'permissions')) {
    const at = `permissions element ${el.id}`;
    let block: unknown;
    try { block = jsonBlock(snapshot.content[el.id] ?? ''); } catch (err) { refuse(at, (err as Error).message); }
    if (block === undefined) continue;
    if (!plain(block)) refuse(at, 'the JSON block must be an object');
    const root = block as Record<string, unknown>;
    onlyKeys(at, root, ['permissions']);
    if (!plain(root.permissions)) refuse(at, 'permissions must be an object with deny and/or ask');
    const p = root.permissions as Record<string, unknown>;
    for (const k of Object.keys(p)) if (k !== 'deny' && k !== 'ask') refuse(at, `${shown(k)} would widen or change the runner's policy; a profile may only narrow it (deny, ask)`);
    for (const list of ['deny', 'ask'] as const) {
      if (p[list] === undefined) continue;
      if (!Array.isArray(p[list])) refuse(at, `${list} must be an array of rules`);
      for (const [i, rule] of (p[list] as unknown[]).entries()) {
        if (typeof rule !== 'string' || Buffer.byteLength(rule) > SCOPED_LIMITS.ruleBytes || !RULE.test(rule)) refuse(`${at} ${list}[${i}]`, `${shown(rule)} is not a rule (Tool or Tool(specifier), printable ASCII, no parentheses or newlines inside)`);
        if (!out[list].includes(rule as string)) out[list].push(rule as string);
      }
    }
    out.sources.push(el.id);
  }
  if (out.deny.length + out.ask.length > SCOPED_LIMITS.rules) refuse('permissions', `more than ${SCOPED_LIMITS.rules} rules`);
  return out;
}

/** The approved list from the profile's `mcp.approved` slot: honoured only when set at the global level (administrator UI). */
export function approvedCommands(slots: StoredSnapshot['slots']): { commands: string[]; scope?: string } {
  const slot = slots['mcp.approved'];
  const value = slot?.binding && 'value' in slot.binding ? slot.binding.value : undefined;
  if (typeof value !== 'string' || !value.trim()) return { commands: [] };
  if (slot!.scope !== 'global') throw new ScopedConfigError(`slot mcp.approved is set at ${slot!.scope}; only the global level (administrator UI) may approve MCP commands`);
  const commands = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (commands.length > SCOPED_LIMITS.approved) throw new ScopedConfigError(`slot mcp.approved lists more than ${SCOPED_LIMITS.approved} commands`);
  return { commands, scope: 'global' };
}

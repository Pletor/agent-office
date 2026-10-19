// 🔬 REA (Reverse Engineer Anything) for the office's workers: an MCP server, `npx -y rea-agents@<pin> mcp`,
// that the providers which take MCP config (Claude Code, Codex, OpenCode) are handed next to the
// office's own, for the workers its setting covers. The office never installs or runs REA itself,
// and never touches anyone's global MCP config (no `rea-agents setup`): only its workers' own.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fillPrompt, type PromptId } from '../../shared/prompts.js';
import type { ReaMode, ReaState, WorkerInfo } from '../../shared/protocol.js';
import { ReaSetting, reaEnvMode, reaPackage } from './setting.js';

export { REA_PACKAGE, ReaSetting, isReaMode, reaEnvMode, reaPackage } from './setting.js';

/** The MCP server's name, which agents put before its tools (Claude Code: mcp__rea__…). */
export const REA_MCP_NAME = 'rea';

let setting: ReaSetting | undefined;

/** Reads the building's setting from `dataDir`, as the office starts; `onState` hears every change. */
export function configureRea(dataDir: string, onState?: (state: ReaState) => void, env: NodeJS.ProcessEnv = process.env): ReaSetting {
  setting = new ReaSetting(dataDir, onState, env);
  return setting;
}

/** The building's setting, once configureRea made it. */
export function reaSetting(): ReaSetting | undefined {
  return setting;
}

/** Which workers get REA now (off when the office hasn't read its setting: a test, say). */
export function reaMode(): ReaMode {
  return setting?.mode ?? reaEnvMode() ?? 'off';
}

// --- Who it's for ---------------------------------------------------------------------------------

/** The workers seated for Opora: a card's developer or designer, and the planner planning onto the canvas. */
const forOpora = new Set<string>();
/** Above 0 while seatForOpora seats one, whose first launch happens before the seat call returns. */
let seating = 0;

/** Seats a worker for Opora (`seat` is the floor's or the planning room's): REA's 'opora' setting covers it. */
export function seatForOpora<T>(seat: () => T): T {
  seating++;
  try {
    const seated = seat();
    // The worker, or (a string) why it couldn't be seated.
    const id: unknown = seated && typeof seated === 'object' ? (seated as { id?: unknown }).id : undefined;
    if (typeof id === 'string') forOpora.add(id);
    return seated;
  } finally {
    seating--;
  }
}

/** A worker seated for Opora before the office restarted (the bridge and the planning room remember theirs). */
export function markForOpora(workerId: string) {
  forOpora.add(workerId);
}

export function forgetForOpora(workerId: string) {
  forOpora.delete(workerId);
}

/** Whether this worker gets REA's MCP server on this run: the setting says all, or it says opora and the worker is Opora's. */
export function reaFor(info: Pick<WorkerInfo, 'id'>): boolean {
  if (seating) forOpora.add(info.id);
  const mode = reaMode();
  return mode === 'all' || (mode === 'opora' && forOpora.has(info.id));
}

// --- What each provider is handed -----------------------------------------------------------------

/** npx, through cmd on Windows, where an MCP client can't start npx.cmd by itself. */
export function reaCommand(pkg = reaPackage(), platform: NodeJS.Platform = process.platform): [command: string, ...args: string[]] {
  const npx = ['npx', '-y', pkg, 'mcp'];
  return platform === 'win32' ? ['cmd', '/c', ...npx] : (npx as [string, ...string[]]);
}

/** Claude Code's --mcp-config with REA in it, written once to `dataDir` next to the office's own (agent-office-mcp.json). */
export function writeReaClaudeConfig(dataDir: string): string {
  const [command, ...args] = reaCommand();
  const file = path.join(dataDir, 'rea-mcp.json');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ mcpServers: { [REA_MCP_NAME]: { type: 'stdio', command, args } } }, null, 2), { mode: 0o600 });
  return file;
}

/** Codex's -c overrides for REA (a first `npx` download can take longer than Codex's 10 s start-up wait). */
export function reaCodexArgs(): string[] {
  const [command, ...args] = reaCommand();
  const key = `mcp_servers.${REA_MCP_NAME}`;
  return ['-c', `${key}.command=${JSON.stringify(command)}`, '-c', `${key}.args=${JSON.stringify(args)}`, '-c', `${key}.startup_timeout_sec=120`];
}

/** OpenCode's `mcp` config entry for REA. */
export function reaOpenCode(): Record<string, unknown> {
  return { [REA_MCP_NAME]: { type: 'local', command: reaCommand(), enabled: true } };
}

// --- What the worker is told ----------------------------------------------------------------------

/**
 * `brief` with REA's guidance (the 🔬 REA prompt) after it, for a worker REA is on for; `brief` as it
 * is while REA is off. `prompt` is the office's prompt text by id (rewritten in ⚙️ Settings, or the default).
 */
export function withReaBrief(brief: string, prompt: (id: PromptId) => string, mode: ReaMode = reaMode()): string {
  if (mode === 'off') return brief;
  const rea = fillPrompt(prompt('opora.rea'), { server: REA_MCP_NAME, package: reaPackage() });
  return rea ? `${brief}\n\n${rea}` : brief;
}

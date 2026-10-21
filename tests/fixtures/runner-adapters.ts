// Shared setup for the runner adapter tests (tests/harness-adapter-*.test.ts): a checkout whose profile
// binds `mcp` and `permissions` elements and names the adapters, Claude Code's detection stubbed to what
// this machine's `claude --help` shows (the real probe has its own test), and a stub MCP stdio server.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessProfiles } from '../../src/server/harness/profiles.js';
import { HarnessLibrary, harnessSources } from '../../src/server/harness/catalog.js';
import { HarnessRegistry } from '../../src/server/harness/registry.js';
import { claudeAdapterDeps } from '../../src/server/harness/adapter-claude.js';
import { probeRunner, type Spawner } from '../../src/server/harness/capabilities.js';
import type { HarnessLayer } from '../../src/shared/harness-cascade.js';

export const place = { project: 'p1', workspace: 'draft' };
export const CLAUDE_HELP = '  --mcp-config <configs...>  Load MCP servers\n  --settings <file-or-json>  Settings\n  --strict-mcp-config  Only use MCP servers from --mcp-config\n';

/** A node MCP server answering `initialize` over stdio (and nothing else), written into `dir`. */
export function stubMcpServer(dir: string, behaviour: 'answer' | 'silent' | 'exit' = 'answer'): string {
  const file = path.join(dir, `stub-mcp-${behaviour}.cjs`);
  const body = behaviour === 'exit' ? 'process.exit(3);' : behaviour === 'silent' ? 'process.stdin.resume();' : `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  for (const line of buf.split('\\n').slice(0, -1)) {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub-mcp', version: '1' } } }) + '\\n');
  }
  buf = buf.slice(buf.lastIndexOf('\\n') + 1);
});`;
  writeFileSync(file, body);
  return file.replace(/\\/g, '/');
}

export const fence = (o: unknown) => 'Declared for this task.\n\n```json\n' + JSON.stringify(o, null, 2) + '\n```\n';

/** Stubs Claude Code's detection (as `claude --help` shows here) unless `help` says otherwise; returns the restore. */
export function stubDetection(help = CLAUDE_HELP): () => void {
  const before = claudeAdapterDeps.detect;
  const spawner: Spawner = async (_f, args) => ({ code: 0, stdout: args[0] === '--version' ? '2.1.304 (Claude Code)' : help, stderr: '' });
  claudeAdapterDeps.detect = (runner) => probeRunner(runner, { spawner, locator: () => '/stub/bin/' + runner });
  return () => { claudeAdapterDeps.detect = before; };
}

/** A checkout (also the data dir) with the given mcp/permissions element texts bound at the repository, and `adapters` named. */
export async function checkout(t: { after(fn: () => void): void }, o: { mcp?: Record<string, string>; permissions?: Record<string, string>; adapters?: string; global?: HarnessLayer; by?: string }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-adapters-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files: [string, string, string][] = [];
  for (const [kind, texts] of [['mcp', o.mcp ?? {}], ['permissions', o.permissions ?? {}]] as const) {
    mkdirSync(path.join(dir, '.harness', kind), { recursive: true });
    for (const [name, text] of Object.entries(texts)) { writeFileSync(path.join(dir, '.harness', kind, name + '.md'), text); files.push([kind, name, `${kind}/${name}.md`]); }
  }
  const catalog = await new HarnessLibrary(harnessSources(dir, false), new HarnessRegistry(dir)).list();
  const layer: HarnessLayer = { adapters: { value: o.adapters ?? 'mcp,permissions' } };
  for (const [kind, name, rel] of files) layer[`${kind}.${name}`] = { resource: catalog.entries.find((e) => e.path === rel)!.id };
  const profiles = new HarnessProfiles(dir);
  await profiles.save(dir, '', 'global', o.global ?? { language: { value: 'en' } }, 0, o.by ?? 'admin:alice');
  await profiles.save(dir, '', 'repository', layer, 1, 'admin:alice');
  return { dir, profiles };
}

/** Every file under `dir` (relative) with its content's digest. */
export function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    let names: string[] = [];
    try { names = readdirSync(at); } catch { return; }
    for (const name of names) {
      const file = path.join(at, name);
      if (statSync(file).isDirectory()) walk(file);
      else out[path.relative(dir, file)] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

/** Files under `dir` whose bytes contain `needle`. */
export function filesContaining(dir: string, needle: string): string[] {
  return Object.keys(tree(dir)).filter((rel) => readFileSync(path.join(dir, rel)).includes(needle));
}

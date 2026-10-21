// Runner capability detection (src/server/harness/capabilities.ts, docs/harness.md "Runner adapters and
// capabilities"): found by code from the real environment, every probe an argument vector with a timeout
// and a scrubbed environment, a batch launcher never run, results cached briefly. A stubbed spawner and
// locator stand in for the machine; one test probes the real Claude Code when it is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearRunnerCache, detectRunner, detectRunners, helpLists, perRunRefusal, probeEnv, probeRunner, runnerCapability, type Spawner } from '../src/server/harness/capabilities.js';
import { AGENT_PROVIDERS } from '../src/shared/providers.js';

const CLAUDE_HELP = `Usage: claude [options]
  --mcp-config <configs...>             Load MCP servers from JSON files
  --settings <file-or-json>             Path to a settings JSON file
  --strict-mcp-config                   Only use MCP servers from --mcp-config
`;

function stub(answers: Record<string, { code: number | null; stdout?: string; error?: string }>) {
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number }[] = [];
  const spawner: Spawner = async (file, args, { timeoutMs, env }) => {
    calls.push({ file, args: [...args], env, timeoutMs });
    const a = answers[args.join(' ')] ?? { code: 1 };
    return { code: a.code, stdout: a.stdout ?? '', stderr: '', ...(a.error ? { error: a.error } : {}) };
  };
  return { spawner, calls };
}

test('Claude Code on PATH with --mcp-config, --strict-mcp-config and --settings in its help: present, version and both per-run capabilities verified', async () => {
  const { spawner, calls } = stub({ '--version': { code: 0, stdout: '2.1.304 (Claude Code)\n' }, '--help': { code: 0, stdout: CLAUDE_HELP } });
  const r = await probeRunner('claude', { spawner, locator: (b) => (b === 'claude' ? '/opt/bin/claude' : undefined), env: { PATH: '/opt/bin', ANTHROPIC_API_KEY: 'sk-ant-secret', GITHUB_TOKEN: 'ghp_x' } });
  assert.equal(r.path, '/opt/bin/claude');
  assert.equal(r.version, '2.1.304 (Claude Code)');
  for (const id of ['runner.present', 'runner.version', 'mcp.per-run', 'permissions.per-run'] as const) assert.equal(runnerCapability(r, id)?.state, 'verified', id);
  assert.equal(runnerCapability(r, 'hooks.lifecycle')?.state, 'declared', 'a hook is verified only when one fires (H15)');
  assert.match(runnerCapability(r, 'mcp.per-run')!.evidence, /--mcp-config, --strict-mcp-config/);
  // Argument vectors, bounded, and an environment without the office's secrets.
  assert.deepEqual(calls.map((c) => [c.file, c.args]), [['/opt/bin/claude', ['--version']], ['/opt/bin/claude', ['--help']]]);
  for (const c of calls) {
    assert.ok(c.timeoutMs > 0 && c.timeoutMs <= 5000);
    assert.equal(c.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(c.env.GITHUB_TOKEN, undefined);
    assert.equal(c.env.PATH, '/opt/bin');
  }
});

test('a Claude Code whose help lacks --strict-mcp-config is refused per-run MCP rather than configured globally', async () => {
  const { spawner } = stub({ '--version': { code: 0, stdout: '1.0.0' }, '--help': { code: 0, stdout: '  --mcp-config <configs...>\n  --settings <file>\n' } });
  const r = await probeRunner('claude', { spawner, locator: () => '/x/claude' });
  const mcp = runnerCapability(r, 'mcp.per-run')!;
  assert.equal(mcp.state, 'declared');
  assert.equal(mcp.supported, false);
  assert.match(mcp.detail, /does not list --strict-mcp-config.*refused rather than configured globally/);
  assert.equal(runnerCapability(r, 'permissions.per-run')?.state, 'verified');
});

test('a runner that is not installed is reported absent, nothing is spawned', async () => {
  const { spawner, calls } = stub({});
  const r = await probeRunner('claude', { spawner, locator: () => undefined });
  assert.equal(calls.length, 0);
  assert.equal(runnerCapability(r, 'runner.present')?.supported, false);
  assert.match(runnerCapability(r, 'mcp.per-run')!.detail, /not on PATH/);
});

test('a Windows batch launcher (codex.cmd) is located but never run: only a shell could start it', async () => {
  const { spawner, calls } = stub({});
  const r = await probeRunner('codex', { spawner, locator: () => 'C:\\npm\\codex.cmd' });
  assert.equal(calls.length, 0);
  assert.equal(runnerCapability(r, 'runner.present')?.state, 'verified');
  assert.match(runnerCapability(r, 'runner.version')!.detail, /batch launcher only a shell can start/);
  assert.equal(runnerCapability(r, 'mcp.per-run')?.supported, false);
});

test('Codex answers its version but per-run MCP and permissions are refused with the precise reason; its help is not even asked', async () => {
  const { spawner, calls } = stub({ '--version': { code: 0, stdout: 'codex-cli 0.163.0' } });
  const r = await probeRunner('codex', { spawner, locator: () => '/usr/bin/codex' });
  assert.equal(r.version, 'codex-cli 0.163.0');
  assert.deepEqual(calls.map((c) => c.args), [['--version']]);
  assert.match(runnerCapability(r, 'mcp.per-run')!.detail, /-c mcp_servers.*no adapter in this office writes its per-run configuration yet/);
  assert.match(perRunRefusal('codex', 'mcp')!, /^Codex: /);
  assert.equal(perRunRefusal('claude', 'mcp'), undefined);
  assert.match(perRunRefusal(undefined, 'permissions')!, /not known/);
});

test('a version probe that times out or prints no version leaves the version declared, never verified', async () => {
  const { spawner } = stub({ '--version': { code: null, error: 'timed out after 5000 ms' }, '--help': { code: 0, stdout: CLAUDE_HELP } });
  const r = await probeRunner('claude', { spawner, locator: () => '/x/claude' });
  assert.equal(runnerCapability(r, 'runner.version')?.state, 'declared');
  assert.match(runnerCapability(r, 'runner.version')!.detail, /timed out/);
});

test('every provider gets a report; a custom --agent has nothing probed', async () => {
  clearRunnerCache();
  const { spawner, calls } = stub({});
  const all = await detectRunners({ spawner, locator: () => undefined });
  assert.deepEqual(all.map((r) => r.runner), [...AGENT_PROVIDERS]);
  const custom = all.find((r) => r.runner === 'custom')!;
  assert.match(runnerCapability(custom, 'runner.present')!.detail, /no known executable/);
  assert.equal(calls.length, 0);
  clearRunnerCache();
});

test('detection is cached for a short time, then probed again', async () => {
  clearRunnerCache();
  const { spawner, calls } = stub({ '--version': { code: 0, stdout: '2.0.0' }, '--help': { code: 0, stdout: CLAUDE_HELP } });
  let now = 1000;
  const o = { spawner, locator: () => '/x/claude', now: () => now, ttlMs: 60_000 };
  await detectRunner('claude', o);
  await detectRunner('claude', o);
  assert.equal(calls.length, 2, 'the second call came from the cache');
  now += 60_001;
  await detectRunner('claude', o);
  assert.equal(calls.length, 4);
  clearRunnerCache();
});

test('help parsing matches a flag as an option, not inside another flag', () => {
  assert.equal(helpLists('  --strict-mcp-config   Only', '--strict-mcp-config'), true);
  assert.equal(helpLists('  --mcp-config-extra <x>', '--mcp-config'), false);
  assert.equal(helpLists('  --settings <file-or-json>', '--settings'), true);
  assert.deepEqual(Object.keys(probeEnv({ PATH: '/b', OPENAI_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 's', HOME: '/h' })).sort(), ['HOME', 'NO_COLOR', 'PATH']);
});

test('the real Claude Code on this machine documents its per-run flags (read-only --version/--help)', async (t) => {
  clearRunnerCache();
  const r = await probeRunner('claude');
  if (runnerCapability(r, 'runner.present')?.state !== 'verified') return t.skip('Claude Code is not on PATH here');
  if (r.path && /\.(cmd|bat)$/i.test(r.path)) return t.skip('Claude Code is a batch launcher here');
  assert.equal(runnerCapability(r, 'mcp.per-run')?.state, 'verified', JSON.stringify(r.capabilities));
  assert.equal(runnerCapability(r, 'permissions.per-run')?.state, 'verified');
});

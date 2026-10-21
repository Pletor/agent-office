// The runner adapters (src/server/harness/adapter-claude.ts, launch-scope.ts, docs/harness.md "Runner
// adapters and capabilities"): per-run MCP and narrowing permissions for Claude Code, written only under
// the run's scoped folder, handed to that run's worker only, verified before they are offered, rolled
// back whole on any failure; secrets never written anywhere; other runners refused with the reason; the
// user's global runner configuration never touched. Capability states through the fake adapter too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeAdapter, registerAdapter, type HarnessAdapter } from '../src/server/harness/adapters.js';
import { claudeAdapterDeps, SCOPED_FILES } from '../src/server/harness/adapter-claude.js';
import { clearRunnerCache } from '../src/server/harness/capabilities.js';
import { stdioProber } from '../src/server/harness/mcp-probe.js';
import { finishRollback, prepareRun, preparePlan, PrepareError } from '../src/server/harness/prepare.js';
import { listRecords, readRecord, scopeDir } from '../src/server/harness/prepare-store.js';
import { bindRunLaunches, mergeClaudeSettings, runLaunchFor, seatWithRun } from '../src/server/harness/launch-scope.js';
import { claude } from '../src/server/providers/claude.js';
import { checkout, fence, filesContaining, place, stubDetection, stubMcpServer, tree } from './fixtures/runner-adapters.js';

const ctx = (dir: string, card = 'c1', runner: 'claude' | 'codex' | null = 'claude') => ({ dataDir: dir, repo: dir, place, card, nodes: [], local: false, ...(runner ? { runner } : {}) });
const opts = { retry: { max: 0 }, timeoutMs: 20_000 };

/** Claude Code's launch for a worker, as the office builds it (the office's hook settings file given). */
function launchClaude(dir: string, id: string, officeSettings: string) {
  const info = { id, provider: 'claude' } as never;
  return claude.launch({ h: { info } as never, args: [], prompt: 'go', cwd: dir, setup: { settings: officeSettings, dir } });
}
function officeSettingsFile(dir: string) {
  const file = path.join(dir, 'claude-hooks.json');
  writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] }, permissions: { allow: ['mcp__agent-office__list_workers'] } }));
  return file;
}

test('happy path: a stub MCP server and narrowing rules are written under the run scope, verified by a real handshake, offered as verified and handed to that worker only', async (t) => {
  t.after(stubDetection());
  const stubDir = mkdtempSync(path.join(tmpdir(), 'office-stub-mcp-'));
  t.after(() => rmSync(stubDir, { recursive: true, force: true }));
  const server = stubMcpServer(stubDir);
  const f = await checkout(t, {
    mcp: { stub: fence({ mcpServers: { stub: { command: 'node', args: [server], env: ['STUB_TOKEN'] } } }) },
    permissions: { narrow: fence({ permissions: { deny: ['Bash(git push:*)', 'WebFetch'], ask: ['Edit(./docs/**)'] } }) },
  });
  const plan = await preparePlan(ctx(f.dir));
  assert.equal(plan.ok, true, plan.reason);
  assert.deepEqual(plan.adapters, ['context', 'mcp', 'permissions']);
  assert.ok(plan.requirements.every((c) => c.state === 'declared'));
  assert.equal(existsSync(path.join(f.dir, 'harness-prepared')), false, 'the dry run wrote nothing');

  const run = await prepareRun(ctx(f.dir), opts);
  const scope = scopeDir(f.dir, run.runId);
  const mcpFile = path.join(scope, SCOPED_FILES.mcp), permFile = path.join(scope, SCOPED_FILES.permissions);
  assert.deepEqual(JSON.parse(readFileSync(mcpFile, 'utf8')), { mcpServers: { stub: { type: 'stdio', command: 'node', args: [server], env: { STUB_TOKEN: '${STUB_TOKEN}' } } } });
  assert.deepEqual(JSON.parse(readFileSync(permFile, 'utf8')), { permissions: { deny: ['Bash(git push:*)', 'WebFetch'], ask: ['Edit(./docs/**)'] } });
  const states = Object.fromEntries(run.capabilities.map((c) => [c.id, c.state]));
  assert.equal(states['mcp.config'], 'verified');
  assert.equal(states['mcp.server.stub'], 'verified', JSON.stringify(run.capabilities));
  assert.equal(states['permissions.narrowing'], 'verified');
  assert.match(run.capabilities.find((c) => c.id === 'mcp.server.stub')!.detail, /answered initialize .*stub-mcp/);
  assert.match(run.context, /Available \(verified\):[\s\S]*mcp\.server\.stub/);
  assert.deepEqual(run.launch, { runId: run.runId, runner: 'claude', mcpConfig: mcpFile, strictMcp: true, permissions: permFile });
  assert.ok(!existsSync(path.join(scope, 'probe-home', '.claude')), 'the probe ran with its own home');

  // The worker seated for this run gets the scoped files; the office's hooks and allow list stay exactly as they were.
  await run.claimed({ token: 't', agent: 'a' });
  bindRunLaunches(f.dir);
  const office = officeSettingsFile(f.dir);
  const plan1 = seatWithRun(run.runId, () => launchClaude(f.dir, 'w1', office));
  await run.seated('w1');
  const a = plan1.args;
  assert.equal(a[0], '--strict-mcp-config');
  assert.ok(a.includes(mcpFile), a.join(' '));
  const settings = a[a.indexOf('--settings') + 1];
  assert.equal(path.dirname(settings), scope, 'the merged settings live in the run scope');
  const merged = JSON.parse(readFileSync(settings, 'utf8'));
  assert.deepEqual(merged.hooks, JSON.parse(readFileSync(office, 'utf8')).hooks);
  assert.deepEqual(merged.permissions, { allow: ['mcp__agent-office__list_workers'], deny: ['Bash(git push:*)', 'WebFetch'], ask: ['Edit(./docs/**)'] });
  for (const flag of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode', '--allowedTools', '--allowed-tools']) assert.ok(!a.includes(flag), flag);
  assert.equal(plan1.finishEnv, undefined);

  // Another worker gets nothing of it; this one gets it again after a restart (found by its seated record).
  const other = launchClaude(f.dir, 'w2', office).args;
  assert.ok(!other.includes('--strict-mcp-config') && !other.includes(mcpFile));
  assert.equal(other[other.indexOf('--settings') + 1], office);
  bindRunLaunches(f.dir);
  assert.equal(runLaunchFor({ id: 'w1' })?.runId, run.runId);
  assert.ok(launchClaude(f.dir, 'w1', office).args.includes(mcpFile));
});

test('fake adapter: declared at plan, prepared after prepare, verified only where its verify proved it; the contract offers only the verified one', async (t) => {
  t.after(stubDetection());
  const fake = fakeAdapter({ id: 'probe-fake', capabilities: ['fake.a', 'fake.b', 'fake.c'], verifyStates: { 'fake.a': 'verified', 'fake.b': 'prepared', 'fake.c': 'declared' } });
  t.after(registerAdapter(fake.adapter));
  const f = await checkout(t, { adapters: 'probe-fake' });
  const plan = await preparePlan(ctx(f.dir));
  assert.deepEqual(plan.requirements.filter((c) => c.adapter === 'probe-fake').map((c) => c.state), ['declared', 'declared', 'declared']);
  const run = await prepareRun(ctx(f.dir), opts);
  const mine = run.capabilities.filter((c) => c.adapter === 'probe-fake');
  assert.deepEqual(mine.map((c) => [c.id, c.state]), [['fake.a', 'verified'], ['fake.b', 'prepared'], ['fake.c', 'declared']]);
  const [available, unavailable] = run.context.split('- Not available');
  assert.match(available, /fake\.a/);
  assert.doesNotMatch(available, /fake\.b|fake\.c/);
  assert.match(unavailable, /fake\.b \(probe-fake\) · prepared/);
  assert.match(unavailable, /fake\.c \(probe-fake\) · declared/);
  assert.deepEqual(readRecord(f.dir, run.runId)!.capabilities.filter((c) => c.adapter === 'probe-fake').map((c) => c.state), ['verified', 'prepared', 'declared']);
});

test('recover: an adapter\'s persisted state survives in the record and is handed to its recover hook when the run is rolled back after a restart', async (t) => {
  const fake = fakeAdapter({ id: 'recover-fake', persist: { outside: 'thing-1' } });
  t.after(registerAdapter(fake.adapter));
  const f = await checkout(t, { adapters: 'recover-fake' });
  const run = await prepareRun(ctx(f.dir), opts);
  assert.deepEqual(readRecord(f.dir, run.runId)!.adapterState, { 'recover-fake': { outside: 'thing-1' } });
  // A restarted office has no closure: only the record. finishRollback is what its recovery calls.
  await finishRollback(f.dir, run.runId, 'the office stopped');
  assert.deepEqual(fake.recovered, [{ outside: 'thing-1' }]);
  assert.equal(readRecord(f.dir, run.runId)!.state, 'rolledBack');
  assert.equal(existsSync(scopeDir(f.dir, run.runId)), false);
});

test('a handshake that does not answer leaves the server prepared, not verified, and says why', async (t) => {
  t.after(stubDetection());
  const stubDir = mkdtempSync(path.join(tmpdir(), 'office-stub-mcp-'));
  t.after(() => rmSync(stubDir, { recursive: true, force: true }));
  const before = claudeAdapterDeps.probeTimeoutMs;
  claudeAdapterDeps.probeTimeoutMs = 800;
  t.after(() => { claudeAdapterDeps.probeTimeoutMs = before; });
  const f = await checkout(t, { mcp: { quiet: fence({ mcpServers: { quiet: { command: 'node', args: [stubMcpServer(stubDir, 'silent')] }, gone: { command: 'node', args: [stubMcpServer(stubDir, 'exit')] } } }) }, adapters: 'mcp' });
  const run = await prepareRun(ctx(f.dir), opts);
  const by = Object.fromEntries(run.capabilities.map((c) => [c.id, c]));
  assert.equal(by['mcp.config'].state, 'verified');
  assert.equal(by['mcp.server.quiet'].state, 'prepared');
  assert.match(by['mcp.server.quiet'].detail, /no answer to initialize within 800 ms/);
  assert.equal(by['mcp.server.gone'].state, 'prepared');
  assert.match(by['mcp.server.gone'].detail, /exited \(3\) before answering/);
  assert.match(run.context, /Not available[\s\S]*mcp\.server\.quiet \(mcp\) · prepared/);
});

test('a runner without per-run support is refused with the precise reason before anything is written', async (t) => {
  const f = await checkout(t, { mcp: { a: fence({ mcpServers: { a: { command: 'node', args: ['x.js'] } } }) } });
  await assert.rejects(prepareRun(ctx(f.dir, 'c1', 'codex'), opts), (err: Error) => {
    assert.match(err.message, /Unsupported adapters, refused before anything was prepared: mcp \(Codex: Codex takes MCP servers per run only as `-c mcp_servers\.\*` TOML overrides[^)]*\); permissions \(Codex: /);
    return true;
  });
  const [r] = listRecords(f.dir).records;
  assert.equal(r.state, 'rolledBack');
  assert.equal(r.error?.step, 'availability');
  assert.equal(existsSync(scopeDir(f.dir, r.runId)), false);
  const plan = await preparePlan(ctx(f.dir, 'c2', null));
  assert.match(plan.refused.map((x) => x.reason).join(' '), /not known.*refused rather than guessed/);
});

test('a Claude Code whose --help does not list the per-run flags is refused, nothing written', async (t) => {
  t.after(stubDetection('  --mcp-config <configs...>\n'));
  clearRunnerCache();
  const f = await checkout(t, { mcp: { a: fence({ mcpServers: { a: { command: 'node', args: ['x.js'] } } }) }, adapters: 'mcp' });
  await assert.rejects(prepareRun(ctx(f.dir), opts), /mcp\.per-run is not verified for claude on this machine: .*--strict-mcp-config.*refused rather than configured globally/);
  const [r] = listRecords(f.dir).records;
  assert.equal(r.state, 'rolledBack');
  assert.equal(existsSync(scopeDir(f.dir, r.runId)), false);
});

/** An adapter registered after mcp/permissions that breaks the run at the step given, to prove the configuration is rolled back. */
function breaker(id: string, at: 'prepare' | 'verify' | 'tamper'): HarnessAdapter {
  return {
    id, title: 'breaks the run', capabilities: () => [], plan: () => [],
    async prepare(c) {
      if (at === 'prepare') return { ok: false, steps: [], reason: 'broken on purpose', rollback: () => undefined };
      if (at === 'tamper') writeFileSync(path.join(c.scopeDir, SCOPED_FILES.mcp), JSON.stringify({ mcpServers: { a: { type: 'stdio', command: 'node', args: ['x.js'], env: { A: 'leaked-value' } } } }));
      return { ok: true, steps: [], rollback: () => undefined };
    },
    async verify() { return at === 'verify' ? 'broken on purpose' : undefined; },
  };
}

for (const at of ['prepare', 'verify', 'tamper'] as const) {
  test(`rollback of configuration: a failure at ${at} leaves no scoped file and no launch for any worker`, async (t) => {
    t.after(stubDetection());
    t.after(registerAdapter(breaker('breaker-' + at, at)));
    const f = await checkout(t, {
      mcp: { a: fence({ mcpServers: { a: { command: 'node', args: ['x.js'] } } }) },
      permissions: { p: fence({ permissions: { deny: ['WebFetch'] } }) },
      adapters: 'mcp,permissions,breaker-' + at,
    });
    const before = claudeAdapterDeps.probe;
    claudeAdapterDeps.probe = async () => ({ ok: false, detail: 'not probed in this test' });
    t.after(() => { claudeAdapterDeps.probe = before; });
    await assert.rejects(prepareRun(ctx(f.dir), opts), PrepareError);
    const [r] = listRecords(f.dir).records;
    assert.equal(r.state, 'rolledBack', JSON.stringify(r.history));
    assert.deepEqual(r.rollback?.errors, []);
    assert.equal(existsSync(scopeDir(f.dir, r.runId)), false, 'no scoped file is left');
    bindRunLaunches(f.dir);
    const office = officeSettingsFile(f.dir);
    const args = seatWithRun(r.runId, () => launchClaude(f.dir, 'w-' + at, office)).args;
    assert.ok(!args.includes('--strict-mcp-config'), 'no launch args for a run that was rolled back');
    assert.equal(args[args.indexOf('--settings') + 1], office);
    if (at === 'tamper') assert.match(r.error?.reason ?? '', /did not verify: .*(holds a value|not what the profile declares)/);
  });
}

test('auth isolation: a secret in the office environment and in the runner\'s native store never reaches the scoped config, record, plan, snapshot, contract or the home it was in', async (t) => {
  t.after(stubDetection());
  const SECRET = 'sk-live-0ff1ce-' + Math.random().toString(36).slice(2) + '-SECRETVALUE';
  const home = mkdtempSync(path.join(tmpdir(), 'office-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }));
  writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { mine: { command: 'node', args: ['mine.js'] } } }));
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "x"\n');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, OFFICE_TEST_TOKEN: process.env.OFFICE_TEST_TOKEN };
  Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), OFFICE_TEST_TOKEN: SECRET });
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const homeBefore = tree(home);
  const stubDir = mkdtempSync(path.join(tmpdir(), 'office-stub-mcp-'));
  t.after(() => rmSync(stubDir, { recursive: true, force: true }));
  claudeAdapterDeps.probe = stdioProber();
  const f = await checkout(t, {
    mcp: { gh: fence({ mcpServers: { gh: { command: 'node', args: [stubMcpServer(stubDir)], env: { OFFICE_TEST_TOKEN: '${OFFICE_TEST_TOKEN}' } } } }) },
    permissions: { p: fence({ permissions: { deny: ['Read(./.env)'] } }) },
  });
  const plan = await preparePlan(ctx(f.dir));
  const run = await prepareRun(ctx(f.dir), opts);
  await run.claimed({ token: 't', agent: 'a' });
  bindRunLaunches(f.dir);
  const launched = seatWithRun(run.runId, () => launchClaude(f.dir, 'w-auth', officeSettingsFile(f.dir)));
  await run.seated('w-auth');
  assert.equal(run.capabilities.find((c) => c.id === 'mcp.server.gh')?.state, 'verified', 'the probe answered without the secret');
  assert.deepEqual(filesContaining(f.dir, SECRET), [], 'no file under the data dir (record, snapshot, scoped config, settings) holds the secret');
  for (const text of [JSON.stringify(plan), run.context, JSON.stringify(run.capabilities), JSON.stringify(launched.args), JSON.stringify(readRecord(f.dir, run.runId))]) assert.ok(!text.includes(SECRET));
  assert.match(readFileSync(path.join(scopeDir(f.dir, run.runId), SCOPED_FILES.mcp), 'utf8'), /"OFFICE_TEST_TOKEN": "\$\{OFFICE_TEST_TOKEN\}"/);
  assert.deepEqual(tree(home), homeBefore, 'the global runner configuration (~/.claude, ~/.claude.json, ~/.codex, AppData) is untouched');
});

test('a secret written as a literal env value is refused, and nothing is written', async (t) => {
  t.after(stubDetection());
  const f = await checkout(t, { mcp: { gh: fence({ mcpServers: { gh: { command: 'npx', args: ['server-github'], env: { GITHUB_TOKEN: 'ghp_literalvalue' } } } }) }, adapters: 'mcp' });
  await assert.rejects(prepareRun(ctx(f.dir), opts), /refused, nothing was written: .*env "GITHUB_TOKEN".*reference the variable by name/);
  const [r] = listRecords(f.dir).records;
  assert.equal(existsSync(scopeDir(f.dir, r.runId)), false);
  assert.deepEqual(filesContaining(path.join(f.dir, 'harness-prepared'), 'ghp_literalvalue'), []);
});

test('an administrator-approved command is used only from the global level, with the approver recorded; the same slot below global is refused', async (t) => {
  t.after(stubDetection());
  claudeAdapterDeps.probe = async () => ({ ok: false, detail: 'not probed in this test' });
  t.after(() => { claudeAdapterDeps.probe = stdioProber(); });
  const decl = { mcp: { tool: fence({ mcpServers: { tool: { command: '/opt/tools/mcp-tool', args: ['--stdio'] } } }) }, adapters: 'mcp' };
  const denied = await checkout(t, decl);
  await assert.rejects(prepareRun(ctx(denied.dir), opts), /"\/opt\/tools\/mcp-tool" is not a bare command name; a path or a command line is used only when an administrator approved exactly it/);
  const ok = await checkout(t, { ...decl, global: { 'mcp.approved': { value: '/opt/tools/mcp-tool' } }, by: 'admin:alice' });
  const run = await prepareRun(ctx(ok.dir), opts);
  assert.match(readRecord(ok.dir, run.runId)!.steps.find((s) => s.id === 'adapters')!.detail, /tool approved by admin:alice/);
  const below = await checkout(t, decl);
  await below.profiles.save(below.dir, '', 'repository', { ...below.profiles.view(below.dir).layers.project, 'mcp.approved': { value: '/opt/tools/mcp-tool' } }, 2, 'worker:w9');
  await assert.rejects(prepareRun(ctx(below.dir), opts), /slot mcp\.approved is set at project; only the global level/);
});

test('narrowing only: a permissions element that would allow, set a mode or bypass is refused', async (t) => {
  t.after(stubDetection());
  for (const permissions of [{ allow: ['Bash'] }, { defaultMode: 'bypassPermissions' }, { deny: ['Bash'], additionalDirectories: ['/'] }]) {
    const f = await checkout(t, { permissions: { p: fence({ permissions }) }, adapters: 'permissions' });
    await assert.rejects(prepareRun(ctx(f.dir), opts), /would widen or change the runner's policy; a profile may only narrow it/);
  }
  assert.deepEqual(mergeClaudeSettings({ permissions: { allow: ['A'], deny: ['B'] }, hooks: { x: 1 } }, { deny: ['B', 'C'], ask: ['D'] }), { permissions: { allow: ['A'], deny: ['B', 'C'], ask: ['D'] }, hooks: { x: 1 } });
});

test('a worker whose run narrows its permissions never starts without them (fail closed)', async (t) => {
  t.after(stubDetection());
  const f = await checkout(t, { permissions: { p: fence({ permissions: { deny: ['WebFetch'] } }) }, adapters: 'permissions' });
  const run = await prepareRun(ctx(f.dir), opts);
  await run.claimed({ token: 't', agent: 'a' });
  bindRunLaunches(f.dir);
  rmSync(path.join(scopeDir(f.dir, run.runId), SCOPED_FILES.permissions));
  const plan = seatWithRun(run.runId, () => launchClaude(f.dir, 'w-closed', officeSettingsFile(f.dir)));
  assert.ok(plan.finishEnv, 'the start fails');
  assert.throws(() => plan.finishEnv!({}), /permission rules could not be applied.*not started without them/);
});

test('a miss is never cached: a worker launched before its run was recorded (an office that stopped mid-seat) gets the run on its next launch, by the run its contract names', async (t) => {
  t.after(stubDetection());
  const f = await checkout(t, { permissions: { p: fence({ permissions: { deny: ['WebFetch'] } }) }, adapters: 'permissions' });
  const run = await prepareRun(ctx(f.dir), opts);
  const office = officeSettingsFile(f.dir);
  bindRunLaunches(f.dir);
  // Before the claim nothing matches; a lookup that missed is tried again later.
  assert.equal(runLaunchFor({ id: 'w-late', prompt: run.context }), undefined);
  await run.claimed({ token: 't', agent: 'a' });
  // Claimed, no worker id recorded yet (the office stopped before seated): the run its contract names.
  const info = { id: 'w-late', provider: 'claude', prompt: run.context } as never;
  const plan = claude.launch({ h: { info } as never, args: [], prompt: 'go', cwd: f.dir, setup: { settings: office, dir: f.dir } });
  assert.notEqual(plan.args[plan.args.indexOf('--settings') + 1], office, 'the run\'s narrowed settings, not the office\'s');
});

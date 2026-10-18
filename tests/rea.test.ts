import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REA_PACKAGE, ReaSetting, configureRea, forgetForOpora, markForOpora, reaCodexArgs, reaCommand, reaEnvMode, reaFor, reaMode, reaOpenCode, reaPackage, seatForOpora, withReaBrief, writeReaClaudeConfig } from '../src/server/rea/index.js';
import { claude } from '../src/server/providers/claude.js';
import { codex } from '../src/server/providers/codex.js';
import { opencode } from '../src/server/providers/opencode.js';
import { PROMPTS } from '../src/shared/prompts.js';
import { PlanningRoom } from '../src/server/planning.js';
import { PLANNER_SEAT } from '../src/shared/planning.js';
import type { ReaState, WorkerInfo } from '../src/shared/protocol.js';

function scratch(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-rea-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const worker = (id: string) => ({ id, kind: 'agent', deskId: 'desk-1', name: id, color: '#fff', status: 'starting', acked: true, createdBy: 'Ana', createdAt: 0, cols: 80, rows: 24, viewers: [], viewerIds: [] }) as WorkerInfo;

/** Each MCP-taking provider's command line for `info`, the way the worker manager starts it. */
function launches(info: WorkerInfo, dir: string) {
  const h = (state?: unknown) => ({ info, state }) as never;
  const cl = claude.launch({ h: h(), args: [], cwd: dir, setup: { settings: path.join(dir, 'claude-hooks.json'), mcp: path.join(dir, 'agent-office-mcp.json'), dir } });
  const cx = codex.launch({ h: h(codex.createState!()), args: [], cwd: dir, setup: { hook: path.join(dir, 'hook.cjs'), mcpScript: '/office/bin/office-workers.js' } });
  const oc = opencode.launch({ h: h(opencode.createState!()), args: [], cwd: dir, setup: { plugin: path.join(dir, 'agent-office-opencode.mjs'), mcpScript: '/office/bin/office-workers.js' } });
  const env: Record<string, string> = {};
  oc.finishEnv!(env);
  const mcpFiles = cl.args.slice(cl.args.indexOf('--mcp-config') + 1, cl.args.indexOf('--settings'));
  return { claude: mcpFiles, codex: cx.args.join(' '), opencode: Object.keys(JSON.parse(env.OPENCODE_CONFIG_CONTENT).mcp ?? {}) };
}

test('REA runs one pinned package, which only another exact version of it can replace', () => {
  assert.equal(REA_PACKAGE, 'rea-agents@6.7.0');
  assert.equal(reaPackage({}), 'rea-agents@6.7.0');
  assert.equal(reaPackage({ AGENT_OFFICE_REA_PACKAGE: 'rea-agents@6.8.1' }), 'rea-agents@6.8.1');
  // Never a tag, a range, or a lookalike package.
  for (const bad of ['rea-agents', 'rea-agents@latest', 'rea-agents@^6.7.0', 'rea-agent@6.7.0', 'evil-rea-agents@6.7.0', 'rea-agents@6.7.0 && curl x']) assert.equal(reaPackage({ AGENT_OFFICE_REA_PACKAGE: bad }), REA_PACKAGE, bad);
  assert.deepEqual(reaCommand('rea-agents@6.7.0', 'linux'), ['npx', '-y', 'rea-agents@6.7.0', 'mcp']);
  assert.deepEqual(reaCommand('rea-agents@6.7.0', 'win32'), ['cmd', '/c', 'npx', '-y', 'rea-agents@6.7.0', 'mcp']);
});

test('the setting is off by default, kept across a restart, and AGENT_OFFICE_REA overrides it', (t) => {
  const dir = scratch(t);
  const told: ReaState[] = [];
  const s = new ReaSetting(dir, (state) => told.push(state), {});
  assert.equal(s.mode, 'off');
  assert.deepEqual(s.state(), { mode: 'off', package: REA_PACKAGE });
  assert.equal(s.set('opora', 'Ana'), undefined);
  assert.equal(told.at(-1)?.mode, 'opora');
  assert.equal(new ReaSetting(dir, undefined, {}).mode, 'opora', 'kept in rea.json');
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'rea.json'), 'utf8')).mode, 'opora');

  const env = { AGENT_OFFICE_REA: 'ALL' };
  const forced = new ReaSetting(dir, undefined, env);
  assert.equal(forced.mode, 'all');
  assert.equal(forced.state().env, 'all');
  assert.match(forced.set('off', 'Ana')!, /AGENT_OFFICE_REA=all/);
  assert.equal(reaEnvMode({ AGENT_OFFICE_REA: 'sometimes' }), undefined, 'a value it doesn’t know is ignored');
  assert.equal(new ReaSetting(dir, undefined, { AGENT_OFFICE_REA: 'sometimes' }).mode, 'opora');
});

test('off by default: no worker gets REA, and nobody is told about it', (t) => {
  const dir = scratch(t);
  configureRea(dir, undefined, {});
  assert.equal(reaMode(), 'off');
  const card = worker('card-off');
  seatForOpora(() => card);
  assert.equal(reaFor(card), false);
  assert.deepEqual(launches(card, dir), { claude: [path.join(dir, 'agent-office-mcp.json')], codex: launches(card, dir).codex, opencode: ['agent-office'] });
  assert.doesNotMatch(launches(card, dir).codex, /mcp_servers\.rea/);
  assert.equal(withReaBrief('Do the card.', (id) => PROMPTS[id].text), 'Do the card.');
});

test('opora: the workers seated for Opora get REA from their first launch on, a plain worker does not', (t) => {
  const dir = scratch(t);
  configureRea(dir, undefined, { AGENT_OFFICE_REA: 'opora' });
  const plain = worker('plain');
  const card = worker('card');
  // The worker manager launches a worker inside its seat call, before the bridge hears who it is.
  let first: ReturnType<typeof launches> | undefined;
  const seated = seatForOpora(() => {
    first = launches(card, dir);
    return card;
  });
  assert.equal(seated, card);
  assert.deepEqual(first!.claude, [path.join(dir, 'agent-office-mcp.json'), path.join(dir, 'rea-mcp.json')]);
  assert.match(first!.codex, /mcp_servers\.rea\.command=/);
  assert.match(first!.codex, /mcp_servers\.agent-office\.command=/);
  assert.deepEqual(first!.opencode, ['agent-office', 'rea']);
  // A resume later still gets it; the plain worker never does.
  assert.equal(reaFor(card), true);
  assert.deepEqual(launches(plain, dir), { claude: [path.join(dir, 'agent-office-mcp.json')], codex: launches(plain, dir).codex, opencode: ['agent-office'] });
  assert.doesNotMatch(launches(plain, dir).codex, /mcp_servers\.rea/);
  // A seat that failed (a string) marks nobody; the bridge's restored runs are marked again; a worker gone home is forgotten.
  assert.equal(seatForOpora(() => 'Every desk is taken'), 'Every desk is taken');
  markForOpora('restored');
  assert.equal(reaFor(worker('restored')), true);
  forgetForOpora('card');
  assert.equal(reaFor(card), false);
  // The shared agent-office config is left as it was: REA's is a file of its own.
  const rea = JSON.parse(readFileSync(path.join(dir, 'rea-mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(rea.mcpServers), ['rea']);
  assert.ok(rea.mcpServers.rea.args.includes(REA_PACKAGE));
});

test('all: every worker the office starts gets REA', (t) => {
  const dir = scratch(t);
  configureRea(dir, undefined, { AGENT_OFFICE_REA: 'all' });
  const plain = worker('plain-all');
  assert.equal(reaFor(plain), true);
  const l = launches(plain, dir);
  assert.equal(l.claude.length, 2);
  assert.match(l.codex, /mcp_servers\.rea\.args=.*rea-agents@6\.7\.0/);
  assert.deepEqual(l.opencode, ['agent-office', 'rea']);
});

test('the setting from ⚙️ Settings applies when no env var says otherwise', (t) => {
  const dir = scratch(t);
  const s = configureRea(dir, undefined, {});
  s.set('all', 'Ana');
  assert.equal(reaMode(), 'all');
  s.set('off', 'Ana');
  assert.equal(reaFor(worker('x')), false);
});

test('the REA brief is added after the Opora prompts only while REA is on', () => {
  const prompt = (id: keyof typeof PROMPTS) => PROMPTS[id].text;
  assert.equal(withReaBrief('Do the card.', prompt, 'off'), 'Do the card.');
  const on = withReaBrief('Do the card.', prompt, 'opora');
  assert.ok(on.startsWith('Do the card.\n\n'));
  assert.match(on, /"rea" MCP server/);
  assert.match(on, /rea-agents@6\.7\.0/);
  assert.match(on, /layers → areas, sectors, nodes\/cards/);
  assert.match(on, /owns or is permitted to analyze/);
  assert.match(on, /never execute an untrusted target unless the card asks for runtime capture/);
  // Emptied in ⚙️ Settings, it tells them nothing.
  assert.equal(withReaBrief('Do the card.', (id) => (id === 'opora.rea' ? '' : PROMPTS[id].text), 'all'), 'Do the card.');
});

test('each provider gets REA as its own config shape', (t) => {
  const dir = scratch(t);
  const file = writeReaClaudeConfig(dir);
  const cfg = JSON.parse(readFileSync(file, 'utf8')).mcpServers.rea;
  assert.equal(cfg.type, 'stdio');
  assert.deepEqual([cfg.command, ...cfg.args], reaCommand());
  const args = reaCodexArgs();
  assert.equal(args.filter((a) => a === '-c').length, 3);
  assert.ok(args.includes('mcp_servers.rea.startup_timeout_sec=120'));
  assert.deepEqual(reaOpenCode(), { rea: { type: 'local', command: reaCommand(), enabled: true } });
});

test('opora: the planner planning onto the Opora canvas gets REA, one writing a plan file does not', (t) => {
  const dir = scratch(t);
  configureRea(dir, undefined, { AGENT_OFFICE_REA: 'opora' });
  t.after(() => configureRea(dir, undefined, {}));
  const workers: WorkerInfo[] = [];
  const room = new PlanningRoom(
    dir,
    dir,
    {
      list: () => workers,
      seat(_by, prompt) {
        const w = { ...worker(`planner-${workers.length}`), prompt, deskId: PLANNER_SEAT.id };
        // The manager's first launch, inside the seat call.
        reaFor(w);
        workers.push(w);
        return w;
      },
      kill(id) {
        workers.splice(workers.findIndex((w) => w.id === id), 1);
        return Promise.resolve({});
      },
    },
    { add: () => undefined, state: () => ({ tasks: [], maxWorkers: 1 }) },
    { update: () => undefined, toast: () => undefined, hiringPaused: () => undefined, prompt: (id) => PROMPTS[id].text, opora: () => ({ base: 'http://127.0.0.1:8000', project: 'p1', workspace: 'main' }) },
  );
  t.after(() => room.shutdown());
  assert.equal(room.start({ goal: 'Rebuild the reference app', mode: 'opora' }, 'Ana'), undefined);
  assert.equal(reaFor(workers[0]), true);
  assert.match(workers[0].prompt!, /"rea" MCP server/);
  assert.equal(room.clear('Ana'), undefined);
  assert.equal(reaFor({ id: 'planner-0' }), false, 'forgotten once the room is cleared');

  assert.equal(room.start({ goal: 'Plan a PDF export' }, 'Ana'), undefined);
  const plain = workers.at(-1)!;
  assert.equal(reaFor(plain), false);
  assert.doesNotMatch(plain.prompt!, /"rea" MCP server/);
});

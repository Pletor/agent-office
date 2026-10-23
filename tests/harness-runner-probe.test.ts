import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { probeRunner, probeEnvironment } from '../src/server/harness/runner-probe.js';
import { probeProcess, PROBE_BYTES } from '../src/server/harness/probe-process.js';
import { officeHarness } from '../src/server/harness/api.js';
import { runnerProbeRequest } from '../src/server/harness/runner-probe-api.js';
import type { Ctx } from '../src/server/office/context.js';

test('runner probes use fixed vectors, scrub secrets, isolate configuration and retain observed/declarative boundaries', async () => {
  const calls: string[][] = [], homes: string[] = [];
  const result = await probeRunner('claude', { locate: () => process.execPath,
    env: { PATH: process.env.PATH, CONTEXT7_API_KEY: 'never-forward', AGENT_OFFICE_HOOK_TOKEN: 'never-forward', HOME: 'private-home' },
    run: async (file, args, cwd, env, timeout) => {
      assert.equal(file, process.execPath); assert.ok(timeout > 0 && timeout <= 5000); assert.equal(env.HOME, cwd);
      assert.equal(env.CONTEXT7_API_KEY, undefined); assert.equal(env.AGENT_OFFICE_HOOK_TOKEN, undefined);
      assert.ok((await stat(cwd)).isDirectory()); homes.push(cwd); calls.push([...args]);
      return { outcome: 'pass', reason: 'completed', code: 0, text: args[0] === '--version' ? 'Fixture 1.2.3' : '--mcp-config FILE\n--strict-mcp-config\n--settings FILE', bytes: 100, durationMs: 7 };
    } });
  assert.deepEqual(calls, [['--version'], ['--help']]); assert.equal(result.version, 'Fixture 1.2.3');
  assert.deepEqual(result.advertisedFlags, ['--mcp-config', '--strict-mcp-config', '--settings']);
  assert.equal(result.authority, 'local-process-observation'); assert.equal(result.workerEnvironmentAttested, false);
  assert.deepEqual(result.availableRequirements, []); assert.equal(result.promotionAllowed, false);
  for (const home of homes) await assert.rejects(stat(home), { code: 'ENOENT' });
});

test('unknown/custom/missing/batch runners never become executable or ready', async () => {
  let calls = 0;
  const run = async () => { calls++; throw new Error('must never run'); };
  await assert.rejects(probeRunner('foreign' as any, { run }), /Unknown/);
  for (const [runner, locate, reason] of [
    ['custom', () => process.execPath, 'custom-runner-unconfigured'],
    ['claude', () => undefined, 'executable-not-found'],
    ['claude', () => 'C:/fixture/claude.cmd', 'batch-launcher-unsupported'],
  ] as const) {
    const result = await probeRunner(runner, { locate, run });
    assert.equal(result.version, null); assert.equal(result.versionProbe.reason, reason); assert.deepEqual(result.advertisedFlags, []);
  }
  assert.equal(calls, 0);
});

test('real subprocess probes measure exits and enforce time/output bounds without credential inheritance', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'probe-process-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = probeEnvironment(dir, { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SECRET_FIXTURE: 'never-forward' });
  const passed = await probeProcess(process.execPath, ['-e', 'process.stdout.write(String(process.env.SECRET_FIXTURE))'], dir, env, 2000);
  assert.equal(passed.outcome, 'pass'); assert.equal(passed.text, 'undefined'); assert.ok(passed.durationMs > 0);
  const failed = await probeProcess(process.execPath, ['-e', 'process.exit(3)'], dir, env, 2000);
  assert.equal(failed.outcome, 'fail'); assert.equal(failed.code, 3);
  const large = await probeProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(' + (PROBE_BYTES + 1) + '))'], dir, env, 2000);
  assert.equal(large.reason, 'output-limit'); assert.equal(large.text, '');
  const hung = await probeProcess(process.execPath, ['-e', 'setInterval(()=>{}, 100)'], dir, env, 100);
  assert.equal(hung.reason, 'timeout'); assert.ok(hung.durationMs < 4000);
  assert.equal((await probeProcess(path.join(dir, 'missing'), [], dir, env, 100)).reason, 'spawn-failed');
});

test('worker probe requires authentication, derives its provider, refuses overrides and limits requests', async t => {
  const floor = { id: 'floor', workers: { defaultProvider: 'claude', authenticate: (id: string, token: string) => id === 'known' && token === 'fixture-token' ? { id, provider: 'custom' } : undefined } };
  const ctx = { workerFloor: () => floor } as unknown as Ctx;
  const server = http.createServer((req, res) => void officeHarness(ctx, req, res, new URL(req.url!, 'http://x')));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/office/harness?worker=known&capabilities=1';
  assert.equal((await fetch(base)).status, 401);
  const headers = { authorization: 'Bearer fixture-token' };
  assert.equal((await fetch(base + '&runner=claude', { headers })).status, 400);
  assert.equal((await fetch(base + '&command=node', { headers })).status, 400);
  assert.equal((await fetch(base, { method: 'POST', headers })).status, 405);
  for (let n = 0; n < 4; n++) {
    const response = await fetch(base, { headers }); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json()).runner, 'custom');
  }
  assert.equal((await fetch(base, { headers })).status, 429);
});

test('timeout stops a probe child tree, including a helper that would keep writing', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'probe-tree-test-')), heartbeat = path.join(dir, 'heartbeat');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const helper = "const fs=require('node:fs');setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),20)";
  const parent = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e'," + JSON.stringify(helper) + ",process.argv[1]],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},100)";
  const result = await probeProcess(process.execPath, ['-e', parent, heartbeat], dir, probeEnvironment(dir), 700);
  assert.equal(result.reason, 'timeout');
  const helperPid = Number(result.text.trim()); assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  const first = (await stat(heartbeat)).mtimeMs;
  await new Promise(resolve => setTimeout(resolve, 150));
  const stopped = (await stat(heartbeat)).mtimeMs === first;
  if (!stopped) { try { process.kill(helperPid, 'SIGKILL'); } catch { /* already gone */ } }
  assert.equal(stopped, true, 'helper must stop before the probe result is returned');
});

test('the authenticated endpoint refuses a third simultaneous probe and releases capacity after completion', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const probe = async () => { await gate; return probeRunner('custom'); };
  const response = () => ({ status: 0, writeHead(status: number) { this.status = status; return this; }, end() {} });
  const req = { method: 'GET' } as http.IncomingMessage, url = new URL('http://local/?worker=fixture&capabilities=1');
  const first = response(), second = response(), third = response();
  const p1 = runnerProbeRequest(req, first as unknown as http.ServerResponse, url, 'custom', 'concurrency:first', probe);
  const p2 = runnerProbeRequest(req, second as unknown as http.ServerResponse, url, 'custom', 'concurrency:second', probe);
  try {
    await runnerProbeRequest(req, third as unknown as http.ServerResponse, url, 'custom', 'concurrency:third', probe);
    assert.equal(third.status, 429);
  } finally { release(); await Promise.all([p1, p2]); }
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  const after = response();
  await runnerProbeRequest(req, after as unknown as http.ServerResponse, url, 'custom', 'concurrency:after', probe);
  assert.equal(after.status, 200);
});

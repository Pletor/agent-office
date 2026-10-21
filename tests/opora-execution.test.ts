import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { ExecutionClient, ExecutionError, validateExecution, type ExecutionLease } from '../src/server/opora/execution-client.js';
import { ExecutionController, executionDeadline } from '../src/server/opora/execution-controller.js';
import { ExecutionDispatch } from '../src/server/opora/execution-dispatch.js';
import { executionPrompt } from '../src/server/opora/execution-prompt.js';
import { reportExecution } from '../src/server/opora/execution-worker.js';
import { WorkerManager } from '../src/server/workers.js';
import { Ledger } from '../src/server/usage.js';
import { WorkerLaunchGuards } from '../src/server/workers/launch-guards.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const scope = { project: 'project', workspace: 'work', nodeId: 'card' };
const lease = (): ExecutionLease => ({ ...scope, executionId: 'execution-1', token: 'PRIVATE-token', epoch: 7,
  acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64), assignment: { contextVersion: 'context', documents: { card: 'accepted brief' } },
  state: 'running', serverNow: 100, expiresAt: 1000 });
const worker = (id: string, prompt = '') => ({ id, via: 'opora', prompt, status: 'working' }) as WorkerInfo;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function directory(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-execution-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}

test('numeric server lifetime ignores clock skew, charges request latency, rejects invalid and terminal grants', () => {
  assert.equal(executionDeadline({ serverNow: 1_000_000, expiresAt: 1_000_010 }, 15), 10015);
  assert.throws(() => executionDeadline({ serverNow: 10, expiresAt: 10 }, 0));
  for (const patch of [{ epoch: 0 }, { state: 'revoked' }, { workspace: 'other' }, { serverNow: '100' }, { token: 'bad\n' }])
    assert.throws(() => validateExecution({ ...lease(), ...patch }, scope));
});

test('claim validates requested context, heartbeat refuses changed epoch, errors never echo secrets', async () => {
  let answer: unknown = lease();
  const client = new ExecutionClient('http://localhost:5010', 'office', async (_url, options) => {
    assert.equal(options?.redirect, 'error'); return new Response(JSON.stringify(answer));
  });
  await assert.rejects(client.claim({ ...scope, expectedAcceptedHead: 'c'.repeat(40), expectedContextVersion: 'context', requestId: 'r', ttlSeconds: 900 }));
  answer = { ...lease(), epoch: 8 };
  await assert.rejects(client.heartbeat(lease(), 900), /identity changed/);
  const failed = new ExecutionClient('http://localhost', 'office', async () => { throw new Error('PRIVATE-token'); });
  await assert.rejects(failed.heartbeat(lease(), 900), error => error instanceof ExecutionError && !error.message.includes('PRIVATE') && !error.terminal);
});

test('uncertain claim retries the identical request, revalidates replay before launch, and guards concurrent dispatch', async () => {
  const client = new ExecutionClient('http://localhost', 'office');
  client.context = async () => ({ available: true, unavailableReason: '', acceptedHead: 'a'.repeat(40), contextVersion: 'context' });
  const requests: unknown[] = [];
  client.claim = async payload => { requests.push(payload); if (requests.length === 1) throw new ExecutionError(0, false); return lease(); };
  client.heartbeat = async () => ({ ...lease(), serverNow: 995, expiresAt: 1000 });
  const controller = new ExecutionController(client, () => {}, () => {}, () => 20);
  await assert.rejects(controller.claim(scope));
  assert.equal((await controller.claim(scope)).deadline, 5020);
  assert.deepEqual(requests[0], requests[1]);
  let resolve!: () => void;
  const pending = controller.guarded(scope, () => new Promise<void>(done => { resolve = done; }));
  await assert.rejects(controller.guarded(scope, async () => {}), /already/);
  resolve(); await pending;
});

test('independent deadline kills a worker even while heartbeat never replies', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const stopped: string[] = [];
  const client = new ExecutionClient('http://localhost', 'office');
  client.heartbeat = () => new Promise(() => {});
  const controller = new ExecutionController(client, () => {}, id => stopped.push(id), () => now);
  controller.watch('w', lease(), 100);
  now = 50; t.mock.timers.tick(50); await flush();
  assert.equal(controller.allowed('w'), true);
  now = 100; t.mock.timers.tick(50); await flush();
  assert.deepEqual(stopped, ['w']); assert.equal(controller.allowed('w'), false);
  controller.shutdown();
});

test('transient heartbeat retains original deadline and terminal rejection stops immediately', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0, terminal = false;
  const stopped: string[] = [];
  const client = new ExecutionClient('http://localhost', 'office');
  client.heartbeat = async () => { throw new ExecutionError(terminal ? 409 : 503, terminal); };
  const controller = new ExecutionController(client, () => {}, id => stopped.push(id), () => now);
  controller.watch('w', lease(), 10000);
  now = 5000; t.mock.timers.tick(5000); await flush();
  assert.equal(controller.allowed('w'), true);
  terminal = true; now = 7000; t.mock.timers.tick(2000); await flush();
  assert.deepEqual(stopped, ['w']); controller.shutdown();
});

test('private helper posts capability without exposing it in assignment, prompt or public receipt', async t => {
  const dir = directory(t);
  const prompt = executionPrompt(dir, 'http://localhost:5010', 'office', lease());
  assert.doesNotMatch(prompt, /PRIVATE-token/);
  const base = path.join(dir, 'opora-executions', 'execution-1');
  assert.doesNotMatch(readFileSync(base + '-assignment.json', 'utf8'), /PRIVATE-token/);
  const result = path.join(dir, 'result.json'); writeFileSync(result, JSON.stringify({ summary: 'Ready', artifacts: [] }));
  let requestId = '';
  const send: typeof fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    assert.equal(body.token, 'PRIVATE-token'); assert.equal(body.epoch, 7);
    if (requestId) assert.equal(requestId, body.requestId); requestId = body.requestId;
    return new Response(JSON.stringify({ receiptId: 'receipt', executionId: 'execution-1', state: 'reported', token: 'PRIVATE-token' }));
  };
  assert.doesNotMatch(JSON.stringify(await reportExecution(base + '.json', result, send)), /PRIVATE-token/);
  await reportExecution(base + '.json', result, send);
});

test('seating cannot authorize unrelated resume; failed spawn releases authority and forgets watch', async t => {
  const stopped: string[] = [], releases: string[] = [];
  const dispatch = new ExecutionDispatch('http://localhost', 'office', directory(t), () => [], () => {}, id => stopped.push(id));
  dispatch.controller.claim = async () => ({ lease: lease(), deadline: performance.now() + 10000 });
  dispatch.client.release = async grant => { releases.push(grant.executionId); };
  await assert.rejects(dispatch.dispatch(scope, async () => '', prompt => {
    assert.ok(dispatch.guard.check(worker('unrelated', 'old prompt')));
    assert.equal(dispatch.guard.check(worker('new', prompt)), undefined);
    throw new Error('spawn failed');
  }), /spawn failed/);
  assert.equal(dispatch.controller.allowed('new'), false);
  assert.deepEqual(stopped, ['new']); assert.deepEqual(releases, ['execution-1']);
});

test('restore requires revalidation before resume; rejects legacy and expired execution without replacement claim', async t => {
  const runs = [{ workerId: 'saved', execution: lease() }];
  const stopped: string[] = [];
  const dispatch = new ExecutionDispatch('http://localhost', 'office', directory(t), () => runs, () => {}, id => stopped.push(id));
  const guards = new WorkerLaunchGuards(); guards.add(dispatch.guard);
  const info = worker('saved');
  assert.ok(guards.check(info));
  dispatch.client.heartbeat = async grant => grant;
  assert.equal(await guards.restore(info), undefined); assert.equal(guards.check(info), undefined);
  dispatch.controller.forget('saved');
  dispatch.client.heartbeat = async () => { throw new ExecutionError(409, true); };
  assert.match((await guards.restore(info))!, /could not be revalidated/);
  assert.ok(guards.check(info));
  assert.match((await guards.restore(worker('legacy')))!, /could not be revalidated/);
  assert.deepEqual(stopped, ['saved', 'legacy']); dispatch.controller.shutdown();
});


test('generated helper runs from a foreign working directory with spaces and apostrophes', async t => {
  const dir = path.join(directory(t), "assignment's space $(unsafe)"); mkdirSync(dir);
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      const body = JSON.parse(raw);
      assert.equal(body.token, 'PRIVATE-token');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ receiptId: 'safe-receipt', executionId: 'execution-1', state: 'reported' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const prompt = executionPrompt(dir, base, 'office', lease());
  const result = path.join(dir, 'result.json'); writeFileSync(result, JSON.stringify({ summary: 'Done' }));
  const windows = process.platform === 'win32';
  const command = prompt.split('\n').find(line => line.includes('REPLACE_WITH_ABSOLUTE_RESULT_JSON') && !line.startsWith('Write'))!
    .replace('REPLACE_WITH_ABSOLUTE_RESULT_JSON', windows ? result.replaceAll("'", "''") : result.replaceAll("'", "'\"'\"'"));
  const output = await promisify(execFile)(windows ? 'powershell.exe' : '/bin/sh', windows ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command], { cwd: dir, timeout: 20000 });
  assert.equal(JSON.parse(output.stdout).receiptId, 'safe-receipt');
  assert.doesNotMatch(output.stdout + output.stderr, /PRIVATE-token/);
});


test('real WorkerManager spawn normalization preserves dispatch guard authority', async t => {
  const dir = directory(t);
  const manager = new WorkerManager(dir, dir, process.execPath, [], { url: 'http://127.0.0.1:1', token: '' },
    { update() {}, remove() {}, data() {}, screen() {}, toast() {} }, new Ledger(dir, { pauseHiring: false }, () => {}, () => {}));
  t.after(() => manager.shutdown());
  const dispatch = new ExecutionDispatch('http://localhost', 'office', dir, () => [], () => {}, () => {});
  dispatch.controller.claim = async () => ({ lease: lease(), deadline: performance.now() + 10000 });
  dispatch.client.release = async () => {};
  manager.launchGuards.add(dispatch.guard);
  let passed = false;
  // Run the actual spawn/launch normalization, but stop before any external agent process.
  manager.launchGuards.add({ applies: () => true, restore: async () => undefined, check: info => {
    passed = true; assert.equal(info.prompt, info.prompt?.trim());
    assert.equal(dispatch.controller.allowed(info.id), true); return 'fixture stops external launch';
  } });
  await assert.rejects(dispatch.dispatch(scope, async () => '', prompt => manager.spawn('desk-1', 'test', prompt, false, 'agent', 'custom', undefined, undefined, undefined, undefined, [], 'opora')), /failed to start/);
  assert.equal(passed, true);
  dispatch.controller.shutdown();
});


test('terminal prelaunch revalidation releases known claim; transient refusal retains replay', async () => {
  const client = new ExecutionClient('http://localhost', 'office');
  client.context = async () => ({ available: true, unavailableReason: '', acceptedHead: 'a'.repeat(40), contextVersion: 'context' });
  const requests: string[] = [], released: string[] = [];
  client.claim = async payload => { requests.push(payload.requestId); return lease(); };
  client.release = async grant => { released.push(grant.executionId); };
  let terminal = false;
  client.heartbeat = async () => { throw new ExecutionError(terminal ? 409 : 503, terminal); };
  const controller = new ExecutionController(client, () => {}, () => {});
  await assert.rejects(controller.claim(scope)); assert.deepEqual(released, []);
  terminal = true; await assert.rejects(controller.claim(scope));
  assert.equal(requests[0], requests[1]); assert.deepEqual(released, ['execution-1']);
  await assert.rejects(controller.claim(scope)); assert.notEqual(requests[1], requests[2]);
});

test('heartbeat projection refreshes visible lease expiry without capability leakage', async t => {
  const runs = [{ workerId: 'saved', execution: lease(), deadlineUnixMs: 0, leaseUntil: 'old' }];
  const dispatch = new ExecutionDispatch('http://localhost', 'office', directory(t), () => runs, () => {}, () => {});
  dispatch.client.heartbeat = async () => ({ ...lease(), serverNow: 1000, expiresAt: 1900 });
  await dispatch.guard.restore(worker('saved'));
  assert.equal(runs[0].leaseUntil, new Date(1900000).toISOString());
  assert.ok(runs[0].deadlineUnixMs > Date.now());
  dispatch.controller.shutdown();
});


test('expired grant cannot become a successful run after synchronous worker seating', async t => {
  const stopped: string[] = [], released: string[] = [];
  const dispatch = new ExecutionDispatch('http://localhost', 'office', directory(t), () => [], () => {}, id => stopped.push(id));
  dispatch.controller.claim = async () => ({ lease: lease(), deadline: performance.now() - 1 });
  dispatch.client.release = async grant => { released.push(grant.executionId); };
  await assert.rejects(dispatch.dispatch(scope, async () => '', prompt => worker('new', prompt)), /expired while starting/);
  assert.ok(stopped.includes('new')); assert.deepEqual(released, ['execution-1']);
  assert.equal(dispatch.controller.allowed('new'), false);
});

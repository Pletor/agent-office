// The hand-off's evidence and its end, as seen on a live run (watch-wave1 F8, F10, F11): self-check
// evidence Canvas didn't answer for is kept and posted again as it was; a heartbeat refused after the
// result is in is the run's normal end; and one hand-off is told to the process wall once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecutionClient, ExecutionError, type ExecutionLease } from '../src/server/opora/execution-client.js';
import { EXECUTION_FINISHED, ExecutionController } from '../src/server/opora/execution-controller.js';
import { ExecutionDispatch } from '../src/server/opora/execution-dispatch.js';
import { requestExecutionStop } from '../src/server/opora/execution-stop.js';
import type { HandoffTools } from '../src/server/opora/pull-request-handoff.js';
import { SelfCheckReporter, type ExecCheck } from '../src/server/opora/self-checks.js';
import { selfCheckDelay } from '../src/server/opora/self-check-pending.js';
import { heartbeatEvent } from '../src/server/process/opora-events.js';
import { outboxToProcess } from '../src/server/process/opora-outbox.js';
import { processHub } from '../src/server/process/hub.js';
import type { ProcessEvent, WorkerInfo } from '../src/shared/protocol.js';

const HEAD = 'c'.repeat(40), NEXT = 'e'.repeat(40);
const scope = { project: 'shop', workspace: 'work' };
const lease = (): ExecutionLease => ({ ...scope, nodeId: 'card-0123456789abcdef', executionId: 'execution-1', token: 'PRIVATE-token', epoch: 7,
  acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64), assignment: { contextVersion: 'context' }, state: 'running', serverNow: 100, expiresAt: 1000 });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function tmp(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The floor `f` (agent `office-f`) on the process hub, and every event it gets. */
function wall(t: { after(fn: () => void): void }) {
  const events: ProcessEvent[] = [];
  const floors = processHub.floors;
  processHub.floors = (id) => (id === 'f' ? { id: 'f', dir: tmpdir() } : floors(id));
  const off = processHub.onEvent((floor, e) => { if (floor === 'f') events.push(e); });
  t.after(() => { off(); processHub.floors = floors; });
  return events;
}

// ── F8: self-check evidence Canvas didn't answer for ──────────────────────────────────────────────

/** A Canvas that answers each self-check post with the next of `answers` (a status, or 'throw' for a timeout). */
function canvas(answers: (number | 'throw')[]) {
  const bodies: string[] = [];
  const transport = (async (_url: URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    if (next === 'throw') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return new Response('{}', { status: next });
  }) as typeof fetch;
  return { transport, bodies };
}
function checks() {
  const ran: string[] = [];
  let n = 0;
  // Each run differs (as real durations and output do), so a re-run would be a different record.
  const exec: ExecCheck = async (command) => { ran.push(command); return { exitCode: 0, output: `run ${++n}` }; };
  return { exec, ran };
}

test('evidence Canvas never answered for is kept on disk and posted again, the same body, until recorded', async t => {
  const dir = tmp(t), ledger = path.join(dir, 'opora-self-checks.json');
  const f = canvas(['throw', 503, 200]);
  const { exec, ran } = checks();
  let now = 1_000_000;
  const logs: string[] = [];
  const make = () => new SelfCheckReporter('http://canvas', 'office-1', [{ name: 'tests', command: 'npm test' }], ledger, exec, f.transport,
    (m) => void logs.push(m), { everyMs: 5, attempts: 0 }, undefined, () => now);
  const reporter = make();
  const subject = { ...scope, executionId: 'ex-1', headSha: HEAD, dir };
  assert.equal(await reporter.report(subject), 'failed');
  assert.match(logs.at(-1)!, /not recorded by Canvas \(failed\); kept to post again/);
  const unsent = JSON.parse(readFileSync(path.join(dir, 'opora-self-checks-unsent.json'), 'utf8'));
  assert.equal(unsent[`ex-1@${HEAD}`].selfChecks.headSha, HEAD);

  assert.equal(await reporter.report(subject), 'skipped', 'the hand-off on the next poll does not run the checks again');
  await reporter.retryPending();
  assert.equal(f.bodies.length, 1, 'nothing goes before its turn');

  // After a restart: a new reporter finds it on disk. Canvas still down (503): it backs off.
  const restarted = make();
  now += selfCheckDelay(1);
  await restarted.retryPending();
  assert.equal(f.bodies.length, 2);
  const after = JSON.parse(readFileSync(path.join(dir, 'opora-self-checks-unsent.json'), 'utf8'))[`ex-1@${HEAD}`];
  assert.equal(after.attempts, 2);
  assert.equal(after.nextAt, now + selfCheckDelay(2));
  assert.ok(selfCheckDelay(2) > selfCheckDelay(1));

  now += selfCheckDelay(2);
  await restarted.retryPending();
  assert.equal(f.bodies.length, 3);
  assert.equal(f.bodies[1], f.bodies[0], 'the same body, so Canvas takes it idempotently even if an earlier post got through');
  assert.equal(f.bodies[2], f.bodies[0]);
  assert.deepEqual(ran, ['npm test'], 'the checks ran once');
  assert.equal(JSON.parse(readFileSync(ledger, 'utf8'))[`ex-1@${HEAD}`], 'recorded');
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'opora-self-checks-unsent.json'), 'utf8')), {});
  assert.match(logs.at(-1)!, /Canvas recorded them on try 3/);
  assert.equal(await restarted.report(subject), 'skipped');
});

test('unsent evidence stops waiting once the execution has a new head, or after a day', async t => {
  const dir = tmp(t), ledger = path.join(dir, 'ledger.json');
  const f = canvas(['throw']);
  const { exec, ran } = checks();
  let now = 0;
  const logs: string[] = [];
  const reporter = new SelfCheckReporter('http://canvas', 'office-1', [{ name: 'tests', command: 'npm test' }], ledger, exec, f.transport,
    (m) => void logs.push(m), { everyMs: 5, attempts: 0 }, undefined, () => now);
  assert.equal(await reporter.report({ ...scope, executionId: 'ex-1', headSha: HEAD, dir }), 'failed');
  assert.equal(await reporter.report({ ...scope, executionId: 'ex-1', headSha: NEXT, dir }), 'failed');
  const keys = Object.keys(JSON.parse(readFileSync(path.join(dir, 'ledger-unsent.json'), 'utf8')));
  assert.deepEqual(keys, [`ex-1@${NEXT}`], 'the old head is dropped');
  assert.equal(ran.length, 2);
  now += 25 * 3600_000;
  await reporter.retryPending();
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'ledger-unsent.json'), 'utf8')), {});
  assert.match(logs.at(-1)!, /gave up/);
});

// ── F10: the heartbeat refused after the result is in ─────────────────────────────────────────────

test('a 409 heartbeat after the result receipt is stored ends the run as finished, not as an error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = wall(t);
  let now = 0;
  const stopped: [string, string][] = [];
  const client = new ExecutionClient('http://localhost', 'office-f');
  client.heartbeat = async () => { throw new ExecutionError(409, true, 'Canvas execution request refused (409)'); };
  const controller = new ExecutionController(client, () => {}, (id, reason) => stopped.push([id, reason]), () => now);
  controller.ended = (id) => id === 'execution-1';
  controller.watch('w', lease(), 100_000);
  now = 30_000; t.mock.timers.tick(30_000); await flush();
  assert.deepEqual(stopped, [['w', EXECUTION_FINISHED]]);
  assert.deepEqual(events.map((e) => [e.kind, e.state, e.title]), [['run.release', 'ok', 'Běh execution-1 dokončen']]);
  controller.shutdown();

  // The run is stored without an error, nobody is warned, and the worker is still sent home.
  const run: { state: string; error?: string } = { state: 'working' };
  const warnings: string[] = [], sent: string[] = [];
  requestExecutionStop(run, 'w', EXECUTION_FINISHED, async (id) => { sent.push(id); }, () => {}, (m) => void warnings.push(m));
  await flush();
  assert.deepEqual([run.state, run.error, warnings, sent], ['gone', undefined, [], ['w']]);
});

test('without a stored receipt, or for another refusal, a terminal heartbeat stays an error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0, status = 409;
  const stopped: string[] = [];
  const client = new ExecutionClient('http://localhost', 'office');
  client.heartbeat = async () => { throw new ExecutionError(status, true, `Canvas execution request refused (${status})`); };
  const controller = new ExecutionController(client, () => {}, (_id, reason) => stopped.push(reason), () => now);
  controller.ended = () => false;
  controller.watch('a', lease(), 100_000);
  now = 30_000; t.mock.timers.tick(30_000); await flush();
  controller.ended = () => true; status = 410;
  controller.watch('b', lease(), 200_000);
  now = 60_000; t.mock.timers.tick(30_000); await flush();
  assert.deepEqual(stopped, ['Canvas execution request refused (409)', 'Canvas execution request refused (410)']);
  controller.shutdown();
  assert.equal(heartbeatEvent(lease(), 'a', 'stopped', 'x').state, 'fail');
  const run: { state: string; error?: string } = { state: 'working' };
  const warnings: string[] = [];
  requestExecutionStop(run, 'a', 'Canvas execution request refused (409)', async () => undefined, () => {}, (m) => void warnings.push(m));
  await flush();
  assert.match(run.error!, /409/);
  assert.equal(warnings.length, 1);
});

test('the dispatch counts a run as finished only once the result helper stored the receipt', t => {
  const dir = tmp(t);
  mkdirSync(path.join(dir, 'opora-executions'), { recursive: true });
  const dispatch = new ExecutionDispatch('http://localhost', 'office', dir, () => [], () => {}, () => {});
  assert.equal(dispatch.controller.ended?.('execution-1'), false);
  writeFileSync(path.join(dir, 'opora-executions', 'execution-1-reported.json'), JSON.stringify({ result: { summary: 'x' } }));
  assert.equal(dispatch.controller.ended?.('execution-1'), false, 'no receipt id, no receipt');
  writeFileSync(path.join(dir, 'opora-executions', 'execution-1-reported.json'), JSON.stringify({ receiptId: 'r-1', result: { summary: 'x' } }));
  assert.equal(dispatch.controller.ended?.('execution-1'), true);
});

// ── F11: one hand-off, one event ──────────────────────────────────────────────────────────────────

test('callers joining one hand-off, and polls finding it done, tell the process wall once', async t => {
  const events = wall(t);
  const dir = tmp(t);
  mkdirSync(path.join(dir, 'opora-executions'), { recursive: true });
  mkdirSync(path.join(dir, 'tree'), { recursive: true });
  writeFileSync(path.join(dir, 'opora-executions', 'execution-1-reported.json'), JSON.stringify({ receiptId: 'r', result: { summary: 'Done' } }));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const tools: HandoffTools = {
    env: {},
    git: async (args) => {
      if (args[0] === 'push') await gate;
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return HEAD;
      if (args[0] === 'rev-list') return '2';
      if (args[0] === 'remote') return 'git@github.com:Pletor/shop.git';
      return 'x';
    },
    gh: async (args) => (args[0] === 'pr' && args[1] === 'list' ? '[]' : args[1] === 'create' ? 'https://github.com/Pletor/shop/pull/13\n' : ''),
    transport: (async () => new Response('{}', { status: 200 })) as typeof fetch,
  };
  const dispatch = new ExecutionDispatch('http://localhost', 'office-f', dir, () => [], () => {}, () => {}, tools);
  const info = { id: 'w1', worktree: { path: 'tree', branch: 'office/w1', base: 'd'.repeat(40), from: 'main' } } as WorkerInfo;
  const run = { workerId: 'w1', execution: lease(), cardName: 'Cart page' };
  // The stop callback and the worker's update both hand off while the push is under way (as on the live run).
  const first = dispatch.handOff(run, info, dir, () => {});
  const second = dispatch.handOff(run, info, dir, () => {});
  release();
  assert.equal((await first)?.state, 'opened');
  await second;
  await dispatch.handOff(run, info, dir, () => {});
  await flush();
  const opened = events.filter((e) => e.kind === 'pr.opened');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].title, 'Otevřen PR #13 pro běh execution-1');
});

test('the code and the security review round of one head read as two on the wall', () => {
  const round = (kind: string) => outboxToProcess({ kind: 'review.round', source: 'opora', title: 'Kolo review 1', prNumber: 13, data: { kind, round: 1 } })!;
  assert.equal(round('code').title, 'Kolo review 1 (kód)');
  assert.equal(round('security').title, 'Kolo review 1 (bezpečnost)');
  assert.equal(outboxToProcess({ kind: 'review.round', data: { round: 2 } })!.title, 'Kolo review 2');
});

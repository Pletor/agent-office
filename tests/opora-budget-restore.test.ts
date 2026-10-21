import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecutionDispatch } from '../src/server/opora/execution-dispatch.js';
import { ExecutionClient, ExecutionError } from '../src/server/opora/execution-client.js';
import { executionPrompt } from '../src/server/opora/execution-prompt.js';
import { reportExecution } from '../src/server/opora/execution-worker.js';
import { requestExecutionStop } from '../src/server/opora/execution-stop.js';
import { WorkerManager } from '../src/server/workers.js';
import { newWorker } from '../src/server/workers/worker.js';
import { Ledger, newTracker } from '../src/server/usage.js';
import type { Worker } from '../src/server/workers/types.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { budgetLease, flushBudget } from './support/opora-budget.js';

const info = (id: string) => ({ id, kind: 'shell', via: 'opora', deskId: 'desk-1', name: id,
  color: '#fff', status: 'working', acked: true, createdBy: 'test', createdAt: 0, cols: 80, rows: 24,
  viewers: [], viewerIds: [] }) as WorkerInfo;
function directory(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}

test('v2 helper preserves original capability envelope and validates immutable budget receipt', async t => {
  const dir = directory(t);
  const prompt = executionPrompt(dir, 'http://localhost', 'office', budgetLease());
  assert.match(prompt, /Renewal cannot extend/);
  assert.doesNotMatch(prompt, /PRIVATE-token/);
  const stem = path.join(dir, 'opora-executions', 'execution-1');
  const result = path.join(dir, 'result.json');
  writeFileSync(result, JSON.stringify({ summary: 'Reported only', artifacts: [] }));
  const sent: Record<string, unknown>[] = [];
  let altered = false;
  const transport: typeof fetch = async (_url, options) => {
    sent.push(JSON.parse(String(options?.body)));
    return Response.json({ receiptId: 'safe-receipt', executionId: 'execution-1', state: 'reported',
      executionProtocolVersion: 2, budget: { ...budgetLease().budget!, ...(altered ? { policyHead: 'f'.repeat(40) } : {}) }, token: 'PRIVATE-token' });
  };
  const receipt = await reportExecution(stem + '.json', result, transport);
  await reportExecution(stem + '.json', result, transport);
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['epoch', 'project', 'requestId', 'result', 'token', 'workspace']);
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE-token/);
  assert.doesNotMatch(readFileSync(stem + '-assignment.json', 'utf8'), /PRIVATE-token/);
  altered = true;
  await assert.rejects(reportExecution(stem + '.json', result, transport), /budget receipt/);
});

test('v2 restore keeps original files, revalidates same authority and cannot replace a missing assignment', async t => {
  const dir = directory(t);
  executionPrompt(dir, 'http://localhost', 'office', budgetLease());
  const runs = [{ workerId: 'saved', execution: budgetLease() }];
  const stops: string[] = [];
  const dispatch = new ExecutionDispatch('http://localhost', 'office', dir, () => runs, () => {}, id => stops.push(id));
  let heartbeats = 0;
  dispatch.client.heartbeat = async lease => { heartbeats++; return lease; };
  dispatch.client.claim = async () => { throw new Error('restore must not claim'); };
  assert.equal(await dispatch.guard.restore(info('saved')), undefined);
  assert.equal(heartbeats, 1);
  const assignment = path.join(dir, 'opora-executions', 'execution-1-assignment.json');
  writeFileSync(assignment, JSON.stringify({ live: 'replacement' }));
  assert.match((await dispatch.guard.restore(info('saved')))!, /could not be revalidated/);
  assert.equal(heartbeats, 1);
  assert.deepEqual(stops, ['saved']);
  assert.deepEqual(JSON.parse(readFileSync(assignment, 'utf8')), { live: 'replacement' });
  dispatch.controller.shutdown();
});

test('restored budget run refuses downgraded server without another claim', async t => {
  const dir = directory(t);
  executionPrompt(dir, 'http://localhost', 'office', budgetLease());
  const runs = [{ workerId: 'saved', execution: budgetLease() }];
  const dispatch = new ExecutionDispatch('http://localhost', 'office', dir, () => runs, () => {}, () => {});
  dispatch.client.heartbeat = async () => { throw new ExecutionError(404, true); };
  dispatch.client.claim = async () => { throw new Error('must not downgrade/reclaim'); };
  assert.match((await dispatch.guard.restore(info('saved')))!, /could not be revalidated/);
  assert.equal(dispatch.controller.allowed('saved'), false);
});

test('real WorkerManager keep shutdown requests budgeted PTY stop and retains ordinary hosted PTY', t => {
  const dir = directory(t);
  const manager = new WorkerManager(dir, dir, process.execPath, [], { url: 'http://127.0.0.1:1', token: '' },
    { update() {}, remove() {}, data() {}, screen() {}, toast() {} }, new Ledger(dir, { pauseHiring: false }, () => {}, () => {}));
  const workers = (manager as unknown as { workers: Map<string, Worker> }).workers;
  const stopped: string[] = [];
  for (const id of ['budgeted', 'ordinary']) {
    const worker = newWorker(info(id), newTracker());
    worker.pty = { id: 'host-' + id, pid: 123, kill: () => { stopped.push(id); }, write() {}, resize() {}, onData() {}, onExit() {} };
    workers.set(id, worker);
  }
  const dispatch = new ExecutionDispatch('http://localhost', 'office', dir,
    () => [{ workerId: 'budgeted', execution: budgetLease() }], () => {}, () => {});
  manager.launchGuards.add(dispatch.guard);
  manager.shutdown(true);
  assert.deepEqual(stopped, ['budgeted']);
  assert.equal(workers.size, 2); // Keep saved runs/worktrees; no send-home cleanup is introduced.
});

test('stop projection distinguishes requested, adapter returned and failed without claiming process exit', async () => {
  const run = { state: 'working', error: '' };
  let resolve!: (value: unknown) => void;
  requestExecutionStop(run, 'worker', 'Canvas authority expired', () => new Promise(done => { resolve = done; }), () => {}, () => {});
  assert.match(run.error, /stop requested/);
  resolve({}); await flushBudget();
  assert.match(run.error, /adapter returned; descendant process exit is not verified/);
  const warnings: string[] = [];
  requestExecutionStop(run, 'worker', 'Canvas authority revoked', async () => { throw new Error('PRIVATE-token'); }, () => {}, value => warnings.push(value));
  await flushBudget();
  assert.match(run.error, /adapter failed/);
  assert.doesNotMatch(run.error + warnings.join(), /PRIVATE-token/);
});

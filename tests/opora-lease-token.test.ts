import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExecutionLease } from '../src/server/opora/execution-client.js';
import { ExecutionDispatch } from '../src/server/opora/execution-dispatch.js';
import { reportExecution } from '../src/server/opora/execution-worker.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

// The guard on a Canvas execution's lease token: it is the capability to report a card's result, so
// it lives in one private file only, the 0600 bundle the result helper reads it from. The worker's
// prompt names that file and never holds the token; nothing else the office writes or logs while
// taking a card and handing its result in may carry it, even when Canvas echoes it back.

const TOKEN = 'PRIVATE-lease-token-7f3a';
const scope = { project: 'project', workspace: 'work', nodeId: 'card' };
const lease = (): ExecutionLease => ({ ...scope, executionId: 'execution-1', token: TOKEN, epoch: 7,
  acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64), assignment: { contextVersion: 'context', documents: { card: 'accepted brief' } },
  state: 'running', serverNow: 100, expiresAt: 1000 });

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(full) : [full];
  });
}

test('a lease token stays in the private bundle: not in the prompt, other files, receipts or logs', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-lease-token-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Everything the office prints while it takes the card and the helper reports it.
  const printed: string[] = [];
  const keep = { log: console.log, warn: console.warn, error: console.error, write: process.stderr.write };
  console.log = console.warn = console.error = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  process.stderr.write = ((chunk: unknown) => { printed.push(String(chunk)); return true; }) as typeof process.stderr.write;
  t.after(() => Object.assign(console, { log: keep.log, warn: keep.warn, error: keep.error }));
  t.after(() => { process.stderr.write = keep.write; });

  const dispatch = new ExecutionDispatch('http://localhost', 'office', dir, () => [], () => {}, () => {});
  dispatch.controller.claim = async () => ({ lease: lease(), deadline: performance.now() + 60_000 });
  dispatch.client.release = async () => {};
  t.after(() => dispatch.controller.shutdown());
  let seated = '';
  const taken = await dispatch.dispatch(scope, async () => 'task context', (prompt) => {
    seated = prompt;
    return { id: 'w1', via: 'opora', prompt, status: 'working' } as WorkerInfo;
  }, (prompt) => prompt + '\nREA brief');

  assert.ok(seated.includes(path.join(dir, 'opora-executions', 'execution-1.json')), 'the prompt names the bundle the helper reads');
  assert.doesNotMatch(seated, new RegExp(TOKEN));
  assert.doesNotMatch(JSON.stringify(taken.worker), new RegExp(TOKEN));

  const result = path.join(dir, 'result.json');
  writeFileSync(result, JSON.stringify({ summary: 'Done', artifacts: [] }));
  const receipt = await reportExecution(path.join(dir, 'opora-executions', 'execution-1.json'), result, async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).token, TOKEN, 'the helper still hands the token to Canvas');
    return new Response(JSON.stringify({ receiptId: 'receipt-1', executionId: 'execution-1', state: 'reported', token: TOKEN }));
  }, () => '');
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(TOKEN));

  const holding = filesUnder(dir).filter((f) => readFileSync(f, 'utf8').includes(TOKEN)).map((f) => path.relative(dir, f));
  assert.deepEqual(holding, [path.join('opora-executions', 'execution-1.json')]);
  if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, holding[0])).mode & 0o777, 0o600);
  assert.ok(filesUnder(dir).some((f) => f.endsWith('execution-1-reported.json')), 'the public receipt was written');
  assert.doesNotMatch(printed.join('\n'), new RegExp(TOKEN));
});

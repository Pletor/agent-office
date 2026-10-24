// A failed Take says why: Opora too slow, Opora unreachable, or Opora refusing (with its reason), never a
// catch-all; and Takes made in quick succession wait their turn for the claim instead of failing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ExecutionClient, ExecutionError, executionTimeoutsFromEnvironment, type ExecutionLease } from '../src/server/opora/execution-client.js';
import { ExecutionDispatch } from '../src/server/opora/execution-dispatch.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const scope = { project: 'project', workspace: 'work', nodeId: 'card' };
const lease = (nodeId = 'card', executionId = 'execution-1'): ExecutionLease => ({ ...scope, nodeId, executionId, token: 'PRIVATE-token', epoch: 7,
  acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64), assignment: { contextVersion: 'context' },
  state: 'running', serverNow: 100, expiresAt: 1000 });
const claim = { ...scope, expectedAcceptedHead: 'a'.repeat(40), expectedContextVersion: 'context', requestId: 'r', ttlSeconds: 900 };
const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { assert.ok(error instanceof ExecutionError); return error; }
  assert.fail('expected an ExecutionError');
};

test('timeouts default to 20 s for claims and 15 s for heartbeats, and read seconds from the environment', () => {
  assert.deepEqual(executionTimeoutsFromEnvironment({}), { requestMs: 20_000, heartbeatMs: 15_000 });
  assert.deepEqual(executionTimeoutsFromEnvironment({ AGENT_OFFICE_OPORA_EXECUTION_TIMEOUT_S: '45', AGENT_OFFICE_OPORA_HEARTBEAT_TIMEOUT_S: '9' }),
    { requestMs: 45_000, heartbeatMs: 9_000 });
  assert.deepEqual(executionTimeoutsFromEnvironment({ AGENT_OFFICE_OPORA_EXECUTION_TIMEOUT_S: 'x', AGENT_OFFICE_OPORA_HEARTBEAT_TIMEOUT_S: '999' }),
    { requestMs: 20_000, heartbeatMs: 120_000 });
});

test('a timeout says Opora did not answer in time, and which step it was on', async t => {
  // AbortSignal.timeout doesn't hold the event loop open; the office's server does, this keeps the test's.
  const alive = setInterval(() => {}, 1000); t.after(() => clearInterval(alive));
  const hang: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
  });
  const client = new ExecutionClient('http://localhost', 'office', hang, { requestMs: 50, heartbeatMs: 30 });
  const error = await failure(client.claim(claim));
  assert.match(error.message, /didn’t answer within 50 ms while claiming the card/);
  assert.equal(error.status, 0); assert.equal(error.terminal, false);
  assert.match((await failure(client.context(scope))).message, /within 50 ms while reading the card’s context/);
  // The heartbeat has its own timeout, and never waits longer than what is left of the deadline.
  assert.match((await failure(client.heartbeat(lease(), 900))).message, /within 30 ms while renewing the lease/);
  const started = performance.now();
  await failure(client.heartbeat(lease(), 900, 5));
  assert.ok(performance.now() - started < 1000);
});

test('a network failure names its code and nothing else', async () => {
  const refused: typeof fetch = async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8740 PRIVATE-token'), { code: 'ECONNREFUSED' }) });
  };
  const error = await failure(new ExecutionClient('http://localhost', 'office', refused).claim(claim));
  assert.equal(error.message, 'Opora couldn’t be reached while claiming the card (ECONNREFUSED)');
  assert.equal(error.terminal, false);
  const odd: typeof fetch = async () => { throw new Error('PRIVATE-token'); };
  const other = await failure(new ExecutionClient('http://localhost', 'office', odd).heartbeat(lease(), 900));
  assert.equal(other.message, 'Opora couldn’t be reached while renewing the lease (network error)');
});

test('a refusal carries the status and Canvas detail, with the token blanked out', async () => {
  let body = JSON.stringify({ detail: 'Card is reserved\nby another execution' });
  const conflict: typeof fetch = async () => new Response(body, { status: 409 });
  const client = new ExecutionClient('http://localhost', 'office', conflict);
  const error = await failure(client.claim(claim));
  assert.equal(error.message, 'Opora refused claiming the card (HTTP 409): Card is reserved by another execution');
  assert.equal(error.status, 409); assert.equal(error.terminal, true);
  // The request's own token never comes back in the message.
  body = JSON.stringify({ detail: 'Stale epoch for token PRIVATE-token' });
  const renewal = await failure(client.heartbeat(lease(), 900));
  assert.equal(renewal.message, 'Opora refused renewing the lease (HTTP 409): Stale epoch for token [redacted]');
  body = JSON.stringify({ detail: { message: 'x'.repeat(500) } });
  assert.ok((await failure(client.claim(claim))).message.length < 260);
  body = '<html>busy</html>';
  assert.equal((await failure(client.claim(claim))).message, 'Opora refused claiming the card (HTTP 409)');
  const busy: typeof fetch = async () => new Response('{"detail":"try later"}', { status: 503 });
  const transient = await failure(new ExecutionClient('http://localhost', 'office', busy).claim(claim));
  assert.equal(transient.terminal, false); assert.match(transient.message, /HTTP 503\): try later/);
});

test('two Takes in quick succession both succeed against a slow Canvas, one claim at a time', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-claim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let inFlight = 0, most = 0, claims = 0;
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      const node = url.searchParams.get('nodeId') ?? (raw ? JSON.parse(raw).nodeId : undefined);
      inFlight++; most = Math.max(most, inFlight);
      setTimeout(() => {
        inFlight--;
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname.endsWith('/context')) { res.end(JSON.stringify({ available: true, unavailableReason: null, acceptedHead: 'a'.repeat(40), contextVersion: 'context' })); return; }
        if (url.pathname.endsWith('/claim')) { claims++; res.end(JSON.stringify(lease(node, `execution-${node}`))); return; }
        if (url.pathname.endsWith('/heartbeat')) { const id = url.pathname.split('/').at(-2)!; res.end(JSON.stringify({ ...lease(id.replace('execution-', ''), id), serverNow: 200, expiresAt: 1100 })); return; }
        res.end('{}');
      }, 150);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dispatch = new ExecutionDispatch(base, 'office', dir, () => [], () => {}, () => {});
  t.after(() => dispatch.controller.shutdown());
  let seated = 0;
  const seat = () => ({ id: `w${++seated}`, name: `Worker ${seated}`, via: 'opora', status: 'working', deskId: `desk-${seated}` }) as unknown as WorkerInfo;
  const [first, second] = await Promise.all([
    dispatch.dispatch({ ...scope, nodeId: 'one' }, async () => '', seat),
    dispatch.dispatch({ ...scope, nodeId: 'two' }, async () => '', seat),
  ]);
  assert.equal(first.execution.nodeId, 'one'); assert.equal(second.execution.nodeId, 'two');
  assert.equal(claims, 2);
  assert.equal(most, 1, 'the second claim waited for the first instead of racing it');
  assert.ok(dispatch.controller.allowed('w1') && dispatch.controller.allowed('w2'));
});

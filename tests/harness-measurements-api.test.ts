import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { officeHarness } from '../src/server/harness/api.js';
import type { Ctx } from '../src/server/office/context.js';
import { oporaHarnessTask } from '../src/shared/harness-cascade.js';

function report(project: string, workspace: string, nodeId: string | null) {
  return { schema: 'harness.invocations/1', scope: { project, workspace, nodeId }, authority: 'native-result-receipts',
    evidence: 'worker-reported', serverObserved: false, independentlyVerified: false, causalContribution: false,
    promotionAllowed: false, coverage: 'bounded-newest-receipt-window; repeated calls are not independent trials',
    scannedReceipts: 1, limited: false, receiptWindowLimited: false, cohortsLimited: false, invalidReceipts: 0,
    conflictingInvocations: 0, tokens: null, cost: null, cohorts: [{ resource: 'scripts:check', digest: 'a'.repeat(64),
      adapter: 'node-readonly/1', nodeVersion: 'v24.1.0', problem: 'typescript', invocations: 1, pass: 1, fail: 0,
      percent: 100, meanDurationMs: 7, outputBytes: 10, executions: 1, tasks: 1, latestSourceReceipt: 'receipt-1' }] };
}
async function server(handler: http.RequestListener) {
  const instance = http.createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address() as { port: number };
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => {
    instance.close(() => resolve()); instance.closeAllConnections();
  }) };
}
function office(nativeBase: string) {
  const state = { connected: true, url: nativeBase, project: { id: 'p1' } as { id: string } | undefined,
    workspace: 'draft' as string | undefined };
  let authorized = true;
  const floor = { opora: { view: () => ({ ...state, cards: [] }) },
    workers: { authenticate: (id: string, token: string) => authorized && id === 'w1' && token === 'secret' ? { id } : undefined } };
  const ctx = { workerFloor: (id: string) => id === 'w1' ? floor : undefined } as unknown as Ctx;
  const instance = http.createServer((req, res) => {
    void officeHarness(ctx, req, res, new URL(req.url!, 'http://office.test'));
  });
  return { state, setAuthorized: (v: boolean) => { authorized = v; },
    async listen() {
      await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
      const address = instance.address() as { port: number };
      return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => {
        instance.close(() => resolve()); instance.closeAllConnections();
      }) };
    } };
}
async function call(base: string, query = '?worker=w1&invocations=1', token = 'secret', method = 'GET') {
  return fetch(base + '/office/harness' + query, { method, headers: { authorization: `Bearer ${token}` } });
}

test('authenticated worker reads measurements; auth precedes method and query validation', async () => {
  let nativeCalls = 0;
  const native = await server((_req, res) => { nativeCalls++; res.writeHead(200).end(JSON.stringify(report('p1', 'draft', null))); });
  const app = office(native.base), running = await app.listen();
  try {
    assert.equal((await call(running.base, '?worker=w1&invocations=1', '')).status, 401);
    assert.equal((await call(running.base, '?worker=w1&invocations=1', 'wrong')).status, 401);
    assert.equal((await call(running.base, '?worker=w1&invocations=1&unknown=x')).status, 400);
    assert.equal((await call(running.base, '?worker=w1&invocations=1&resource=x&resource=x')).status, 400);
    assert.equal(nativeCalls, 0);
    const post = await call(running.base, '?worker=w1&invocations=1', 'secret', 'POST');
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('cache-control'), 'no-store');
    const ok = await call(running.base);
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal((await ok.json()).evidence, 'worker-reported');
  } finally { await running.close(); await native.close(); }
});

test('scope filters are floor-derived; foreign task and bad identity are refused before peer access', async () => {
  let query: URL | undefined, nativeCalls = 0;
  const native = await server((req, res) => {
    nativeCalls++;
    query = new URL(req.url!, 'http://canvas.test');
    res.writeHead(200).end(JSON.stringify(report(query.searchParams.get('project')!, query.searchParams.get('workspace')!, query.searchParams.get('nodeId'))));
  });
  const app = office(native.base), running = await app.listen();
  try {
    const foreign = oporaHarnessTask('p2', 'draft', 'card-x');
    assert.equal((await call(running.base, `?worker=w1&invocations=1&task=${encodeURIComponent(foreign)}`)).status, 403);
    const foreignWorkspace = oporaHarnessTask('p1', 'other', 'card-x');
    assert.equal((await call(running.base, `?worker=w1&invocations=1&task=${encodeURIComponent(foreignWorkspace)}`)).status, 403);
    assert.equal((await call(running.base, '?worker=w1&invocations=1&project=p2')).status, 400);
    const malformed = oporaHarnessTask('p1', 'draft', 'bad%2Fnode');
    assert.equal((await call(running.base, `?worker=w1&invocations=1&task=${encodeURIComponent(malformed)}`)).status, 400);
    assert.equal(nativeCalls, 0);
    const task = oporaHarnessTask('p1', 'draft', 'card-1');
    const result = await call(running.base, `?worker=w1&invocations=1&task=${encodeURIComponent(task)}&resource=scripts%3Acheck`);
    assert.equal(result.status, 200);
    assert.equal(query?.searchParams.get('project'), 'p1');
    assert.equal(query?.searchParams.get('workspace'), 'draft');
    assert.equal(query?.searchParams.get('nodeId'), 'card-1');
    assert.equal(query?.searchParams.get('resource'), 'scripts:check');
  } finally { await running.close(); await native.close(); }
});

test('disconnected or unavailable Canvas returns unavailable measurements, never empty success', async () => {
  const native = await server((_req, res) => res.writeHead(404).end('private endpoint detail'));
  const app = office(native.base), running = await app.listen();
  try {
    app.state.connected = false;
    const disconnected = await call(running.base);
    assert.equal(disconnected.status, 200);
    assert.equal((await disconnected.json()).status, 'unavailable');
    app.state.connected = true;
    const down = await call(running.base);
    assert.equal(down.status, 200);
    const body = await down.text();
    assert.match(body, /"status":"unavailable"/); assert.doesNotMatch(body, /private endpoint detail/);
  } finally { await running.close(); await native.close(); }
});

test('peer change and worker revocation during the await invalidate the response', async () => {
  let mutate: (() => void) | undefined;
  const native = await server((_req, res) => {
    mutate?.(); mutate = undefined;
    res.writeHead(200).end(JSON.stringify(report('p1', 'draft', null)));
  });
  const app = office(native.base), running = await app.listen();
  try {
    mutate = () => { app.state.workspace = 'other'; };
    assert.equal((await call(running.base)).status, 409);
    app.state.workspace = 'draft';
    mutate = () => { app.setAuthorized(false); };
    assert.equal((await call(running.base)).status, 401);
  } finally { await running.close(); await native.close(); }
});

test('native redirects are refused and hook bearer credentials are not forwarded', async () => {
  let leaked: string | undefined, targetCalls = 0;
  const target = await server((_req, res) => { targetCalls++; res.writeHead(200).end(JSON.stringify(report('p1', 'draft', null))); });
  const redirect = await server((req, res) => { leaked = req.headers.authorization; res.writeHead(302, { location: target.base + '/capture' }).end(); });
  const app = office(redirect.base), running = await app.listen();
  try {
    const response = await call(running.base);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /"status":"unavailable"/);
    assert.equal(leaked, undefined);
    assert.equal(targetCalls, 0);
  } finally { await running.close(); await redirect.close(); await target.close(); }
});

test('a hanging native peer times out to an unavailable response', async () => {
  const native = await server(() => { /* Deliberately never send headers or a body. */ });
  const app = office(native.base), running = await app.listen();
  const started = Date.now();
  try {
    const response = await call(running.base);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'unavailable');
    assert.ok(Date.now() - started < 8000);
  } finally { await running.close(); await native.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { context7, CONTEXT7_ENDPOINT, documentationQuery } from '../src/server/harness/context7.js';
import http from 'node:http';
import type { Ctx } from '../src/server/office/context.js';
import { officeHarness } from '../src/server/harness/api.js';

function transport(options: { sse?: boolean; version?: string; toolError?: boolean; large?: boolean; missing?: boolean; wrongID?: boolean } = {}) {
  const calls: { method: string; params: any; headers: Record<string, string> }[] = [];
  let cancelled = false;
  let terminated = false;
  const read: typeof fetch = async (url, init) => {
    assert.equal(url, CONTEXT7_ENDPOINT); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    if (init?.method === 'DELETE') { terminated = true; return new Response(null, { status: 204 }); }
    const { method, params, id } = JSON.parse(String(init?.body));
    calls.push({ method, params, headers: { ...init?.headers as Record<string, string> } });
    const result = method === 'initialize' ? { protocolVersion: options.version ?? '2025-06-18' }
      : method === 'tools/list' ? { tools: options.missing ? [] : [{ name: 'query-docs' }, { name: 'resolve-library-id' }] }
      : { isError: !!options.toolError, content: [{ type: 'text', text: options.large ? 'x'.repeat(70 * 1024) : 'Public documentation č.' }] };
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    const body = JSON.stringify({ jsonrpc: '2.0', id: options.wrongID ? 999 : id, result });
    if (options.sse) {
      const bytes = new TextEncoder().encode(': heartbeat\r\n\r\ndata: ' + body + '\r\n\r\n');
      let index = 0;
      return new Response(new ReadableStream({ pull(controller) { if (index < bytes.length) controller.enqueue(bytes.slice(index, index += 7)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'test-session' } });
    }
    return new Response(body, { headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-session' } });
  };
  return { read, calls, cancelled: () => cancelled, terminated: () => terminated };
}

test('Context7 performs real protocol steps, preserves version ID and hashes exact reference content', async () => {
  const fixture = transport();
  const result = await context7({ action: 'query', library: '/nodejs/node/v22.0.0', query: 'How does AbortSignal.timeout work?' }, { read: fixture.read, apiKey: 'test-key' });
  assert.deepEqual(fixture.calls.map(call => call.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.equal(fixture.calls[3].params.arguments.libraryId, '/nodejs/node/v22.0.0');
  assert.equal(fixture.calls[3].headers['mcp-session-id'], 'test-session');
  assert.equal(fixture.calls[3].headers.authorization, 'Bearer test-key');
  assert.equal(result.authority, 'external-reference');
  assert.equal(result.digest, createHash('sha256').update(result.text).digest('hex'));
  assert.ok(!JSON.stringify(result).includes('test-key'));
  assert.ok(!JSON.stringify(result).includes('test-session'));
  assert.equal(fixture.terminated(), true);
});
test('SSE result stops a still-open stream and resolution uses the library name', async () => {
  const fixture = transport({ sse: true });
  const result = await context7({ action: 'resolve', library: 'TypeScript', query: 'Strict type narrowing' }, { read: fixture.read });
  assert.equal(fixture.calls[3].params.arguments.libraryName, 'TypeScript'); assert.equal(fixture.cancelled(), true);
  assert.equal(result.tool, 'resolve-library-id');
});
test('bad inputs never call the network; unsupported tools/protocol and oversized/error results fail', async () => {
  for (const value of [null, { action: 'query', library: 'node', query: 'API?' }, { action: 'resolve', library: 'node', query: 'api_key=not-a-public-question' }, { action: 'resolve', library: 'node', query: 'x', endpoint: 'http://elsewhere' }]) assert.throws(() => documentationQuery(value));
  for (const options of [{ version: 'future' }, { missing: true }, { toolError: true }, { large: true }, { wrongID: true }]) {
    await assert.rejects(context7({ action: 'resolve', library: 'node', query: 'Streams?' }, { read: transport(options).read }));
  }
  let calls = 0;
  await assert.rejects(context7({ action: 'resolve', library: 'node', query: 'Streams?' }, { read: async () => { calls++; return new Response('private upstream details', { status: 429 }); } }), /rate limit/);
  assert.equal(calls, 1, 'no hidden retry or fallback');
});
test('worker documentation calls require hook authentication and obey their request budget', async t => {
  const fixture = transport(), realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', fixture.read);
  const floor = { id: 'docs-test', workers: { authenticate: (_: string, token: string) => token === 'hook-test' ? {} : undefined } };
  const ctx = { workerFloor: () => floor } as unknown as Ctx;
  const server = http.createServer((req, res) => void officeHarness(ctx, req, res, new URL(req.url!, 'http://x')));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/office/harness?worker=ordinary&docs=1';
  const call = (body?: unknown, token = 'hook-test') => realFetch(url, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await call(undefined, 'bad')).status, 401); assert.equal(fixture.calls.length, 0);
  assert.equal((await call()).status, 405);
  const response = await call({ action: 'resolve', library: 'node', query: 'Streams?' });
  assert.equal(response.status, 200); assert.equal((await response.json()).authority, 'external-reference');
  assert.ok(fixture.calls.every(call => call.headers.authorization !== 'Bearer hook-test'), 'worker token never leaves Office');
  for (let i = 0; i < 7; i++) assert.equal((await call({ invalid: true })).status, 400);
  assert.equal((await call({ invalid: true })).status, 429);
  assert.equal(fixture.calls.length, 4, 'invalid or budget-limited requests never reach Context7');
});

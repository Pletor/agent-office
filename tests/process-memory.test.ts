import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { memoryRecall, memoryStatus, oporaBase, readOpora, recallPayload } from '../src/server/process-memory/client.js';
import { processMemoryRoutes } from '../src/server/http/routes/process-memory.js';
import type { Ctx } from '../src/server/office/context.js';

test('Opora target is fixed to a credential-free loopback origin', () => {
  assert.equal(oporaBase('http://localhost:8740').hostname, '127.0.0.1');
  for (const value of ['https://127.0.0.1', 'http://example.com', 'http://127.0.0.1@evil.test', 'http://user:key@localhost', 'http://localhost/api', 'http://localhost?secret=1', 'http://localhost/#x']) assert.throws(() => oporaBase(value));
});
test('recall accepts only a role, query and optional explicit Opora project identity', () => {
  const input = { role: 'role-backend', query: ' reconnect ', project: '' };
  assert.deepEqual(recallPayload(input), { role: 'role-backend', query: 'reconnect', project: null, workspace: null, nodeId: null, maxTokens: 2000 });
  for (const invalid of [{ ...input, query: '' }, { ...input, query: 'x'.repeat(2001) }, { ...input, role: '../admin' }, { ...input, project: 'repo/path' }, { ...input, url: 'http://evil.test' }]) assert.throws(() => recallPayload(invalid));
});
test('adapter allowlists response fields and bounds content without inventing success', () => {
  const status = memoryStatus({ status: 'needs_provisioning', reason: 'missing', api_key: 'secret', missingRoles: ['role-tests'] }, { roles: [{ id: 'role-tests', label: 'Tests', description: 'checks', key: 'secret' }] });
  assert.equal(status.status, 'needs_provisioning'); assert(!JSON.stringify(status).includes('secret'));
  assert.throws(() => memoryStatus({ status: 'fine' }, { roles: [] }));
  const result = memoryRecall({ status: 'configured', items: Array.from({ length: 22 }, () => ({ uri: 'viking://x', text: 'x'.repeat(9000), score: 1, origin: 'self', key: 'secret' })) }, 'role-tests');
  assert(result.truncated); assert.equal(result.items.length, 20); assert.equal(result.items.reduce((n, i) => n + i.text.length, 0), 16000); assert(!JSON.stringify(result).includes('secret'));
});
test('HTTP adapter rejects redirects and large responses and sends the required Opora Origin', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/memory/status') { res.writeHead(302, { location: 'http://example.com' }); res.end(); }
    else if (req.url === '/api/memory/roles') res.end('x'.repeat(512 * 1024 + 1));
    else { assert.equal(req.headers.origin, `http://127.0.0.1:${(server.address() as { port: number }).port}`); res.end(JSON.stringify({ status: 'configured', items: [] })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = oporaBase(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await assert.rejects(readOpora(base, '/api/memory/status'));
  await assert.rejects(readOpora(base, '/api/memory/roles'));
  assert.deepEqual(await readOpora(base, '/api/memory/recall', { query: 'test' }), { status: 'configured', items: [] });
});
test('memory routes require admin sessions and same-origin recall', async t => {
  const old = process.env.OPORA_CONTROL_CENTER_URL; delete process.env.OPORA_CONTROL_CENTER_URL;
  t.after(() => { if (old === undefined) delete process.env.OPORA_CONTROL_CENTER_URL; else process.env.OPORA_CONTROL_CENTER_URL = old; });
  const server = http.createServer((req, res) => {
    const route = req.method === 'POST' ? processMemoryRoutes[1] : processMemoryRoutes[0];
    const ctx = { cfg: { trustProxy: false } } as Ctx;
    const session = req.headers['x-test-member'] ? { account: { role: 'member' } } : {};
    void route.handle(ctx, { req, res, session } as Parameters<typeof route.handle>[1]);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await fetch(url, { headers: { 'x-test-member': '1' } })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { origin: 'http://evil.test' } })).status, 403);
  assert.equal((await (await fetch(url)).json()).status, 'not_configured');
  assert(processMemoryRoutes.every(route => route.auth === 'session'));
});

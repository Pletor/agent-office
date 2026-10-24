import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { handleMcp } from '../bin/office-workers.js';
import { codexMcpArgs } from '../src/server/office-workers.js';

const env = { AGENT_OFFICE_HARNESS_MCP: '1', AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:4455', AGENT_OFFICE_WORKER_ID: 'worker-a', AGENT_OFFICE_HOOK_TOKEN: 'fixture-token' };
const call = (name: string, args: unknown, read: typeof fetch = fetch, credentials = env) => handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { env: credentials, fetch: read });
const kit = { evidence: 'accepted-selection-only', execution: { contextProtocolVersion: 2 }, kit: { resources: [] }, invocationObserved: false };

test('Codex MCP environment selection preserves explicit opt-in without enabling it by default', () => {
  const values = codexMcpArgs('bin/office-workers.js');
  const names: string[] = JSON.parse(values.find(value => value.startsWith('mcp_servers.agent-office.env_vars='))!.split('=')[1]);
  for (const enabled of [false, true]) {
    const source: NodeJS.ProcessEnv = { ...env, AGENT_OFFICE_HARNESS_MCP: enabled ? '1' : undefined };
    const forwarded = Object.fromEntries(names.filter(name => source[name] !== undefined).map(name => [name, source[name]]));
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP']) if (process.env[name]) forwarded[name] = process.env[name];
    const response = JSON.parse(execFileSync(process.execPath, ['bin/office-workers.js', 'mcp'], {
      env: forwarded, encoding: 'utf8', timeout: 10_000,
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n',
    }));
    assert.equal(response.result.tools.some((tool: any) => tool.name === 'harness_accepted_kit'), enabled);
  }
});

test('Harness tools are registered with the existing Office MCP server', async () => {
  const result = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { env, fetch });
  assert.ok(result.result.tools.some((tool: any) => tool.name === 'list_workers'));
  assert.ok(result.result.tools.some((tool: any) => tool.name === 'harness_accepted_kit'));
  assert.ok(result.result.tools.some((tool: any) => tool.name === 'harness_documentation'));
  const disabled = { ...env, AGENT_OFFICE_HARNESS_MCP: '' };
  assert.equal((await call('harness_accepted_kit', {}, fetch, disabled)).error.code, -32602);
});

test('accepted documentation uses only authenticated identity and pinned resource, never a caller URL or library', async () => {
  const reads: { url: URL; init: RequestInit }[] = [];
  const read = (async (url: any, init: any) => {
    reads.push({ url: new URL(url), init });
    return Response.json({ schema: 'harness.documentation/1', accepted: { authorityCurrentAtCompletion: true }, promotionAllowed: false });
  }) as typeof fetch;
  const response = await call('harness_documentation', { resource: 'mcp:node-docs', query: 'AbortSignal timeout' }, read);
  assert.equal(response.result.isError, undefined);
  assert.equal(reads[0].url.pathname, '/office/harness');
  assert.equal(reads[0].url.searchParams.get('worker'), 'worker-a');
  assert.equal(reads[0].url.searchParams.get('docs'), '1');
  assert.equal(reads[0].init.redirect, 'error');
  assert.equal((reads[0].init.headers as Record<string,string>).authorization, 'Bearer fixture-token');
  assert.deepEqual(JSON.parse(reads[0].init.body as string), { action: 'accepted-query', resource: 'mcp:node-docs', query: 'AbortSignal timeout' });
  for (const args of [null, [], { resource: 'x', query: 'x', library: '/other/version' }, { resource: 'x', query: 'x', worker: 'other' }, { resource: 'x', query: '\n' }, { resource: 'x', query: 'x'.repeat(1001) }]) {
    assert.equal((await call('harness_documentation', args, read)).result.isError, true);
  }
  assert.equal(reads.length, 1);
});

test('missing credentials, refused authority, old runtime and oversized replies cannot look successful', async () => {
  let calls = 0;
  const read = (async () => { calls++; return Response.json(kit); }) as typeof fetch;
  assert.equal((await call('harness_accepted_kit', {}, read, { ...env, AGENT_OFFICE_HOOK_TOKEN: '' })).result.isError, true);
  assert.equal((await call('harness_accepted_kit', { task: 'another' }, read)).result.isError, true);
  assert.equal(calls, 0);
  for (const status of [401, 409, 429, 503]) {
    const denied = await call('harness_accepted_kit', {}, (async () => new Response('fixture-token must not leak', { status })) as typeof fetch);
    assert.equal(denied.result.isError, true);
    assert.doesNotMatch(denied.result.content[0].text, /fixture-token/);
  }
  for (const response of [Response.json({ effective: {} }), Response.json({ schema: 'harness.documentation/1' }), new Response('x'.repeat(256 * 1024 + 1))]) {
    assert.equal((await call('harness_accepted_kit', {}, (async () => response) as typeof fetch)).result.isError, true);
  }
  assert.equal((await call('harness_documentation', { resource: 'mcp:x', query: 'public' }, (async () => Response.json({ schema: 'harness.documentation/1' })) as typeof fetch)).result.isError, true);
});

test('real Office MCP stdio process forwards worker credentials to the Harness HTTP route', async t => {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url!);
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(kit));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const child = spawn(process.execPath, ['bin/office-workers.js', 'mcp'], { env: { ...process.env, ...env, AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:' + (server.address() as any).port }, stdio: ['pipe','pipe','pipe'] });
  t.after(() => child.kill());
  const timer = setTimeout(() => child.kill(), 10_000); t.after(() => clearTimeout(timer));
  let output = '', errors = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk);
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'harness_accepted_kit', arguments: {} } }) + '\n');
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, errors);
  const result = JSON.parse(output); assert.equal(result.id, 7); assert.equal(result.result.isError, undefined);
  assert.deepEqual(JSON.parse(result.result.content[0].text), kit);
  assert.deepEqual(seen, ['/office/harness?worker=worker-a&accepted-kit=1']);
});

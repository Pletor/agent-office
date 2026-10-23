import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'office-harness.js');
const task = 'opora:p1:draft:card-1';
const report = { schema: 'harness.invocations/1', scope: { project: 'p1', workspace: 'draft', nodeId: 'card-1' },
  authority: 'native-result-receipts', evidence: 'worker-reported', serverObserved: false, independentlyVerified: false,
  causalContribution: false, promotionAllowed: false, coverage: 'bounded-newest-receipt-window; repeated calls are not independent trials',
  scannedReceipts: 1, limited: false, receiptWindowLimited: false, cohortsLimited: false, invalidReceipts: 0,
  conflictingInvocations: 0, tokens: null, cost: null, cohorts: [{ resource: 'scripts:check', digest: 'a'.repeat(64),
    adapter: 'node-readonly/1', nodeVersion: 'v24.1.0', problem: 'typescript', invocations: 1, pass: 1, fail: 0,
    percent: 100, meanDurationMs: 7, outputBytes: 10, executions: 1, tasks: 1, latestSourceReceipt: 'receipt-1' }] };

async function run(args: string[], env: NodeJS.ProcessEnv) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], { cwd: root, env, timeout: 10_000, maxBuffer: 256 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
async function server(handler: http.RequestListener) {
  const instance = http.createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => {
    instance.close(() => resolve()); instance.closeAllConnections();
  }) };
}

test('CLI sends namespaced task/resource through worker hook and prints worker-reported measurements', async () => {
  let seenUrl = '', seenAuthorization = '';
  const peer = await server((req, res) => {
    seenUrl = req.url ?? ''; seenAuthorization = req.headers.authorization ?? '';
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(report));
  });
  try {
    const env = { ...process.env, AGENT_OFFICE_HOOK_URL: peer.url, AGENT_OFFICE_WORKER_ID: 'w1', AGENT_OFFICE_HOOK_TOKEN: 'secret' };
    const result = await run(['--invocations', '--task', task, '--resource', 'scripts:check'], env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(seenAuthorization, 'Bearer secret');
    const url = new URL(seenUrl, peer.url);
    assert.equal(url.pathname, '/office/harness');
    assert.equal(url.searchParams.get('worker'), 'w1'); assert.equal(url.searchParams.get('invocations'), '1');
    assert.equal(url.searchParams.get('task'), task); assert.equal(url.searchParams.get('resource'), 'scripts:check');
    assert.equal(JSON.parse(result.stdout).evidence, 'worker-reported');
    assert.doesNotMatch(result.stdout + result.stderr, /secret/);
  } finally { await peer.close(); }
});

test('CLI rejects unknown arguments and cannot fall back to a local catalog without hook credentials', async () => {
  let calls = 0;
  const peer = await server((_req, res) => { calls++; res.writeHead(200).end(JSON.stringify(report)); });
  const env = { ...process.env };
  delete env.AGENT_OFFICE_HOOK_URL; delete env.AGENT_OFFICE_HOOK_TOKEN; delete env.AGENT_OFFICE_WORKER_ID;
  const unknown = await run(['--invocations', '--unexpected'], env);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /Usage: office-harness/);
  const localFallback = await run(['--invocations'], env);
  assert.notEqual(localFallback.code, 0);
  assert.match(localFallback.stderr, /Usage: office-harness/);
  assert.doesNotMatch(unknown.stderr + localFallback.stderr, /secret|token/i);
  try {
    const hookEnv = { ...env, AGENT_OFFICE_HOOK_URL: peer.url, AGENT_OFFICE_WORKER_ID: 'w1', AGENT_OFFICE_HOOK_TOKEN: 'secret' };
    const unknownWithHook = await run(['--invocations', '--unexpected'], hookEnv);
    assert.notEqual(unknownWithHook.code, 0);
    assert.match(unknownWithHook.stderr, /Usage: office-harness/);
    assert.equal(calls, 0);
  } finally { await peer.close(); }
});

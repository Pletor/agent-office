import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acceptedReceipt, invokeNode } from '../src/server/harness/invoke-node.js';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const script = (content: string, requires = ['command:node']) => ({ resource: 'el:project:runner', category: 'scripts', content, digest: sha(content), requires });
function receipt(content: string, requires?: string[]) {
  const resource = script(content, requires);
  return { execution: { executionId: '00000000-0000-4000-8000-000000000001', epoch: 4, project: 'project-1', workspace: 'workspace-1', nodeId: 'node-1',
    acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64) },
    kit: { schema: 'harness.kit/1', resources: [resource] } };
}
async function temp(t: { after(fn: () => void): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'harness-invocation-test-'));
  t.after(() => { void rm(dir, { recursive: true, force: true }); });
  return dir;
}

test('runs the exact pinned script with arguments under Node permission mode and keeps only worker-local env', async (t) => {
  const previous = process.env.AGENT_OFFICE_HOOK_TOKEN;
  process.env.AGENT_OFFICE_HOOK_TOKEN = 'test-private-token';
  t.after(() => { if (previous === undefined) delete process.env.AGENT_OFFICE_HOOK_TOKEN; else process.env.AGENT_OFFICE_HOOK_TOKEN = previous; });
  const root = await temp(t);
  const accepted = receipt("console.log(JSON.stringify({args:process.argv.slice(2),hook:process.env.AGENT_OFFICE_HOOK_TOKEN||null,nodeOptions:process.env.NODE_OPTIONS||null,env:Object.keys(process.env)}))");
  const result = await invokeNode(async () => accepted, 'el:project:runner', ['two words', '7'], process.cwd(), { tempRoot: root });
  assert.equal(result.reason, 'completed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, 'pass');
  assert.deepEqual(JSON.parse(result.stdout).args, ['two words', '7']);
  assert.equal(JSON.parse(result.stdout).hook, null);
  assert.equal(JSON.parse(result.stdout).nodeOptions, null);
  assert.equal(JSON.parse(result.stdout).env.includes('AGENT_OFFICE_HOOK_TOKEN'), false);
  assert.equal(JSON.parse(result.stdout).env.includes('NODE_OPTIONS'), false);
  assert.equal(result.authorityCurrentAtCompletion, true);
  assert.equal(result.cleanupComplete, true);
  assert.deepEqual(await readdir(root), []);
});

test('reports nonzero exit, enforces output and timeout limits, and blocks child processes and filesystem writes', async (t) => {
  const nonzero = await invokeNode(async () => receipt("console.log('ran'); process.exit(7)"), 'el:project:runner', [], process.cwd());
  assert.equal(nonzero.exitCode, 7);
  assert.equal(nonzero.reason, 'nonzero-exit');
  assert.equal(nonzero.outcome, 'fail');

  const output = await invokeNode(async () => receipt("process.stdout.write('x'.repeat(100000))"), 'el:project:runner', [], process.cwd(), { timeoutMs: 5000, pollMs: 20 });
  assert.equal(output.reason, 'output-limit');
  assert.ok(output.outputBytes > 64 * 1024);
  assert.ok(Buffer.byteLength(output.stdout) <= 64 * 1024);

  const timeout = await invokeNode(async () => receipt('for (;;) {}'), 'el:project:runner', [], process.cwd(), { timeoutMs: 150, pollMs: 20 });
  assert.equal(timeout.reason, 'timeout');
  assert.equal(timeout.outcome, 'fail');

  const denied = await invokeNode(async () => receipt("import {spawnSync} from 'node:child_process'; import {writeFileSync} from 'node:fs'; let child='allowed', file='allowed'; try { spawnSync(process.execPath,['-e','']); } catch(e) { child=e.code; } try { writeFileSync(process.env.TMP+'/blocked','x'); } catch(e) { file=e.code; } console.log(JSON.stringify({child,file}))"), 'el:project:runner', [], process.cwd());
  assert.equal(denied.exitCode, 0);
  assert.deepEqual(JSON.parse(denied.stdout), { child: 'ERR_ACCESS_DENIED', file: 'ERR_ACCESS_DENIED' });
});

test('checks lease identity before spawn and while the child is running; cleans scratch files', async (t) => {
  const root = await temp(t);
  const accepted = receipt('for (;;) {}');
  let beforeReads = 0;
  await assert.rejects(invokeNode(async () => {
    beforeReads++;
    return beforeReads === 1 ? accepted : { ...accepted, execution: { ...accepted.execution, acceptedRevision: 'c'.repeat(40) } };
  }, 'el:project:runner', [], process.cwd(), { tempRoot: root }), /changed before tool launch/);
  assert.deepEqual(await readdir(root), [], 'stale authority is rejected and temp files are removed before spawning');

  let liveReads = 0;
  const changed = await invokeNode(async () => {
    liveReads++;
    return liveReads < 3 ? accepted : { ...accepted, execution: { ...accepted.execution, acceptedRevision: 'd'.repeat(40) } };
  }, 'el:project:runner', [], process.cwd(), { tempRoot: root, timeoutMs: 5000, pollMs: 20 });
  assert.equal(changed.reason, 'execution-changed');
  assert.equal(changed.authorityCurrentAtCompletion, false);
  assert.equal(changed.outcome, 'fail');
  assert.equal(changed.cleanupComplete, true);
  assert.deepEqual(await readdir(root), []);
});

test('real CLI reads only authenticated accepted kit; transport refuses redirects and oversized receipts', async t => {
  let mode = 'ok', requests = 0;
  const value = receipt('console.log(JSON.stringify(process.argv.slice(2)))');
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.headers.authorization, 'Bearer test-hook');
    assert.equal(new URL(req.url!, 'http://x').searchParams.get('worker'), 'worker-1');
    if (mode === 'redirect') { res.writeHead(302, { location: '/leak' }); res.end(); return; }
    if (mode === 'large') { res.end('x'.repeat(130 * 1024)); return; }
    if (mode === 'gone') { res.writeHead(409); res.end('unavailable'); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const result = await promisify(execFile)(process.execPath, ['bin/office-harness.js', '--invoke-node', 'el:project:runner', '--', 'two words'], {
    env: { ...process.env, AGENT_OFFICE_HOOK_URL: base, AGENT_OFFICE_WORKER_ID: 'worker-1', AGENT_OFFICE_HOOK_TOKEN: 'test-hook' },
  });
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.outcome, 'pass');
  assert.deepEqual(JSON.parse(observed.stdout), ['two words']);
  assert.equal(observed.independentlyVerified, false);
  assert.equal(observed.promotionAllowed, false);
  assert.ok(requests >= 3, 'initial, pre-spawn and completion checks all use current authority');
  mode = 'redirect'; const before = requests;
  await assert.rejects(acceptedReceipt(base, 'worker-1', 'test-hook'));
  assert.equal(requests, before + 1, 'credential request never follows redirects');
  mode = 'large'; await assert.rejects(acceptedReceipt(base, 'worker-1', 'test-hook'), /invalid/);
  mode = 'gone'; await assert.rejects(acceptedReceipt(base, 'worker-1', 'test-hook'), /unavailable/);
});

test('rejects digest mismatch and unsupported requirements before starting Node', async () => {
  const badDigest = receipt("console.log('not run')");
  badDigest.kit!.resources[0].digest = '0'.repeat(64);
  await assert.rejects(invokeNode(async () => badDigest, 'el:project:runner', [], process.cwd()), /unavailable or invalid/);
  await assert.rejects(invokeNode(async () => receipt("console.log('not run')", ['command:node', 'network']), 'el:project:runner', [], process.cwd()), /exactly command:node/);
});

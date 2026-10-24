import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('worker CLI forwards explicit v2, preserves defaults and refuses downgrade or ambiguous flags', async t => {
  let calls = 0, mode = 'ok';
  const server = http.createServer((req, res) => {
    calls++; const url = new URL(req.url!, 'http://local');
    assert.equal(req.headers.authorization, 'Bearer isolated-cli');
    assert.equal(url.searchParams.get('worker'), 'worker');
    assert.equal(url.searchParams.get('problem'), 'build');
    res.setHeader('content-type', 'application/json');
    const schema = url.searchParams.get('kitSchema');
    res.end(JSON.stringify({ kit: mode === 'blocked' ? null : { schema: mode === 'old' ? 'harness.kit/1' : schema ?? 'harness.kit/1' },
      capabilities: url.searchParams.getAll('capability'), task: url.searchParams.get('task') }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const env = { ...process.env, AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    AGENT_OFFICE_WORKER_ID: 'worker', AGENT_OFFICE_HOOK_TOKEN: 'isolated-cli' };
  const run = (args: string[], environment: NodeJS.ProcessEnv = env) => promisify(execFile)(process.execPath,
    ['bin/office-harness.js', '--recommend', 'build', ...args], { env: environment, timeout: 10000 });
  const plain = JSON.parse((await run([])).stdout); assert.equal(plain.kit.schema, 'harness.kit/1');
  const flags = ['--capability', 'command:node', '--kit-schema', 'harness.kit/2', '--task', 'opora:p:w:n'];
  const output = JSON.parse((await run(flags)).stdout);
  assert.equal(output.kit.schema, 'harness.kit/2'); assert.deepEqual(output.capabilities, ['command:node']);
  assert.equal(output.task, 'opora:p:w:n');
  mode = 'old'; await assert.rejects(run(flags), /no downgrade is allowed/);
  mode = 'blocked'; assert.equal(JSON.parse((await run(flags)).stdout).kit, null);
  const before = calls;
  for (const args of [['--kit-schema'], ['--kit-schema', 'harness.kit/99'],
    ['--kit-schema', 'harness.kit/2', '--kit-schema', 'harness.kit/1']]) await assert.rejects(run(args), /Usage/);
  assert.equal(calls, before, 'invalid arguments never reach the Office');
  const local = { ...env }; delete (local as NodeJS.ProcessEnv).AGENT_OFFICE_HOOK_URL;
  await assert.rejects(run(['--kit-schema', 'harness.kit/2'], local), /requires a connected worker Office/);
  assert.equal(calls, before);
});

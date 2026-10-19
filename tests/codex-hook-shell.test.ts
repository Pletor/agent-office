import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { CODEX_HOOK_EVENTS, codexHookArgs, writeCodexHook } from '../src/server/codex.js';

test('hook command quoting is explicit and preserves POSIX behavior', () => {
  const file = "/tmp/office's data/hook.cjs";
  const command = (platform: NodeJS.Platform) => {
    const match = codexHookArgs(file, platform)[1].match(/command=("(?:[^"\\]|\\.)*")/);
    assert.ok(match);
    return JSON.parse(match[1]) as string;
  };
  assert.equal(command('linux'), [process.execPath, file, 'SessionStart']
    .map(value => `'${value.replaceAll("'", "'\"'\"'")}'`).join(' '));
  assert.match(command('win32'), /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.equal(Buffer.from(command('win32').split(' ').at(-1)!, 'base64').toString('utf16le'),
    `& '${process.execPath.replaceAll("'", "''")}' '/tmp/office''s data/hook.cjs' 'SessionStart'; exit $LASTEXITCODE`);
});

test('generated hook commands reach the bridge through the native shell', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "office hook's & $literal %PATH% ; "));
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(200).end(); });
  });
  try {
    const file = writeCodexHook(dir);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const args = codexHookArgs(file);
    for (let i = 0; i < CODEX_HOOK_EVENTS.length; i++) {
      const encoded = args[i * 2 + 1].match(/command=("(?:[^"\\]|\\.)*")/);
      assert.ok(encoded);
      const command: string = JSON.parse(encoded[1]);
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
      const shellArgs = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
      const child = spawn(shell, shellArgs, {
        windowsHide: true,
        env: { ...process.env, AGENT_OFFICE_HOOK_URL: `http://127.0.0.1:${address.port}`,
          AGENT_OFFICE_HOOK_TOKEN: 'fixture-token', AGENT_OFFICE_WORKER_ID: 'fixture-worker' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
        let out = ''; let err = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('hook launch timed out')); }, 5000);
        child.stdout.on('data', chunk => { out += chunk; });
        child.stderr.on('data', chunk => { err += chunk; });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify({ session_id: 'fixture-session' }));
      });
      assert.equal(result.code, 0, result.err);
      assert.equal(result.out.trim(), '{}', result.err);
      assert.deepEqual(received[i], { session_id: 'fixture-session', hook_event_name: CODEX_HOOK_EVENTS[i] });
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

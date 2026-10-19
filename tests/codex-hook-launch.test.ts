import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as pty from '@lydell/node-pty';
import { codexHookArgs } from '../src/server/codex.js';

test('Windows npm shim preserves every Codex hook config argument through the office PTY',
  { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'office codex shim '));
    const args = codexHookArgs(path.join(dir, 'office hook.cjs'));
    const fixture = path.join(dir, 'argv.cjs');
    const shim = path.join(dir, 'codex.cmd');
    writeFileSync(fixture, "console.log('ARGV:' + Buffer.from(JSON.stringify(process.argv.slice(2))).toString('base64'));\n");
    writeFileSync(shim, `@ECHO off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
    let terminal: pty.IPty | undefined;
    try {
      const result = await new Promise<{code: number; data: string}>((resolve, reject) => {
        terminal = pty.spawn(shim, args, {cwd: dir, cols: 30000, rows: 30, env: process.env as Record<string,string>});
        let data = '';
        const timer = setTimeout(() => {terminal?.kill(); reject(Error('shim timeout'));}, 10000);
        terminal.onData(chunk => {data += chunk;});
        terminal.onExit(({exitCode}) => {clearTimeout(timer); resolve({code:exitCode, data});});
      });
      assert.equal(result.code, 0, result.data);
      const match = result.data.match(/ARGV:([A-Za-z0-9+/=]+)/);
      assert.ok(match, 'fixture did not receive argv');
      assert.deepEqual(JSON.parse(Buffer.from(match[1], 'base64').toString()), args);
    } finally { terminal?.kill(); rmSync(dir, {recursive:true, force:true}); }
  });

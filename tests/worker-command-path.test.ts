import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { prependOfficeCommandPath } from '../src/server/workers/command-path.js';

test('Office paths preserve native and MSYS lists without changing shell policy or Unix originals', () => {
  const env = { Path: 'C:\\Windows', PATH: 'duplicate', ORIGINAL_PATH: '/usr/bin:/c/tools', MSYS2_PATH_TYPE: 'inherit', TOKEN: 'unchanged' };
  prependOfficeCommandPath(env, 'C:\\Office space\\bin', true);
  assert.equal(env.Path, 'C:\\Office space\\bin;C:\\Windows');
  assert.equal(env.ORIGINAL_PATH, '/c/Office space/bin:/usr/bin:/c/tools');
  assert.equal(Object.hasOwn(env, 'PATH'), false);
  assert.equal(env.MSYS2_PATH_TYPE, 'inherit');
  assert.equal(env.TOKEN, 'unchanged');
  const unix = { PATH: '/usr/bin', ORIGINAL_PATH: '/original' };
  prependOfficeCommandPath(unix, '/office/bin', false);
  assert.deepEqual(unix, { PATH: '/office/bin:/usr/bin', ORIGINAL_PATH: '/original' });
  const fresh = { Path: 'C:\\Windows' };
  prependOfficeCommandPath(fresh, 'C:\\Office\\bin', true);
  assert.equal(Object.hasOwn(fresh, 'ORIGINAL_PATH'), false);
});

test('actual Git Bash login retains a worker command with a stale inherited ORIGINAL_PATH', t => {
  if (process.platform !== 'win32') return t.skip('Windows Git Bash integration');
  const bash = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find(existsSync);
  if (!bash) return t.skip('Git Bash unavailable');
  const dir = mkdtempSync(path.join(tmpdir(), 'office commands ')), home = mkdtempSync(path.join(tmpdir(), 'office home '));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  writeFileSync(path.join(dir, 'office-path-proof'), '#!/bin/sh\nprintf "office-command-found"\n');
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const key of Object.keys(env)) if (['PATH', 'ORIGINAL_PATH'].includes(key.toUpperCase())) delete env[key];
  // An empty HOME keeps the machine user's ~/.bashrc out of the login: it may add PATH entries (even the cwd).
  Object.assign(env, { PATH: `${dir};C:\\Windows\\System32`, ORIGINAL_PATH: '/usr/bin', MSYS2_PATH_TYPE: 'inherit', HOME: home });
  const before = spawnSync(bash, ['-lc', 'office-path-proof'], { env, cwd: dir, encoding: 'utf8', timeout: 10000 });
  assert.equal(before.status, 127, 'the stale login snapshot must reproduce the missing command');
  prependOfficeCommandPath(env, dir, true);
  assert.equal(execFileSync(bash, ['-lc', 'office-path-proof'], { env, cwd: dir, encoding: 'utf8', timeout: 10000 }), 'office-command-found');
});

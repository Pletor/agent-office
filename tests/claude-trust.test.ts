import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeConfigFile, claudeProjectKey, isClaudeCommand, officeFolders, trustClaudeFolders } from '../src/server/providers/claude-trust.js';
import { claude, claudeBlocked } from '../src/server/providers/claude.js';

// A fresh Claude worker in a floor or worktree the office made stops at "Quick safety check: is this a
// project you created or one you trust?" (default "No, exit"). The office answers it ahead of time in
// Claude's own config, for its own folders only, and never touches anything else in that file.

function temp(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-trust-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Claude names a folder by its absolute path with forward slashes', () => {
  const key = claudeProjectKey(path.join(tmpdir(), 'floor', 'sub'));
  assert.ok(!key.includes('\\'));
  assert.equal(key, path.resolve(tmpdir(), 'floor', 'sub').replace(/\\/g, '/'));
  assert.equal(claudeConfigFile({ CLAUDE_CONFIG_DIR: path.join(tmpdir(), 'cfg') }), path.join(tmpdir(), 'cfg', '.claude.json'));
});

test('only the floor and folders inside it are the office’s to trust', () => {
  const floor = path.join(tmpdir(), 'office', 'owner', 'ample');
  const wt = path.join(floor, '.worktrees', 'w1');
  assert.deepEqual(officeFolders(floor, floor), [path.resolve(floor)]);
  assert.deepEqual(officeFolders(floor, wt), [path.resolve(floor), path.resolve(wt)]);
  assert.deepEqual(officeFolders(floor, path.join(floor, '..', 'elsewhere')), []);
  assert.deepEqual(officeFolders(floor, `${floor}-other`), []);
});

test('trust is written into Claude’s config for exactly those folders, keeping the rest of it', (t) => {
  const dir = temp(t);
  const file = path.join(dir, '.claude.json');
  const floor = path.join(dir, 'floor');
  const wt = path.join(floor, '.worktrees', 'w1');
  const other = claudeProjectKey(path.join(dir, 'theirs'));
  writeFileSync(file, JSON.stringify({ numStartups: 7, oauthAccount: { emailAddress: 'x' }, projects: { [other]: { allowedTools: ['Bash'], hasTrustDialogAccepted: false }, [claudeProjectKey(floor)]: { lastCost: 1.5 } } }));

  const r = trustClaudeFolders(file, officeFolders(floor, wt));
  assert.equal(r.error, undefined);
  assert.deepEqual(r.added.sort(), [claudeProjectKey(floor), claudeProjectKey(wt)].sort());
  const c = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(c.numStartups, 7);
  assert.deepEqual(c.oauthAccount, { emailAddress: 'x' });
  assert.deepEqual(c.projects[other], { allowedTools: ['Bash'], hasTrustDialogAccepted: false });
  assert.deepEqual(c.projects[claudeProjectKey(floor)], { lastCost: 1.5, hasTrustDialogAccepted: true });
  assert.deepEqual(c.projects[claudeProjectKey(wt)], { hasTrustDialogAccepted: true });
  // No temp file or lock left behind, and a second run changes nothing.
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('.claude.json')), ['.claude.json']);
  const before = readFileSync(file, 'utf8');
  assert.deepEqual(trustClaudeFolders(file, officeFolders(floor, wt)).added, []);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('a missing or broken config is left for Claude, and a fresh lock someone holds is waited on, a stale one ignored', (t) => {
  const dir = temp(t);
  const file = path.join(dir, '.claude.json');
  assert.deepEqual(trustClaudeFolders(file, [dir]), { added: [] });
  assert.ok(!existsSync(file));
  writeFileSync(file, '{ half');
  assert.match(trustClaudeFolders(file, [dir]).error!, /couldn't read/);
  assert.equal(readFileSync(file, 'utf8'), '{ half');
  writeFileSync(file, '[]');
  assert.match(trustClaudeFolders(file, [dir]).error!, /isn't a JSON object/);

  writeFileSync(file, '{}');
  mkdirSync(`${file}.lock`);
  // Held and fresh: it waits its turn (briefly), then still writes, and leaves the other's lock alone.
  const r = trustClaudeFolders(file, [dir]);
  assert.equal(r.error, undefined);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).projects[claudeProjectKey(dir)].hasTrustDialogAccepted, true);
  assert.ok(existsSync(`${file}.lock`));
});

test('the Claude adapter trusts through the config its run uses, and still flags the safety-check screen', (t) => {
  const dir = temp(t);
  const file = path.join(dir, '.claude.json');
  writeFileSync(file, JSON.stringify({ hasCompletedOnboarding: true }));
  const floor = path.join(dir, 'floor');
  // A stand-in command (a test's fake, a wrapper) doesn't read Claude's config: nothing is written for it.
  claude.trust!({ CLAUDE_CONFIG_DIR: dir }, officeFolders(floor, floor), process.execPath);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).projects, undefined);
  assert.ok(isClaudeCommand('claude') && isClaudeCommand(path.join(dir, 'bin', 'claude.exe')) && isClaudeCommand(path.join(dir, 'npm', 'claude.cmd')));
  assert.ok(!isClaudeCommand('claude-code-router') && !isClaudeCommand('node'));
  claude.trust!({ CLAUDE_CONFIG_DIR: dir }, officeFolders(floor, floor), 'claude');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).projects[claudeProjectKey(floor)].hasTrustDialogAccepted, true);
  // Outside the floor nothing is handed over, so nothing is written.
  const before = readFileSync(file, 'utf8');
  claude.trust!({ CLAUDE_CONFIG_DIR: dir }, officeFolders(floor, path.join(dir, 'elsewhere')), 'claude');
  assert.equal(readFileSync(file, 'utf8'), before);

  const screen = 'Quick safety check: Is this a project you created or one you trust?\n❯ 1. Yes, I trust this folder\n  2. No, exit';
  assert.match(claudeBlocked(screen, true)!, /setup prompt/);
});

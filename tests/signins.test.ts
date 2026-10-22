import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SignIns } from '../src/server/signins.js';

// Signing in to GitHub from the office: `gh auth login --web` over pipes prints the one-time code,
// then waits for Enter (to open the page) before it polls GitHub. The office opens the page from the
// UI instead, so it has to press that Enter itself, or the sign-in sits at "busy" forever.

/**
 * A stand-in for gh that behaves like the real one at that point: it prints the code and the page,
 * and only once a line comes in on its stdin does it note that and finish signed in.
 *
 * The office runs `<gh> auth login …` in the account's own folder, so with node itself as "gh" the
 * script that runs is the file named `auth` in that folder: a fake gh that works on every platform.
 */
const FAKE_GH = `
const { writeFileSync } = require('node:fs');
process.stderr.write('! First copy your one-time code: ABCD-1234\\n');
process.stderr.write('Open this URL to continue in your web browser: https://github.com/login/device\\n');
let got = '';
process.stdin.on('data', (d) => {
  got += d;
  if (!got.includes('\\n')) return;
  writeFileSync('got-enter', 'yes');
  process.exit(0);
});
`;

test('a GitHub sign-in presses Enter for gh once the one-time code is shown', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'signins-'));
  const id = 'acct123456';
  const home = path.join(dir, 'homes', id);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, 'auth'), FAKE_GH);

  const env = () => {
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('NODE_TEST')) e[k] = v;
    return e;
  };
  let shown: { url?: string; code?: string } | undefined;
  const signins = new SignIns(dir, null, process.execPath, env, () => false, () => {
    const pending = signins.state(id).github.pending;
    if (pending?.code) shown ??= pending;
  });
  t.after(() => {
    signins.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(signins.start(id, 'github'), undefined);
  const deadline = Date.now() + 10_000;
  while (!existsSync(path.join(home, 'got-enter')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

  assert.deepEqual(shown, { url: 'https://github.com/login/device', code: 'ABCD-1234' });
  assert.ok(existsSync(path.join(home, 'got-enter')), "gh never got the Enter it waits for, so it never polls GitHub");
});

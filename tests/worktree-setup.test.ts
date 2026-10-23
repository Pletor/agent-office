import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExecCheck } from '../src/server/opora/self-checks.js';
import { SelfCheckReporter } from '../src/server/opora/self-checks.js';
import { SETUP_FILE, WorktreeSetup, loadWorktreeSetup, setupPromptLine } from '../src/server/workers/worktree-setup.js';

function floor(t: { after(fn: () => void): void }, config?: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (config !== undefined) {
    mkdirSync(path.join(dir, '.agent-office'), { recursive: true });
    writeFileSync(path.join(dir, SETUP_FILE), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return dir;
}

function logger() {
  const lines: { message: string; level: string }[] = [];
  return { lines, log: (message: string, level: 'info' | 'warn') => lines.push({ message, level }) };
}

/** A fake shell: records each run and answers with `answer`. */
function fakeExec(answer: { exitCode: number | null; output: string; timedOut?: boolean }) {
  const runs: { command: string; cwd: string; timeoutMs: number }[] = [];
  const exec = (timeoutMs: number): ExecCheck => async (command, cwd) => { runs.push({ command, cwd, timeoutMs }); return answer; };
  return { runs, exec };
}

test('a missing setup file means no setup, and is logged once', (t) => {
  const dir = floor(t);
  const { lines, log } = logger();
  assert.equal(loadWorktreeSetup(dir, log), undefined);
  assert.equal(loadWorktreeSetup(dir, log), undefined);
  assert.equal(lines.length, 1);
  assert.match(lines[0].message, /worktree-setup\.json: new worktrees get no dependency setup/);
});

test('an invalid setup file means no setup, and is logged once as a warning', (t) => {
  for (const bad of ['{not json', { command: '' }, { command: 'npm ci', timeoutMin: 0 }, ['npm ci'], { timeoutMin: 5 }]) {
    const dir = floor(t, bad);
    const { lines, log } = logger();
    assert.equal(loadWorktreeSetup(dir, log), undefined, JSON.stringify(bad));
    assert.equal(loadWorktreeSetup(dir, log), undefined);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, 'warn');
    assert.match(lines[0].message, /invalid/);
  }
});

test('a valid setup file gives the command and its timeout, 15 minutes by default', (t) => {
  assert.deepEqual(loadWorktreeSetup(floor(t, { command: ' npm ci && uv sync ', timeoutMin: 3 }), () => {}), { command: 'npm ci && uv sync', timeoutMs: 180_000 });
  assert.deepEqual(loadWorktreeSetup(floor(t, { command: 'npm ci' }), () => {}), { command: 'npm ci', timeoutMs: 15 * 60_000 });
  assert.equal(loadWorktreeSetup(floor(t, { command: 'npm ci', timeoutMin: 999 }), () => {})?.timeoutMs, 120 * 60_000);
});

test('the prompt line says what was installed, or why setup failed', () => {
  assert.equal(setupPromptLine({ command: 'npm ci && uv sync', exitCode: 0 }),
    "Project dependencies are installed in this worktree: the office ran `npm ci && uv sync` before you started; don't reinstall them unless a check needs it.");
  assert.equal(setupPromptLine({ command: 'npm ci', exitCode: 1, lastLine: 'npm ERR! missing lockfile' }),
    'Setup `npm ci` failed with exit 1: npm ERR! missing lockfile; fix the environment before running checks.');
});

test('prepare starts the worker at once when the floor has no setup', (t) => {
  const { runs, exec } = fakeExec({ exitCode: 0, output: '' });
  assert.equal(new WorktreeSetup(floor(t), () => {}, exec).prepare(floor(t), 'do it'), undefined);
  assert.equal(runs.length, 0);
});

test('prepare runs the setup in the worktree and appends the success line to the first prompt', async (t) => {
  const dir = floor(t, { command: 'npm ci && uv sync', timeoutMin: 2 });
  const wt = floor(t);
  const { runs, exec } = fakeExec({ exitCode: 0, output: 'added 300 packages\nResolved 40 packages\n' });
  const { lines, log } = logger();
  const prompt = await new WorktreeSetup(dir, log, exec).prepare(wt, 'Execute the card.');
  assert.deepEqual(runs, [{ command: 'npm ci && uv sync', cwd: wt, timeoutMs: 120_000 }]);
  assert.equal(prompt, `Execute the card.\n\n${setupPromptLine({ command: 'npm ci && uv sync', exitCode: 0 })}`);
  assert.ok(lines.some((l) => l.level === 'info' && /passed:\nadded 300 packages\nResolved 40 packages/.test(l.message)), 'logs the output tail');
});

test('a failed setup still starts the worker, with one line saying so', async (t) => {
  const dir = floor(t, { command: 'npm ci' });
  const { exec } = fakeExec({ exitCode: 1, output: 'npm ERR! code EUSAGE\nnpm ERR! missing package-lock.json\n' });
  const { lines, log } = logger();
  const prompt = await new WorktreeSetup(dir, log, exec).prepare(floor(t), 'Execute the card.');
  assert.equal(prompt, 'Execute the card.\n\nSetup `npm ci` failed with exit 1: npm ERR! missing package-lock.json; fix the environment before running checks.');
  assert.ok(lines.some((l) => l.level === 'warn' && /failed with exit 1/.test(l.message)));
});

test('a worker hired without a prompt gets no setup line as its first prompt', async (t) => {
  const { exec } = fakeExec({ exitCode: 0, output: '' });
  assert.equal(await new WorktreeSetup(floor(t, { command: 'npm ci' }), () => {}, exec).prepare(floor(t), undefined), undefined);
});

test('ensure skips a worktree the same setup already passed in, and reruns after a failure or a new command', async (t) => {
  const dir = floor(t, { command: 'npm ci' });
  const wt = floor(t);
  const failing = fakeExec({ exitCode: 2, output: 'boom' });
  await new WorktreeSetup(dir, () => {}, failing.exec).prepare(wt, 'x');
  const ok = fakeExec({ exitCode: 0, output: 'ok' });
  const setup = new WorktreeSetup(dir, () => {}, ok.exec);
  assert.equal((await setup.ensure(wt))?.exitCode, 0);
  assert.equal((await setup.ensure(wt))?.exitCode, 0);
  assert.equal(ok.runs.length, 1, 'ran once after the failure, then remembered the success');
  writeFileSync(path.join(dir, SETUP_FILE), JSON.stringify({ command: 'npm ci && uv sync' }));
  await setup.ensure(wt);
  assert.equal(ok.runs.length, 2);
  assert.equal(ok.runs[1].command, 'npm ci && uv sync');
});

test('self-checks run the setup first in a worktree that lacks it', async (t) => {
  const dir = floor(t, { command: 'npm ci' });
  const wt = floor(t);
  const order: string[] = [];
  const setup = new WorktreeSetup(dir, () => {}, () => async (command) => { order.push(`setup:${command}`); return { exitCode: 0, output: '' }; });
  const exec: ExecCheck = async (command) => { order.push(`check:${command}`); return { exitCode: 0, output: 'ok' }; };
  const transport = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  const ledger = path.join(floor(t), 'ledger.json');
  const reporter = new SelfCheckReporter('http://127.0.0.1:1', 'office-x', [{ name: 'tests', command: 'npm test' }], ledger, exec, transport);
  reporter.prepare = (d) => setup.ensure(d);
  await reporter.report({ project: 'p', workspace: 'w', executionId: 'e1', headSha: 'a'.repeat(40), dir: wt });
  await reporter.report({ project: 'p', workspace: 'w', executionId: 'e1', headSha: 'b'.repeat(40), dir: wt });
  assert.deepEqual(order, ['setup:npm ci', 'check:npm test', 'check:npm test']);
});

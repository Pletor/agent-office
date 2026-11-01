// watch-wave1 F23: a false-red self-check blocked a pull request, and the office kept nothing to see
// why. The checks now wait until the worktree's worker and its processes are gone, a red check runs
// once more before it counts, and each check's exit code and output tail (redacted) are kept in the
// evidence, the ledger, the log and the process wall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runSelfChecks, SelfCheckReporter, validSelfChecks, type ExecCheck } from '../src/server/opora/self-checks.js';
import { describeFailed, failureLine, outputTail, TAIL_LINES } from '../src/server/opora/self-check-evidence.js';
import { inside, waitForQuiet, workerProbe } from '../src/server/opora/worktree-quiet.js';
import { selfCheckEvent } from '../src/server/process/opora-events.js';

const HEAD = 'c'.repeat(40);
const scope = { project: 'shop', workspace: 'work' };

function tmp(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-selfcheck-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A shell that answers each run of a command with the next of its answers. */
function shell(answers: Record<string, { exitCode: number | null; output: string; timedOut?: boolean }[]>) {
  const ran: string[] = [];
  const exec: ExecCheck = async (command) => { ran.push(command); const list = answers[command]; return list.length > 1 ? list.shift()! : list[0]; };
  return { exec, ran };
}

test('a red check runs once more: it passes on the retry, and the summary says so', async () => {
  const { exec, ran } = shell({ 'npm test': [{ exitCode: 1, output: 'EBUSY: resource busy or locked' }, { exitCode: 0, output: '705 passed' }] });
  const out = await runSelfChecks([{ name: 'tests', command: 'npm test' }], '/w', HEAD, exec);
  assert.deepEqual(ran, ['npm test', 'npm test']);
  assert.equal(out.checks[0].status, 'passed');
  assert.equal(out.checks[0].exitCode, 0);
  assert.equal(out.checks[0].summary, 'passed on a retry (first run exit 1) · 705 passed');
  assert.ok(validSelfChecks(out));
});

test('a check red twice counts as failed, with both exit codes in its summary; one that never started or timed out is not retried', async () => {
  const { exec, ran } = shell({
    'npm test': [{ exitCode: 1, output: 'FAIL a' }, { exitCode: 2, output: 'FAIL b' }],
    'missing': [{ exitCode: null, output: 'spawn ENOENT' }],
    'slow': [{ exitCode: 124, output: '', timedOut: true }],
  });
  const out = await runSelfChecks([{ name: 'tests', command: 'npm test' }, { name: 'gone', command: 'missing' }, { name: 'slow', command: 'slow' }], '/w', HEAD, exec);
  assert.deepEqual(ran, ['npm test', 'npm test', 'missing', 'slow']);
  assert.equal(out.checks[0].exitCode, 2);
  assert.equal(out.checks[0].summary, 'failed twice (exit 1, then exit 2; retried once) · FAIL b');
  assert.equal(out.checks[1].exitCode, 127);
  assert.equal(out.checks[2].summary, 'timed out');
  assert.ok(validSelfChecks(out));
});

test('the evidence keeps the last 40 lines of output, without secrets or the worktree path', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
  lines.push('Authorization: Bearer abcdefghijklmnop0123456789', 'at C:\\work\\tree\\src\\a.ts:3');
  const tail = outputTail(lines.join('\r\n'), ['C:\\work\\tree']);
  const kept = tail.split('\n');
  assert.equal(kept.length, TAIL_LINES);
  assert.equal(kept[0], 'line 63');
  assert.doesNotMatch(tail, /abcdefghijklmnop0123456789/);
  assert.doesNotMatch(tail, /work\\tree/);
  assert.ok(outputTail('x\n'.repeat(5000)).length <= 4000);
});

test('the reporter waits for the worktree to go quiet, then keeps each check\'s exit code and tail in the ledger and on the wall', async (t) => {
  const dir = tmp(t), ledger = path.join(dir, 'opora-self-checks.json');
  const order: string[] = [];
  const { exec } = shell({ 'npm test': [{ exitCode: 1, output: 'FAIL cart.test.ts\nTests: 1 failed' }] });
  const logs: string[] = [];
  const transport = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  const reporter = new SelfCheckReporter('http://canvas', 'office-1', [{ name: 'tests', command: 'npm test' }], ledger,
    async (c, cwd) => { order.push('check'); return exec(c, cwd); }, transport, (m) => void logs.push(m), { everyMs: 5, attempts: 0 });
  reporter.settle = async () => { order.push('settle'); return { waitedMs: 4000, timedOut: false, busy: [] }; };
  reporter.prepare = async () => { order.push('prepare'); };
  assert.equal(await reporter.report({ ...scope, executionId: 'ex-1', headSha: HEAD, dir }), 'recorded');
  assert.deepEqual(order, ['settle', 'prepare', 'check', 'check']);
  const entry = JSON.parse(readFileSync(ledger, 'utf8'))[`ex-1@${HEAD}`];
  assert.equal(entry.outcome, 'recorded');
  assert.deepEqual(entry.checks[0], { name: 'tests', command: 'npm test', exitCode: 1, status: 'failed', attempts: 2, firstExitCode: 1, tail: 'FAIL cart.test.ts\nTests: 1 failed' });
  assert.equal(reporter.entry('ex-1', HEAD)?.checks?.[0].exitCode, 1);
  assert.ok(logs.some((m) => /waited 4 s for the worktree's last worker/.test(m)));
  assert.ok(logs.some((m) => /failed: tests exit 1 \(2 runs\): FAIL cart.test.ts; Canvas recorded them/.test(m)), logs.join('\n'));
});

test('an older ledger that kept only the outcome still reads', async (t) => {
  const dir = tmp(t), ledger = path.join(dir, 'opora-self-checks.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(ledger, JSON.stringify({ [`ex-1@${HEAD}`]: 'recorded' }));
  const { exec, ran } = shell({ 'npm test': [{ exitCode: 0, output: '' }] });
  const reporter = new SelfCheckReporter('http://canvas', 'office-1', [{ name: 'tests', command: 'npm test' }], ledger, exec);
  assert.equal(await reporter.report({ ...scope, executionId: 'ex-1', headSha: HEAD, dir }), 'skipped');
  assert.equal(ran.length, 0);
});

test('the wall says each red check\'s exit code, whether it was retried, and its last line', () => {
  const e = selfCheckEvent({ ...scope, executionId: 'ex-1', headSha: HEAD }, ['tests'], 'recorded',
    [{ name: 'tests', exitCode: 1, status: 'failed', attempts: 2, firstExitCode: 1, tail: 'FAIL a\nTests: 1 failed' },
      { name: 'build', exitCode: 0, status: 'passed', attempts: 2, firstExitCode: 3 }]);
  assert.equal(e.detail, `head ${HEAD.slice(0, 12)} · Canvas: recorded · tests exit 1 i po opakování: Tests: 1 failed · build prošel až na druhý pokus (poprvé exit 3)`);
});

test('waiting for quiet: until no probe finds anything, then a settle; bounded', async () => {
  let now = 0;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); now += ms; };
  let busyFor = 3;
  const probe = async () => (busyFor-- > 0 ? ['worker Ada'] : []);
  const q = await waitForQuiet('/w', [probe], { everyMs: 1000, settleMs: 500, sleep, now: () => now });
  assert.deepEqual(q, { waitedMs: 3500, timedOut: false, busy: [] });
  assert.deepEqual(sleeps, [1000, 1000, 1000, 500]);
  const quiet = await waitForQuiet('/w', [async () => []], { sleep, now: () => now });
  assert.equal(quiet.waitedMs, 0, 'nothing to wait for: no settle either');
  const stuck = await waitForQuiet('/w', [async () => ['pid 9 node'], async () => { throw new Error('no'); }], { everyMs: 1000, maxMs: 2500, sleep, now: () => now });
  assert.equal(stuck.timedOut, true);
  assert.deepEqual(stuck.busy, ['pid 9 node']);
});

test('the worker probe finds the floor\'s workers still running in that worktree', async () => {
  const floor = path.resolve('/office/floor');
  const workers = [
    { name: 'Ada', status: 'working', worktree: { path: '.agent-office/worktrees/ada' } },
    { name: 'Bob', status: 'exited', worktree: { path: '.agent-office/worktrees/bob' } },
    { name: 'Cy', status: 'idle', worktree: { path: '.agent-office/worktrees/cy' } },
  ];
  const probe = workerProbe(() => workers, floor);
  assert.deepEqual(await probe(path.join(floor, '.agent-office/worktrees/ada')), ['worker Ada']);
  assert.deepEqual(await probe(path.join(floor, '.agent-office/worktrees/bob')), []);
  assert.ok(inside('/a/b', '/a/b/c'));
  assert.ok(!inside('/a/b', '/a/bc'));
});

test('a red run is summed up by where it failed, not by its last line (the duration)', () => {
  const vitest = '\x1b[32m- Expected\x1b[39m\n\x1b[36m \x1b[2m❯\x1b[22m frontend/x/Page.test.tsx:\x1b[2m105:103\x1b[22m\x1b[39m\n Test Files  1 failed | 173 passed (174)\n   Duration  49.60s';
  assert.equal(failureLine(vitest), '❯ frontend/x/Page.test.tsx:105:103');
  assert.equal(failureLine('x\nFAILED backend/test_a.py::test_b - assert 1\n1 failed, 3 passed in 2s'), 'FAILED backend/test_a.py::test_b - assert 1');
  assert.equal(failureLine('Tests  2 failed | 3 passed\nDuration 1s'), 'Tests  2 failed | 3 passed');
  assert.equal(failureLine('all good\nDuration 1s'), undefined);
  assert.equal(describeFailed([{ name: 'tests', command: 'npm test', exitCode: 1, status: 'failed', attempts: 2, tail: vitest }]),
    'tests exit 1 (2 runs): ❯ frontend/x/Page.test.tsx:105:103');
});

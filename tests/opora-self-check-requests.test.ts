// Ample PR #35/#36 (2026-10-30): Canvas had automated review off, answered every self-check post with
// 409 `review_jobs_disabled`, and the office took that for a refusal of the head (`conflict`), so it never
// posted again; once review was back on, both PRs waited on `self_checks_missing` for good. Now that 409
// is `disabled` and the evidence is posted again, and a head Canvas asks evidence for (agent-state
// `review.self_checks` ready) gets its checks run again, for real, in a worktree at that head.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SelfCheckReporter, type ExecCheck } from '../src/server/opora/self-checks.js';
import { selfCheckDelay } from '../src/server/opora/self-check-pending.js';
import { digestAgentState } from '../src/server/opora/agent-state.js';
import { runRequestedSelfChecks } from '../src/server/opora/self-check-requests.js';

const HEAD = 'c'.repeat(40);
const scope = { project: 'shop', workspace: 'work' };
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function tmp(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-requested-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A Canvas answering each post with the next status and body. */
function canvas(answers: [number, object][]) {
  const bodies: string[] = [];
  const transport = (async (_url: URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const [status, body] = answers.length > 1 ? answers.shift()! : answers[0];
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { transport, bodies };
}
function checks() {
  const ran: string[] = [];
  let n = 0;
  const exec: ExecCheck = async (command, cwd) => { ran.push(`${command} @ ${cwd}`); return { exitCode: 0, output: `run ${++n}` }; };
  return { exec, ran };
}
const DISABLED: [number, object] = [409, { error: 'Automated code review is not enabled.', code: 'review_jobs_disabled' }];
const REFUSED: [number, object] = [409, { error: 'Self-checks for this head were already recorded with different content.', code: 'review_conflict' }];

test('409 review_jobs_disabled is not a refusal of the head: the evidence is kept and posted again until recorded', async t => {
  const dir = tmp(t), ledger = path.join(dir, 'opora-self-checks.json');
  const f = canvas([DISABLED, DISABLED, [200, {}]]);
  const { exec, ran } = checks();
  let now = 1_000_000;
  const logs: string[] = [];
  const reporter = new SelfCheckReporter('http://canvas', 'office-1', [{ name: 'tests', command: 'npm test' }], ledger, exec, f.transport,
    (m) => void logs.push(m), { everyMs: 5, attempts: 20 }, undefined, () => now);
  const subject = { ...scope, executionId: 'ex-1', headSha: HEAD, dir };
  assert.equal(await reporter.report(subject), 'disabled');
  assert.match(logs.at(-1)!, /\(its automated review is off\); kept to post again/);
  assert.equal(JSON.parse(readFileSync(ledger, 'utf8'))[`ex-1@${HEAD}`].outcome, 'disabled', 'not "conflict", which would end it');
  assert.ok(JSON.parse(readFileSync(path.join(dir, 'opora-self-checks-unsent.json'), 'utf8'))[`ex-1@${HEAD}`]);
  assert.equal(await reporter.report(subject), 'skipped', 'the checks do not run again while their evidence waits');

  now += selfCheckDelay(1);
  await reporter.retryPending();
  now += selfCheckDelay(2);
  await reporter.retryPending();
  assert.equal(f.bodies.length, 3);
  assert.equal(f.bodies[2], f.bodies[0], 'the same body, posted again');
  assert.equal(JSON.parse(readFileSync(ledger, 'utf8'))[`ex-1@${HEAD}`].outcome, 'recorded');
  assert.equal(ran.length, 1);
});

test('any other 409 is still a refusal of the head', async t => {
  const dir = tmp(t);
  const f = canvas([REFUSED]);
  const reporter = new SelfCheckReporter('http://canvas', 'office-1', [{ name: 'tests', command: 'npm test' }], path.join(dir, 'l.json'), checks().exec, f.transport,
    () => {}, { everyMs: 5, attempts: 0 });
  assert.equal(await reporter.report({ ...scope, executionId: 'ex-1', headSha: HEAD, dir }), 'conflict');
});

test('a head Canvas asks evidence for runs its checks in a worktree at that head, even after a "conflict", once per process', async t => {
  const dir = tmp(t), ledger = path.join(dir, 'opora-self-checks.json');
  writeFileSync(ledger, JSON.stringify({ [`ex-1@${HEAD}`]: { outcome: 'conflict', at: '2026-10-30T15:50:24.369Z' }, [`ex-2@${HEAD}`]: { outcome: 'recorded' } }));
  const f = canvas([[200, {}]]);
  const { exec, ran } = checks();
  const reporter = new SelfCheckReporter('http://canvas', 'office-1', [{ name: 'tests', command: 'npm test' }], ledger, exec, f.transport, () => {});
  assert.equal(await reporter.report({ ...scope, executionId: 'ex-1', headSha: HEAD, dir }), 'skipped', 'a hand-off still takes the ledger as it is');
  const made: string[] = [], removed: string[] = [];
  const checkout = (id: string) => async () => { const at = path.join(dir, `wt-${id}`); made.push(at); return { dir: at, cleanup: async () => void removed.push(at) }; };
  assert.equal(await reporter.requested({ ...scope, executionId: 'ex-1', headSha: HEAD }, checkout('ex-1')), 'recorded');
  assert.deepEqual(ran, [`npm test @ ${path.join(dir, 'wt-ex-1')}`]);
  assert.deepEqual(removed, made, 'the worktree is removed again');
  assert.equal(JSON.parse(readFileSync(ledger, 'utf8'))[`ex-1@${HEAD}`].outcome, 'recorded');
  assert.equal(await reporter.requested({ ...scope, executionId: 'ex-1', headSha: HEAD }, checkout('ex-1')), 'skipped');
  assert.equal(await reporter.requested({ ...scope, executionId: 'ex-2', headSha: HEAD }, checkout('ex-2')), 'skipped', 'Canvas recorded that one');
  assert.equal(made.length, 1);
});

test('a checkout that fails costs only that head', async t => {
  const dir = tmp(t);
  const logs: string[] = [];
  const { exec, ran } = checks();
  const reporter = new SelfCheckReporter('http://canvas', 'office-1', [{ name: 'tests', command: 'npm test' }], path.join(dir, 'l.json'), exec, canvas([[200, {}]]).transport, (m) => void logs.push(m));
  assert.equal(await reporter.requested({ ...scope, executionId: 'ex-1', headSha: HEAD }, async () => { throw new Error('gone'); }), 'failed');
  assert.match(logs.at(-1)!, /no worktree at cccccccccccc \(gone\)/);
  assert.equal(ran.length, 0);
});

test('agent-state: the ready review.self_checks actions are the heads Canvas asks evidence for', () => {
  const action = (status: string, executionId: unknown, headSha: unknown) => ({ verb: 'review.self_checks', status, targetId: executionId, preconditions: { executionId, headSha, required: ['tests', 'build'] } });
  const digest = digestAgentState({ actions: [action('ready', 'ex-1', HEAD), action('blocked', 'ex-2', HEAD), action('ready', 'ex-3', 'nope'), { verb: 'claim', status: 'ready', targetId: 'card' }] });
  assert.deepEqual(digest.selfChecks, [{ executionId: 'ex-1', headSha: HEAD }]);
  assert.deepEqual(digestAgentState({}).selfChecks, []);
});

test('only executions this floor claimed, in the linked scope, are run again', async t => {
  const dir = tmp(t);
  mkdirSync(path.join(dir, 'opora-executions'));
  writeFileSync(path.join(dir, 'opora-executions', 'ours.json'), JSON.stringify({ ...scope, executionId: 'ours' }));
  writeFileSync(path.join(dir, 'opora-executions', 'elsewhere.json'), JSON.stringify({ project: 'other', workspace: 'work', executionId: 'elsewhere' }));
  const asked: string[] = [];
  const reporter = { requested: async (s: { executionId: string }) => { asked.push(s.executionId); return 'recorded'; } } as unknown as SelfCheckReporter;
  const git = async () => '';
  runRequestedSelfChecks(reporter, git, dir, dir, scope, [{ executionId: 'ours', headSha: HEAD }, { executionId: 'theirs', headSha: HEAD }, { executionId: 'elsewhere', headSha: HEAD }]);
  await flush();
  assert.deepEqual(asked, ['ours']);
});

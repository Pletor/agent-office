import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExecutionLease } from '../src/server/opora/execution-client.js';
import { executionPrompt } from '../src/server/opora/execution-prompt.js';
import { reportExecution } from '../src/server/opora/execution-worker.js';
import { draftPullRequest } from '../src/server/opora/pull-request-body.js';
import { PullRequestHandoff, type HandoffTools } from '../src/server/opora/pull-request-handoff.js';
import { remoteStepResults } from '../src/server/opora/isolated-reports.js';
import { remoteSteps } from '../src/server/opora/isolated-service.js';
import { commitsFromLog, commitsFromPatch, pinnedSteps, stepResultsProblem, withStepCommits } from '../src/server/opora/plan-steps.js';

const STEPS = [
  { id: 's2', order: 2, title: 'API', acceptance: ['test API zelený'], dependsOn: ['s1'], kind: 'code', files: ['backend/**/*.py'] },
  { id: 's1', order: 1, title: 'Datový model', acceptance: ['migrace projde'], dependsOn: [] },
];
const SHA1 = '1'.repeat(40), SHA2 = '2'.repeat(40), SHA3 = '3'.repeat(40);
const LOG = [`${SHA1}\x1fstep s1: Datový model`, `${'9'.repeat(40)}\x1fchore: unrelated`, `${SHA2}\x1fstep s2: API`,
  `${SHA3}\x1fStep s2: API fix-up`, `${'8'.repeat(40)}\x1fstep s9: not in the plan`].join('\n');
const lease = (assignment: Record<string, unknown> = { contextVersion: 'context', steps: STEPS }): ExecutionLease => ({
  project: 'project', workspace: 'work', nodeId: 'card-1', executionId: 'execution-1', token: 'PRIVATE-token', epoch: 7,
  acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64), assignment, state: 'running', serverNow: 100, expiresAt: 1000 });
const done = (stepId: string, evidence: Record<string, unknown> = { notes: 'ok' }) => ({ stepId, status: 'done', evidence });

function directory(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-steps-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the prompt lists the pinned steps in order with dependsOn, acceptance and globs; a legacy card gets the old prompt', t => {
  const dir = directory(t);
  const prompt = executionPrompt(dir, 'http://localhost:5010', 'office', lease());
  const first = prompt.indexOf('[s1] Datový model'), second = prompt.indexOf('[s2] API (code)');
  assert.ok(first > 0 && second > first, 'steps in topological order');
  assert.match(prompt, /depends on: s1/);
  assert.match(prompt, /acceptance: test API zelený/);
  assert.match(prompt, /files: backend\/\*\*\/\*\.py/);
  assert.match(prompt, /one commit per step .*"step <id>: <title>"/);
  assert.match(prompt, /report that step "failed"/);
  assert.match(prompt, /outside the step's globs/);
  assert.match(prompt, /stepResults/);
  const legacy = executionPrompt(directory(t), 'http://localhost:5010', 'office', { ...lease({ contextVersion: 'context' }), executionId: 'execution-2' });
  assert.doesNotMatch(legacy, /Plan steps|stepResults/);
  assert.deepEqual(pinnedSteps({}), []);
});

test('stepResults are validated as Canvas validates them', () => {
  const steps = pinnedSteps({ steps: STEPS });
  assert.equal(stepResultsProblem([done('s1'), { stepId: 's2', status: 'failed', evidence: { notes: 'no', checks: ['npm test: exit 1'], commits: ['abc1234'] } }], steps), undefined);
  for (const bad of [
    'x', [done('s1'), done('s2'), done('s1')], [done('s3')], [done('s1'), done('s1')],
    [{ stepId: 's1', status: 'done' }], [{ ...done('s1'), extra: 1 }], [{ stepId: 's1', status: 'started', evidence: { notes: '' } }],
    [done('s1', {})], [done('s1', { notes: 'x', other: 1 })], [done('s1', { notes: 'x'.repeat(4001) })],
    [done('s1', { notes: 'x', checks: [''] })], [done('s1', { notes: 'x', commits: ['XYZ'] })],
  ]) assert.ok(stepResultsProblem(bad, steps), JSON.stringify(bad).slice(0, 80));
});

test('commit SHAs come from `step <id>:` messages, in a log or a format-patch mailbox, never from the agent', () => {
  const steps = pinnedSteps({ steps: STEPS });
  const log = commitsFromLog(LOG, steps);
  assert.deepEqual(Object.fromEntries(log), { s1: [SHA1], s2: [SHA2, SHA3] });
  const patch = `From ${SHA1} Mon Sep 17 00:00:00 2001\nFrom: A <a@b>\nSubject: [PATCH 1/2] step s1: Datový model\n\n---\n`
    + `From ${SHA2} Mon Sep 17 00:00:00 2001\nSubject: [PATCH 2/2] step s2: API\n`;
  assert.deepEqual(Object.fromEntries(commitsFromPatch(patch, steps)), { s1: [SHA1], s2: [SHA2] });
  const claimed = { summary: 's', stepResults: [done('s1', { notes: 'ok', commits: ['deadbee'] }), done('s2')] };
  const { result, problem } = withStepCommits(claimed, steps, log);
  assert.equal(problem, undefined);
  assert.deepEqual(result.stepResults, [done('s1', { notes: 'ok', commits: [SHA1] }), done('s2', { notes: 'ok', commits: [SHA2, SHA3] })]);
  assert.deepEqual(withStepCommits(claimed, steps, new Map()).result.stepResults, [done('s1'), done('s2')], 'no commit found: none claimed');
  assert.deepEqual(withStepCommits(claimed, [], log).result, { summary: 's' }, 'legacy card: stepResults dropped');
});

test('the helper attaches git commits before posting, refuses a bad shape without posting, and leaves legacy results alone', async t => {
  const dir = directory(t);
  executionPrompt(dir, 'http://localhost:5010', 'office', lease());
  const bundle = path.join(dir, 'opora-executions', 'execution-1.json'), file = path.join(dir, 'result.json');
  const posted: Record<string, unknown>[] = [];
  const send = (async (_url: URL, init?: RequestInit) => {
    posted.push(JSON.parse(String(init?.body)).result);
    return new Response(JSON.stringify({ receiptId: 'receipt', executionId: 'execution-1', state: 'reported' }));
  }) as typeof fetch;
  writeFileSync(file, JSON.stringify({ summary: 'Ready', stepResults: [done('s1', { notes: 'ok', commits: ['deadbee'] })] }));
  await reportExecution(bundle, file, send, () => LOG);
  assert.deepEqual(posted[0].stepResults, [done('s1', { notes: 'ok', commits: [SHA1] })]);
  const stored = JSON.parse(readFileSync(path.join(dir, 'opora-executions', 'execution-1-reported.json'), 'utf8'));
  assert.deepEqual(stored.result.stepResults, posted[0].stepResults, 'the office drafts the PR from what Canvas got');

  writeFileSync(file, JSON.stringify({ summary: 'Ready', stepResults: [done('s7')] }));
  await assert.rejects(reportExecution(bundle, file, send, () => LOG), /stepResults: .*s7.*Fix the result file/);
  assert.equal(posted.length, 1, 'nothing sent for a shape Canvas would refuse');

  writeFileSync(file, JSON.stringify({ summary: 'Ready', artifacts: [] }));
  await reportExecution(bundle, file, send, () => { throw new Error('git is not read without stepResults'); });
  assert.deepEqual(posted[1], { summary: 'Ready', artifacts: [] });

  const legacy = directory(t);
  executionPrompt(legacy, 'http://localhost:5010', 'office', lease({ contextVersion: 'context' }));
  writeFileSync(file, JSON.stringify({ summary: 'Ready', stepResults: [done('s1')] }));
  await reportExecution(path.join(legacy, 'opora-executions', 'execution-1.json'), file, send, () => LOG);
  assert.deepEqual(posted[2], { summary: 'Ready' });
});

test('the PR body lists the plan steps with status and commits, keeping the template headings', () => {
  const steps = pinnedSteps({ steps: STEPS });
  const result = { summary: 'Done', stepResults: [done('s1', { notes: 'ok', checks: ['npm test: exit 0'] }), { stepId: 's2', status: 'failed', evidence: { notes: 'no' } }] };
  const { body } = draftPullRequest({ executionId: 'e', acceptedRevision: 'a'.repeat(40), cardId: 'c', result, steps, stepCommits: commitsFromLog(LOG, steps) });
  const headings = body.split('\n').filter(l => l.startsWith('## '));
  assert.deepEqual(headings, ['## Summary', '## Kroky plánu', '## Testing', '## Risk', '## Revert plan']);
  assert.match(body, new RegExp(`- \`s1\` Datový model: \\*\\*done\\*\\* \\(\`${SHA1.slice(0, 12)}\`\\)\n  - \`npm test: exit 0\``));
  assert.match(body, new RegExp(`- \`s2\` API: \\*\\*failed\\*\\* \\(\`${SHA2.slice(0, 12)}\`, \`${SHA3.slice(0, 12)}\`\\)`));
  const legacy = draftPullRequest({ executionId: 'e', acceptedRevision: 'a'.repeat(40), cardId: 'c', result: { summary: 'Done' } }).body;
  assert.doesNotMatch(legacy, /Kroky plánu/);
  const unreported = draftPullRequest({ executionId: 'e', acceptedRevision: 'a'.repeat(40), cardId: 'c', result: { summary: 'Done' }, steps }).body;
  assert.match(unreported, /`s1` Datový model: \*\*not reported\*\* \(no commit\)/);
});

test('the handoff reads the PR\'s own step commits from base..HEAD for the body', async t => {
  const dir = directory(t);
  mkdirSync(path.join(dir, 'opora-executions'), { recursive: true }); mkdirSync(path.join(dir, 'tree'));
  writeFileSync(path.join(dir, 'opora-executions', 'execution-1-reported.json'),
    JSON.stringify({ receiptId: 'r', result: { summary: 'Done', stepResults: [done('s1'), done('s2')] } }));
  const git: string[][] = [], gh: string[][] = [];
  const tools: HandoffTools = { env: {}, transport: (async () => new Response('{}')) as typeof fetch,
    git: async args => {
      git.push(args);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'c'.repeat(40);
      if (args[0] === 'rev-list') return '3';
      if (args[0] === 'remote') return 'git@github.com:Pletor/shop.git';
      if (args[0] === 'log') return LOG;
      return 'x';
    },
    gh: async args => { gh.push(args); return args[1] === 'list' ? '[]' : args[1] === 'create' ? 'https://github.com/Pletor/shop/pull/42\n' : ''; } };
  const handoff = new PullRequestHandoff(dir, 'http://localhost:5010', 'office', tools);
  const out = await handoff.handOff({ lease: lease(), dir: path.join(dir, 'tree'), baseCommit: 'd'.repeat(40) }, () => {});
  assert.equal(out?.state, 'opened');
  assert.ok(git.some(args => args[0] === 'log' && args.includes(`${'d'.repeat(40)}..HEAD`)));
  const body = gh.find(args => args[1] === 'create')![gh.find(args => args[1] === 'create')!.indexOf('--body') + 1];
  assert.match(body, /## Kroky plánu\n\n- `s1` Datový model: \*\*done\*\* \(`111111111111`\)/);
});

test('the isolated broker gets the same checklist and its stepResults take their commits from the patch', () => {
  assert.match(remoteSteps({ steps: STEPS }), /\[s1\][\s\S]*\[s2\][\s\S]*in \/workspace\/repo[\s\S]*inside result/);
  assert.equal(remoteSteps({}), '');
  const steps = pinnedSteps({ steps: STEPS });
  const patch = `From ${SHA2} Mon Sep 17 00:00:00 2001\nSubject: [PATCH] step s2: API\n`;
  assert.deepEqual(remoteStepResults({ summary: 's', patch, stepResults: [done('s2', { notes: 'ok', commits: ['abcdef1'] })] }, steps).stepResults,
    [done('s2', { notes: 'ok', commits: [SHA2] })]);
  assert.deepEqual(remoteStepResults({ summary: 's', stepResults: [done('nope')] }, steps), { summary: 's' }, 'a bad shape is left out, the result stays');
  assert.deepEqual(remoteStepResults({ summary: 's', stepResults: [done('s1')] }, []), { summary: 's' }, 'legacy card');
  assert.deepEqual(remoteStepResults({ summary: 's' }, steps), { summary: 's' });
});

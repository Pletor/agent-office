import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExecutionLease } from '../src/server/opora/execution-client.js';
import { executionPrompt } from '../src/server/opora/execution-prompt.js';
import { reportExecution } from '../src/server/opora/execution-worker.js';
import { ExecutionDispatch } from '../src/server/opora/execution-dispatch.js';
import { draftPullRequest, evidenceLines, handoffBranch, linkRequestId } from '../src/server/opora/pull-request-body.js';
import { PullRequestHandoff, type HandoffTools } from '../src/server/opora/pull-request-handoff.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const HEAD = 'c'.repeat(40);
const lease = (): ExecutionLease => ({ project: 'project', workspace: 'work', nodeId: 'card-0123456789abcdef', executionId: 'execution-1',
  token: 'PRIVATE-token', epoch: 7, acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64), assignment: { contextVersion: 'context' },
  state: 'running', serverNow: 100, expiresAt: 1000 });

function directory(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-handoff-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'opora-executions'), { recursive: true });
  mkdirSync(path.join(dir, 'tree'), { recursive: true });
  return dir;
}
function reported(dir: string, result: Record<string, unknown> = { summary: 'Cart page done', evidence: [{ name: 'npm test', status: 'passed' }, 'npm run build'] }) {
  writeFileSync(path.join(dir, 'opora-executions', 'execution-1-reported.json'), JSON.stringify({ receiptId: 'r', result }));
}

/** Fake git, gh and Canvas, recording every call; `existing` is the PR `gh pr list` finds, `status` Canvas's answer. */
function fakes(opts: { ahead?: number; existing?: { number: number; url: string }; status?: number; env?: NodeJS.ProcessEnv; head?: () => string } = {}) {
  const git: string[][] = [], gh: string[][] = [], posts: { url: string; body: Record<string, unknown> }[] = [];
  const tools: HandoffTools = {
    env: opts.env ?? {},
    git: async (args) => {
      git.push(args);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return opts.head?.() ?? HEAD;
      if (args[0] === 'rev-list') return String(opts.ahead ?? 2);
      if (args[0] === 'remote') return 'git@github.com:Pletor/shop.git';
      if (args[0] === 'rev-parse') return 'x';
      return '';
    },
    gh: async (args) => {
      gh.push(args);
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(opts.existing ? [opts.existing] : []);
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/Pletor/shop/pull/42\n';
      return '';
    },
    transport: (async (url: URL, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: opts.status ?? 200 });
    }) as typeof fetch,
  };
  return { tools, git, gh, posts };
}
const subject = (dir: string) => ({ lease: lease(), cardName: 'Cart page', dir: path.join(dir, 'tree'), baseCommit: 'd'.repeat(40), baseBranch: 'main' });
const quiet = () => {};

test('the branch is deterministic and git-safe; the link request id is a stable UUID of execution and head', () => {
  assert.equal(handoffBranch('card-0123456789abcdef', 'execution-1'), 'opora/card-0123456/execution-1');
  assert.equal(handoffBranch('a..b/c', 'x.lock'), 'opora/a-b-c/x-lock');
  assert.equal(linkRequestId('execution-1', HEAD), linkRequestId('execution-1', HEAD));
  assert.notEqual(linkRequestId('execution-1', HEAD), linkRequestId('execution-1', 'e'.repeat(40)));
  assert.match(linkRequestId('execution-1', HEAD), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('the body has summary, checks, risk and revert plan, and ends with the exact Opora trailers', () => {
  const { title, body } = draftPullRequest({ executionId: 'execution-1', acceptedRevision: 'a'.repeat(40), cardId: 'card-1', cardName: 'Cart page',
    result: { summary: 'Did it', checks: { unit: ['npm test'], e2e: [{ command: 'npx playwright test', passed: false }] }, risk: 'Low' }, base: 'main' });
  assert.equal(title, 'Opora: Cart page');
  for (const heading of ['## Summary', '## Testing', '## Risk', '## Revert plan']) assert.ok(body.includes(heading), heading);
  assert.match(body, /- npm test\n- `npx playwright test`: failed/);
  assert.match(body, /## Risk\n\nLow/);
  assert.ok(body.endsWith(`Opora-Execution: execution-1\nOpora-Revision: ${'a'.repeat(40)}\nOpora-Card: card-1`));
  assert.deepEqual(evidenceLines({ summary: 'x' }), []);
  assert.match(draftPullRequest({ executionId: 'e', acceptedRevision: 'a'.repeat(40), cardId: 'c', result: { summary: 's' } }).body, /None reported by the worker/);
});

test('the body fills every section the Canvas PR template rule asks for (Testing, Risk, Revert plan)', () => {
  // Canvas (opora_review_template.py) counts a section only as a heading with that exact name and text under it.
  const { body } = draftPullRequest({ executionId: 'e', acceptedRevision: 'a'.repeat(40), cardId: 'c', result: { summary: 's' } });
  for (const section of ['Testing', 'Risk', 'Revert plan']) assert.match(body, new RegExp(`^## ${section}\\n\\n\\S`, 'm'), section);
});

test('a reported execution is pushed, gets a PR and is linked on Canvas with its own credentials; a second run is a no-op', async t => {
  const dir = directory(t); reported(dir);
  const f = fakes();
  const handoff = new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools);
  const outcome = await handoff.handOff(subject(dir), quiet);
  assert.deepEqual(outcome, { state: 'opened', branch: 'opora/card-0123456/execution-1', headSha: HEAD, repository: 'Pletor/shop', number: 42, url: 'https://github.com/Pletor/shop/pull/42', link: 'linked' });
  assert.ok(f.git.some(a => a.join(' ') === 'push origin HEAD:refs/heads/opora/card-0123456/execution-1'));
  const create = f.gh.find(a => a[1] === 'create')!;
  assert.deepEqual(create.slice(0, 8), ['pr', 'create', '--repo', 'Pletor/shop', '--head', 'opora/card-0123456/execution-1', '--base', 'main']);
  assert.match(create[create.indexOf('--body') + 1], /Opora-Execution: execution-1\nOpora-Revision: a{40}\nOpora-Card: card-0123456789abcdef$/);
  assert.match(create[create.indexOf('--body') + 1], /`npm test`: passed\n- npm run build/);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].url, 'http://127.0.0.1:8740/api/oporahub/executions/execution-1/pull-request');
  assert.deepEqual(f.posts[0].body, { project: 'project', workspace: 'work', token: 'PRIVATE-token', epoch: 7,
    requestId: linkRequestId('execution-1', HEAD), repository: 'Pletor/shop', number: 42, headRef: 'opora/card-0123456/execution-1', headSha: HEAD });
  assert.equal(f.gh.filter(a => a.includes('merge') || a.includes('review')).length, 0, 'never merges or approves');
  // Idempotent: the same head commit is neither pushed nor linked again, even by a fresh office.
  const again = await new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools).handOff(subject(dir), quiet);
  assert.equal(again?.state, 'opened');
  assert.equal(f.git.filter(a => a[0] === 'push').length, 1);
  assert.equal(f.posts.length, 1);
});

test('an existing PR for the branch is reused; a new head commit is pushed and linked with a new request id', async t => {
  const dir = directory(t); reported(dir);
  let head = HEAD;
  const f = fakes({ existing: { number: 7, url: 'https://github.com/Pletor/shop/pull/7' }, head: () => head });
  const handoff = new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools);
  const first = await handoff.handOff(subject(dir), quiet);
  assert.equal(first?.state, 'reused');
  assert.equal(f.gh.filter(a => a[1] === 'create').length, 0);
  head = 'e'.repeat(40);
  const second = await handoff.handOff(subject(dir), quiet);
  assert.equal(second?.state === 'reused' && second.number, 7);
  assert.equal(f.posts.length, 2);
  assert.notEqual(f.posts[0].body.requestId, f.posts[1].body.requestId);
});

test('Canvas 404 (not deployed) and 409 (conflict) are logged, not retried, and never fail the handoff', async t => {
  for (const [status, link] of [[404, 'not-deployed'], [409, 'conflict'], [500, 'failed']] as const) {
    const dir = directory(t); reported(dir);
    const f = fakes({ status });
    const said: string[] = [];
    const handoff = new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools);
    const outcome = await handoff.handOff(subject(dir), message => said.push(message));
    assert.equal(outcome?.state === 'opened' && outcome.link, link);
    await handoff.handOff(subject(dir), quiet);
    assert.equal(f.posts.length, 1, `${status} is not retried`);
    assert.match(said.join('\n'), status === 404 ? /404/ : status === 409 ? /409/ : /didn't confirm/);
  }
});

test('the flag turns it off, and nothing is pushed without commits ahead, a GitHub remote, gh auth or a stored result', async t => {
  const dir = directory(t);
  const off = fakes({ env: { AGENT_OFFICE_OPORA_AUTO_PR: 'off' } });
  assert.equal(new PullRequestHandoff(dir, 'http://x', 'o', off.tools).handOff(subject(dir), quiet), undefined, 'no stored result, no handoff');
  reported(dir);
  const said: string[] = [];
  assert.deepEqual(await new PullRequestHandoff(dir, 'http://x', 'o', off.tools).handOff(subject(dir), m => said.push(m)), { state: 'skipped', reason: 'AGENT_OFFICE_OPORA_AUTO_PR is off' });
  assert.equal(off.git.length + off.gh.length + off.posts.length, 0);
  assert.match(said[0], /AGENT_OFFICE_OPORA_AUTO_PR is off/);

  const none = fakes({ ahead: 0 });
  const outcome = await new PullRequestHandoff(dir, 'http://x', 'o', none.tools).handOff(subject(dir), quiet);
  assert.equal(outcome?.state, 'skipped');
  assert.equal(none.git.filter(a => a[0] === 'push').length + none.gh.length + none.posts.length, 0);

  const local = fakes();
  local.tools.git = async (args) => { if (args[0] === 'remote') return 'https://gitlab.com/a/b.git'; return args[0] === 'rev-list' ? '1' : HEAD; };
  assert.match((await new PullRequestHandoff(dir, 'http://x', 'o', local.tools).handOff(subject(dir), quiet) as { reason: string }).reason, /GitHub remote/);

  const signedOut = fakes();
  signedOut.tools.gh = async () => { throw new Error('not logged in'); };
  assert.match((await new PullRequestHandoff(dir, 'http://x', 'o', signedOut.tools).handOff(subject(dir), quiet) as { reason: string }).reason, /gh isn't signed in/);
  assert.equal(signedOut.git.filter(a => a[0] === 'push').length, 0);
});

test('a failed push is recorded and leaves the stored result alone', async t => {
  const dir = directory(t); reported(dir);
  const f = fakes();
  const git = f.tools.git;
  f.tools.git = async (args, cwd) => { if (args[0] === 'push') throw new Error('rejected'); return git(args, cwd); };
  const said: string[] = [];
  const outcome = await new PullRequestHandoff(dir, 'http://x', 'o', f.tools).handOff(subject(dir), m => said.push(m));
  assert.equal(outcome?.state, 'failed');
  assert.match(said.join(), /rejected.*Canvas result stands/);
  assert.equal(f.posts.length, 0);
  assert.ok(existsSync(path.join(dir, 'opora-executions', 'execution-1-reported.json')));
});

test('the result helper stores the reported result for the office, and the dispatch hands off from the worker worktree', async t => {
  const dir = directory(t);
  executionPrompt(dir, 'http://localhost:5010', 'office', lease());
  const result = path.join(dir, 'result.json'); writeFileSync(result, JSON.stringify({ summary: 'Ready', artifacts: [] }));
  await reportExecution(path.join(dir, 'opora-executions', 'execution-1.json'), result,
    (async () => new Response(JSON.stringify({ receiptId: 'receipt', executionId: 'execution-1', state: 'reported' }))) as typeof fetch);
  const stored = JSON.parse(readFileSync(path.join(dir, 'opora-executions', 'execution-1-reported.json'), 'utf8'));
  assert.deepEqual(stored, { receiptId: 'receipt', result: { summary: 'Ready', artifacts: [] } });
  assert.doesNotMatch(JSON.stringify(stored), /PRIVATE-token/);

  const f = fakes();
  const dispatch = new ExecutionDispatch('http://localhost:5010', 'office', dir, () => [], () => {}, () => {}, f.tools);
  const info = { id: 'w1', worktree: { path: 'tree', branch: 'office/w1', base: 'd'.repeat(40), from: 'main' } } as WorkerInfo;
  const run = { workerId: 'w1', execution: lease(), cardName: 'Cart page' };
  assert.equal((await dispatch.handOff(run, info, dir, quiet))?.state, 'opened');
  assert.equal(f.git[0][0], 'rev-parse');
  // Once the worker is gone, the worktree it had is still known; release waits for any handoff under way.
  assert.equal((await dispatch.handOff(run, undefined, dir, quiet))?.state, 'opened');
  assert.equal(dispatch.handOff({ workerId: 'w2', execution: lease() }, undefined, dir, quiet), undefined, 'no worktree, no handoff');
});

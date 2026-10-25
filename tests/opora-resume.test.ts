// Resuming a card from its checkpointed steps (F14, F15) and not losing a result Opora stored while the
// helper waited (F21): the claim keeps the progress through its renewal, a resumed run gets the earlier run's
// step commits onto its branch (or is told honestly that they're gone), the result is sent again with the same
// requestId, and a 409 renewal after a stored result ends the run as finished and hands its PR off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecutionClient, type ExecutionLease } from '../src/server/opora/execution-client.js';
import { ExecutionController, EXECUTION_FINISHED } from '../src/server/opora/execution-controller.js';
import { ExecutionDispatch } from '../src/server/opora/execution-dispatch.js';
import { executionPrompt } from '../src/server/opora/execution-prompt.js';
import { recoverStoredResult, storedReceipt } from '../src/server/opora/execution-recovery.js';
import { applyResume, resumeBrief, resumePlan } from '../src/server/opora/execution-resume.js';
import { deliverResult, submitTimeoutMs } from '../src/server/opora/execution-submit.js';
import { reportExecution } from '../src/server/opora/execution-worker.js';
import type { HandoffTools } from '../src/server/opora/pull-request-handoff.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const scope = { project: 'project', workspace: 'work', nodeId: 'card-0123456789abcdef' };
const steps = [{ id: 's1', order: 1, title: 'Model', acceptance: [], dependsOn: [] },
  { id: 's2', order: 2, title: 'API', acceptance: [], dependsOn: ['s1'] },
  { id: 's3', order: 3, title: 'UI', acceptance: [], dependsOn: ['s2'] }];
const assignment = { contextVersion: 'context', documents: {}, steps };
const full = (): ExecutionLease => ({ ...scope, executionId: 'execution-new', token: 'PRIVATE-token', epoch: 7,
  acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64), assignment, state: 'running', serverNow: 100, expiresAt: 1000 });
const progress = { total: 3, done: 2, current: 's3', steps: [{ id: 's1', status: 'done', executionId: 'execution-old' },
  { id: 's2', status: 'done', executionId: 'execution-old' }, { id: 's3', status: 'current', executionId: null }] };
const lean = () => { const { assignment: _a, ...rest } = full(); return { ...rest, contextVersion: 'context' }; };
const read = () => { const { token: _t, serverNow: _s, expiresAt: _e, state: _st, ...rest } = full(); return { ...rest, progress }; };

function directory(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-resume-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(cwd: string, file: string, message: string) { writeFileSync(path.join(cwd, file), message + '\n'); git(cwd, 'add', file); git(cwd, 'commit', '-q', '-m', message); return git(cwd, 'rev-parse', 'HEAD'); }

/** A floor checkout with main and the earlier run's local branch office/byte-563a (s1, a fix-up, s2, never pushed). */
function floor(t: { after(fn: () => void): void }) {
  const dir = directory(t);
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 'office@example.com'); git(dir, 'config', 'user.name', 'Office');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const base = commit(dir, 'README.md', 'base');
  git(dir, 'checkout', '-q', '-b', 'office/byte-563a');
  commit(dir, 'model.txt', 'step s1: model'); commit(dir, 'notes.txt', 'tidy up'); commit(dir, 'api.txt', 'step s2: api');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'main.txt', 'main moved on');
  return { dir, base };
}

test('F14: a re-claimed execution keeps the checkpointed progress through its renewal, so the prompt resumes', async t => {
  const calls: string[] = [];
  const client = new ExecutionClient('http://localhost:5010', 'office', async (url) => {
    const at = new URL(String(url)).pathname; calls.push(at);
    if (at.endsWith('/context')) return Response.json({ available: true, unavailableReason: '', acceptedHead: 'a'.repeat(40), contextVersion: 'context' });
    if (at.endsWith('/claim')) return Response.json(lean());
    if (at.endsWith('/assignment')) return Response.json(read());
    if (at.endsWith('/heartbeat')) return Response.json({ ...lean(), serverNow: 200, expiresAt: 1100 });
    return Response.json({});
  });
  const controller = new ExecutionController(client, () => {}, () => {}, () => 20);
  const { lease } = await controller.claim(scope);
  assert.deepEqual(calls.map(c => c.split('/').pop()), ['context', 'claim', 'assignment', 'heartbeat']);
  assert.deepEqual(lease.progress, progress);
  assert.equal(lease.expiresAt, 1100, 'the renewal still counts');
  const prompt = executionPrompt(directory(t), 'http://localhost:5010', 'office', lease);
  assert.match(prompt, /Progress: an earlier run already reported 2\/3 steps done \(s1, s2\)/);
  assert.match(prompt, /resume at step s3/);
});

test('F15: the earlier run\'s step commits are found on its local branch and cherry-picked onto the fresh one', t => {
  const { dir, base } = floor(t);
  const plan = resumePlan({ ...full(), progress }, [{ executionId: 'execution-old', branch: 'office/byte-563a', base }], dir);
  assert.equal(plan?.state, 'picks');
  assert.deepEqual(plan.state === 'picks' && plan.picks.map(p => p.stepId), ['s1', 's2'], 'only step commits, in the order they were made');
  const tree = path.join(dir, 'tree');
  git(dir, 'worktree', 'add', '-q', '-b', 'office/pixel-e17c', tree, 'main');
  assert.deepEqual(applyResume(tree, plan!), { ok: true });
  assert.deepEqual(git(tree, 'log', '--format=%s', 'main..HEAD').split('\n'), ['step s2: api', 'step s1: model']);
  assert.ok(existsSync(path.join(tree, 'api.txt')) && existsSync(path.join(tree, 'main.txt')) && !existsSync(path.join(tree, 'notes.txt')));
  const brief = resumeBrief(plan);
  assert.match(brief, /cherry-picked that work onto your branch before you started \(s1 [a-f0-9]{12}, s2 [a-f0-9]{12}, from office\/byte-563a\)/);
  assert.match(brief, /Resume at step s3/);
  assert.doesNotMatch(brief, /on main or in the predecessor's PR/);
});

test('F15: when the earlier commits are gone, nothing is picked and the prompt says to redo from s1', t => {
  const { dir, base } = floor(t);
  const gone = resumePlan({ ...full(), progress }, [{ executionId: 'execution-old', branch: 'office/byte-dead', base }], dir);
  assert.equal(gone?.state, 'missing');
  assert.match(resumeBrief(gone), /their commits are not on your branch \(the earlier run's branch office\/byte-dead is gone\).*redo from step s1/);
  const unknown = resumePlan({ ...full(), progress }, [], dir);
  assert.match(resumeBrief(unknown), /this office has no branch of the run that did s1.*redo from step s1/);
  // Nothing done yet: nothing to say, nothing to pick.
  assert.equal(resumePlan({ ...full(), progress: { ...progress, done: 0, steps: [] } }, [], dir), undefined);
  // A pick that conflicts is undone whole.
  const tree = path.join(dir, 'tree');
  git(dir, 'worktree', 'add', '-q', '-b', 'office/clash', tree, 'main');
  commit(tree, 'model.txt', 'something else');
  const plan = resumePlan({ ...full(), progress }, [{ executionId: 'execution-old', branch: 'office/byte-563a', base }], dir)!;
  const head = git(tree, 'rev-parse', 'HEAD');
  assert.equal(applyResume(tree, plan).ok, false);
  assert.equal(git(tree, 'rev-parse', 'HEAD'), head);
  assert.equal(git(tree, 'status', '--porcelain'), '');
});

test('F15: dispatch picks the earlier run\'s commits onto the new worker\'s branch before its first launch', async t => {
  const { dir, base } = floor(t);
  const data = directory(t);
  const runs = [{ workerId: 'b563aaaa', workerName: 'Byte', execution: { ...full(), executionId: 'execution-old' }, branch: 'office/byte-563a', worktreeBase: base, state: 'gone' }];
  const dispatch = new ExecutionDispatch('http://localhost:5010', 'office', data, () => runs, () => {}, () => {});
  dispatch.floorDir = dir;
  dispatch.controller.claim = async () => ({ lease: { ...full(), progress }, deadline: 1_000_000_000 });
  let prompt = '';
  const out = await dispatch.dispatch(scope, async () => '', text => {
    prompt = text;
    git(dir, 'worktree', 'add', '-q', '-b', 'office/pixel-e17c', path.join(dir, 'tree'), 'main');
    const info = { id: 'e17cdddd', name: 'Pixel', status: 'starting', prompt: text, worktree: { path: 'tree', branch: 'office/pixel-e17c', base: git(dir, 'rev-parse', 'main'), from: 'main' } } as WorkerInfo;
    assert.equal(dispatch.guard.check(info), undefined, 'the launch is allowed');
    return info;
  });
  t.after(() => dispatch.controller.forget(out.worker.id));
  assert.match(prompt, /cherry-picked that work onto your branch/);
  assert.deepEqual(git(path.join(dir, 'tree'), 'log', '--format=%s', 'main..HEAD').split('\n'), ['step s2: api', 'step s1: model']);
});

test('F21: the result is sent again with the same requestId after a timeout, and the receipt is kept', async t => {
  const dir = directory(t);
  executionPrompt(dir, 'http://localhost:5010', 'office', full());
  const bundle = path.join(dir, 'opora-executions', 'execution-new.json');
  assert.equal(JSON.parse(readFileSync(bundle, 'utf8')).requestTimeoutMs, 20_000, 'the office timeout, not 8 s');
  const result = path.join(dir, 'result.json');
  writeFileSync(result, JSON.stringify({ summary: 'Done' }));
  const ids: unknown[] = [];
  const send: typeof fetch = async (_url, options) => {
    ids.push(JSON.parse(String(options?.body)).requestId);
    if (ids.length === 1) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    if (ids.length === 2) return new Response('{}', { status: 503 });
    return Response.json({ receiptId: 'receipt', executionId: 'execution-new', state: 'reported' });
  };
  const receipt = await reportExecution(bundle, result, send, () => '', dir, 3, async () => {});
  assert.equal(receipt.receiptId, 'receipt');
  assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 1);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'opora-executions', 'execution-new-reported.json'), 'utf8')).receiptId, 'receipt');
  // A refusal is not retried; giving up keeps the last failure.
  let tries = 0;
  await assert.rejects(deliverResult(async () => { tries++; return new Response('{}', { status: 409 }); }, 1000, 3, async () => {}).then(r => { if (!r.ok) throw new Error(String(r.status)); }), /409/);
  assert.equal(tries, 1);
  await assert.rejects(deliverResult(async () => { throw new Error('down'); }, 1000, 2, async () => {}), /down/);
  assert.equal(submitTimeoutMs({}, { AGENT_OFFICE_OPORA_EXECUTION_TIMEOUT_S: '45' }), 45_000);
  assert.equal(submitTimeoutMs({ requestTimeoutMs: 30_000 }, {}), 30_000);
});

/** A heartbeat refused with 409 after the result was stored by Canvas, but never seen by the helper. */
function refusedController(results: unknown[], data: string) {
  const client = new ExecutionClient('http://localhost:5010', 'office', async (url) => {
    const at = new URL(String(url));
    if (at.pathname.endsWith('/heartbeat')) return new Response('{"detail":"Execution is not running."}', { status: 409 });
    if (at.pathname.endsWith('/results')) return Response.json({ results });
    return Response.json({});
  });
  const stopped: string[] = [];
  const controller = new ExecutionController(client, () => {}, (_id, reason) => stopped.push(reason), () => 0);
  controller.ended = () => false;
  controller.recover = lease => recoverStoredResult(client, data, lease, () => {});
  return { controller, stopped };
}

test('F21: a 409 renewal after Canvas stored the result ends the run as finished, and the PR is handed off', async t => {
  const data = directory(t);
  const receipt = { receiptId: 'receipt-1', executionId: 'execution-new', state: 'reported', requestId: 'r', acceptedRevision: 'a'.repeat(40),
    assignmentDigest: 'b'.repeat(64), result: { summary: 'All four steps', stepResults: [] } };
  const { controller, stopped } = refusedController([receipt], data);
  controller.watch('w1', full(), 1_000_000);
  await (controller as unknown as { beat(id: string, watch: unknown): Promise<void> }).beat('w1', (controller as unknown as { watches: Map<string, unknown> }).watches.get('w1'));
  assert.deepEqual(stopped, [EXECUTION_FINISHED]);
  const saved = JSON.parse(readFileSync(path.join(data, 'opora-executions', 'execution-new-reported.json'), 'utf8'));
  assert.equal(saved.receiptId, 'receipt-1'); assert.equal(saved.result.summary, 'All four steps');

  // The normal hand-off then runs: push opora/<card12>/<exec>, open the PR, link it.
  const pushed: string[][] = [], created: string[][] = [], links: string[] = [];
  const tools: HandoffTools = { env: {},
    git: async args => { if (args[0] === 'push') pushed.push(args); if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'c'.repeat(40);
      if (args[0] === 'rev-list') return '4'; if (args[0] === 'remote') return 'git@github.com:Pletor/ample.git'; return ''; },
    gh: async args => { if (args[1] === 'list') return '[]'; if (args[1] === 'create') { created.push(args); return 'https://github.com/Pletor/ample/pull/21'; } return ''; },
    transport: (async (url: URL) => { links.push(String(url)); return Response.json({}); }) as typeof fetch };
  const dispatch = new ExecutionDispatch('http://localhost:5010', 'office', data, () => [], () => {}, () => {}, tools);
  mkdirSync(path.join(data, 'tree'));
  const info = { id: 'w1', worktree: { path: 'tree', branch: 'office/byte-c666', base: 'd'.repeat(40), from: 'main' } } as WorkerInfo;
  const out = await dispatch.handOff({ workerId: 'w1', execution: full(), cardName: '7.2' }, info, data, () => {});
  assert.equal(out?.state, 'opened');
  assert.deepEqual(pushed[0], ['push', 'origin', 'HEAD:refs/heads/opora/card-0123456/execution-new']);
  assert.equal(created.length, 1);
  assert.ok(links.some(l => l.endsWith('/executions/execution-new/pull-request')));
});

test('F21: a 409 renewal with no stored result stays an error; a receipt for another run or revision does not count', async t => {
  const data = directory(t);
  const { controller, stopped } = refusedController([], data);
  controller.watch('w1', full(), 1_000_000);
  await (controller as unknown as { beat(id: string, watch: unknown): Promise<void> }).beat('w1', (controller as unknown as { watches: Map<string, unknown> }).watches.get('w1'));
  assert.equal(stopped.length, 1); assert.match(stopped[0], /Opora refused renewing the lease \(HTTP 409\)/);
  assert.equal(existsSync(path.join(data, 'opora-executions', 'execution-new-reported.json')), false);
  const ok = { receiptId: 'x', executionId: 'execution-new', state: 'reported', result: { summary: 's' } };
  assert.equal(storedReceipt(full(), [{ ...ok, executionId: 'other' }]), undefined);
  assert.equal(storedReceipt(full(), [{ ...ok, acceptedRevision: 'f'.repeat(40) }]), undefined);
  assert.equal(storedReceipt(full(), [{ ...ok, result: {} }]), undefined);
  assert.equal(storedReceipt(full(), [ok])?.receiptId, 'x');
});

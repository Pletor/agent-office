import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_OPORA } from '../src/shared/opora.js';
import type { GhPull, OporaState, ProcessEvent, QueueTask, WorkerInfo } from '../src/shared/protocol.js';
import { ProcessJournal } from '../src/server/process/journal.js';
import { redact } from '../src/server/process/redact.js';
import { ProcessHub } from '../src/server/process/hub.js';
import { observeProcess, observeTool } from '../src/server/process/observe.js';
import { pullEvents, queueEvents, workerEvents } from '../src/server/process/office-events.js';
import { oporaEvents, oporaSeen, upkeepEvents } from '../src/server/process/opora-events.js';
import { ProcessPush, ProcessPushers, oporaSend, PUSH_REPROBE_MS } from '../src/server/process/push.js';
import { OporaError } from '../src/server/opora/client.js';
import { handlers, views } from '../src/server/ws/handlers/index.js';

const worker = (c: Partial<WorkerInfo> = {}): WorkerInfo => ({ id: 'w1', kind: 'agent', deskId: 'desk-1', name: 'Ada', color: '#06d6a0', status: 'idle', acked: true, createdBy: 't', createdAt: 1, cols: 80, rows: 24, viewers: [], viewerIds: [], worktree: { path: 'work/w1', branch: 'office/w1', base: 'main' }, ...c });
const pull = (c: Partial<GhPull> = {}): GhPull => ({ number: 7, title: 'Fix', state: 'OPEN', isDraft: false, url: 'https://github.com/o/r/pull/7', author: 'ada', labels: [], reviewDecision: '', headRefName: 'office/w1', headRefOid: 'a'.repeat(40), baseRefName: 'main', createdAt: '', updatedAt: '', additions: 1, deletions: 0, checks: 'pending', body: '', closes: [], ...c });
const task = (c: Partial<QueueTask> = {}): QueueTask => ({ id: 't1', title: 'Task', prompt: 'secret prompt text', addedBy: 'bob', addedAt: 1, status: 'queued', ...c });
const ev = { kind: 'x', phase: 'work', state: 'info', title: 't' } as const;

test('the journal is a ring of the last events with a monotonic seq and unique ids', () => {
  const j = new ProcessJournal('f1.boot', () => [], 5);
  for (let i = 0; i < 8; i++) j.add({ ...ev, title: `e${i}` });
  assert.equal(j.seq, 8);
  const all = j.since(0, 100);
  assert.deepEqual(all.map((e) => e.seq), [4, 5, 6, 7, 8]);
  assert.equal(new Set(all.map((e) => e.id)).size, 5);
  assert.equal(all[0].id, 'office:f1.boot:4');
  assert.equal(all[0].schema, 'opora.process-event/1');
  assert.deepEqual(j.since(6).map((e) => e.seq), [7, 8]);
  assert.deepEqual(j.since(0, 2).map((e) => e.seq), [7, 8], 'a limit keeps the newest');
  assert.deepEqual(j.snapshot().seq, 8);
});

test('events never carry tokens, passwords, data-dir paths or overlong text', () => {
  const root = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj';
  const j = new ProcessJournal('f', () => [root]);
  const e = j.add({
    ...ev,
    title: `Bash: curl -H "Authorization: Bearer abcdefghijklmnop" ghp_${'x'.repeat(36)} ${'y'.repeat(200)}`,
    detail: `token=s3cr3t leaseToken: "lt-123456" password=hunter2 https://u:p@host/x ${root}${process.platform === 'win32' ? '\\' : '/'}src/a.ts /home/u/proj/.agent-office/opora-executions/e1.json`,
    tool: { name: 'Bash', target: `echo sk-${'a'.repeat(30)} and more ${'z'.repeat(100)}` },
    refs: { url: 'javascript:alert(1)', pr: -1, branch: 'office/w1' },
  });
  const all = JSON.stringify(e);
  for (const bad of ['abcdefghijklmnop', 'ghp_x', 's3cr3t', 'lt-123456', 'hunter2', 'u:p@', '.agent-office', 'sk-aaaa', root.replace(/\\/g, '\\\\')]) assert.ok(!all.includes(bad), `${bad} leaked: ${all}`);
  assert.ok(e.title.length <= 120 && (e.detail ?? '').length <= 240 && (e.tool?.target ?? '').length <= 80);
  assert.match(e.detail!, /\.[\\/]src[\\/]a\.ts/, 'the checkout folds to .');
  assert.equal(e.refs.url, undefined);
  assert.equal(e.refs.pr, undefined);
  assert.equal(redact(`commit ${'b'.repeat(40)}`, 100), `commit ${'b'.repeat(40)}`, 'a SHA is not a secret');
});

function fakeOffice(id: string, opora: Partial<OporaState> = {}) {
  const refreshes: number[] = [];
  const floor = { id, dir: '/nowhere', opora: { view: () => ({ ...EMPTY_OPORA, ...opora }) }, github: { refresh: () => refreshes.push(Date.now()) } };
  const hub = new ProcessHub((x) => (x === id ? floor : undefined));
  const got: ProcessEvent[] = [];
  hub.onEvent((f, e) => f === id && got.push(e));
  return { floor, hub, got, refreshes };
}

test('a hook sequence becomes turn, tool, failing and needs-input events with the card it runs', async () => {
  const run = { cardId: 'card-9', cardName: 'Card', group: 'dev' as const, workerId: 'w1', by: 'x', startedAt: 1, state: 'working' as const, workspace: 'ws-2' };
  const { floor, hub, got, refreshes } = fakeOffice('hookfloor', { project: { id: 'p1', name: 'P' }, workspace: 'ws-1', runs: [run] });
  hub.noteExecution('w1', 'ex-1');
  const send = (w: WorkerInfo) => observeProcess(floor, { t: 'worker.update', worker: w }, hub);
  send(worker({ status: 'idle' }));
  send(worker({ status: 'working', activity: 'the user prompt, never sent' }));
  observeTool(floor, worker({ status: 'working', action: 'test' }), 'Bash: npm test', hub);
  send(worker({ status: 'working', action: 'failing' }));
  send(worker({ status: 'needs_input' }));
  send(worker({ status: 'done', pr: { number: 7, url: 'https://github.com/o/r/pull/7' } }));
  observeProcess(floor, { t: 'worker.remove', workerId: 'w1' }, hub);
  assert.deepEqual(got.map((e) => e.kind), ['worker.status', 'turn.start', 'tool.use', 'tool.use', 'needs.input', 'worker.status', 'pr.opened', 'worker.status']);
  const tool = got[2];
  assert.deepEqual(tool.tool, { name: 'Bash', action: 'test', target: 'npm test' });
  assert.equal(tool.phase, 'checks');
  assert.deepEqual([got[3].state, got[3].tool?.action], ['fail', 'failing']);
  assert.equal(got[4].state, 'blocked');
  for (const e of got.slice(0, 7)) assert.deepEqual([e.refs.project, e.refs.workspace, e.refs.cardId, e.refs.executionId, e.refs.floor], ['p1', 'ws-2', 'card-9', 'ex-1', 'hookfloor']);
  assert.ok(!JSON.stringify(got).includes('user prompt'));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(refreshes.length, 1, "a worker's own PR asks GitHub at once");
  // GitHub then reports the same PR: no second pr.opened.
  observeProcess(floor, { t: 'gh.pulls', state: { items: [], fetchedAt: 1, loading: false } }, hub);
  observeProcess(floor, { t: 'gh.pulls', state: { items: [pull()], fetchedAt: 2, loading: false } }, hub);
  assert.equal(got.filter((e) => e.kind === 'pr.opened').length, 1);
});

test('PR board diffs: opened, CI transitions, review decisions and merge', () => {
  assert.deepEqual(pullEvents(undefined, [pull()]), [], 'the first look is a baseline');
  const prev = new Map([[7, pull()]]);
  const kinds = (items: GhPull[]) => pullEvents(prev, items).map((e) => `${e.kind}:${e.state}`);
  assert.deepEqual(kinds([pull(), pull({ number: 8 })]), ['pr.opened:start']);
  assert.deepEqual(kinds([pull({ checks: 'pass' })]), ['pr.checks:ok']);
  assert.deepEqual(kinds([pull({ checks: 'fail' })]), ['pr.checks:fail']);
  assert.deepEqual(kinds([pull({ reviewDecision: 'CHANGES_REQUESTED' })]), ['pr.review:blocked']);
  assert.deepEqual(kinds([pull({ reviewDecision: 'APPROVED' })]), ['pr.review:ok']);
  assert.deepEqual(kinds([pull({ state: 'MERGED' })]), ['pr.merged:ok']);
  const e = pullEvents(prev, [pull({ checks: 'pass' })], () => worker())[0];
  assert.deepEqual([e.source, e.refs?.workerId, e.refs?.pr, e.refs?.branch], ['github', 'w1', 7, 'office/w1']);
});

test('queue and worker diffs say only what the source confirmed', () => {
  const prev = new Map([['t1', task()]]);
  assert.deepEqual(queueEvents(undefined, [task()]), []);
  const done = queueEvents(prev, [task({ status: 'done', outcome: 'done' })])[0];
  assert.equal(done.state, 'info', 'a finished task is not a pass');
  assert.equal(queueEvents(prev, [task({ status: 'done', outcome: 'failed' })])[0].state, 'fail');
  assert.equal(queueEvents(prev, [])[0].title, 'Úkol odebrán z fronty: Task');
  assert.ok(!JSON.stringify(queueEvents(new Map(), [task()])).includes('secret prompt'));
  assert.equal(workerEvents(worker({ status: 'working' }), worker({ status: 'done' }))[0].kind, 'turn.end');
  assert.equal(workerEvents(worker({ status: 'working' }), worker({ status: 'done' }))[0].state, 'info');
});

test('Opora canvas diffs: card status, stage, new activity and reported runs', () => {
  const card = { id: 'c1', name: 'Login', status: 'frontier' as const, group: 'dev' as const, stage: 'work' };
  const base: OporaState = { ...EMPTY_OPORA, connected: true, project: { id: 'p', name: 'P' }, workspace: 'w', cards: [card], activity: [{ id: 5, at: '', agent: 'a', what: 'claimed', nodeIds: ['c1'], ok: true }], runs: [{ cardId: 'c1', cardName: 'Login', group: 'dev', by: 'x', startedAt: 1, state: 'working' }] };
  assert.deepEqual(oporaEvents(undefined, base), []);
  const next: OporaState = { ...base, cards: [{ ...card, status: 'claimed', stage: 'review' }], activity: [...base.activity, { id: 6, at: '2026-01-01T00:00:00Z', agent: 'b', what: 'wrote a card', nodeIds: ['c1'], ok: false }], runs: [{ ...base.runs[0], state: 'reported' as 'done' }] };
  assert.deepEqual(oporaEvents(oporaSeen(base), next).map((e) => `${e.kind}:${e.phase}:${e.state}`), ['card.status:work:progress', 'stage:review:progress', 'activity:work:fail', 'run.result:work:ok']);
  assert.deepEqual(oporaEvents(oporaSeen(base), { ...next, workspace: 'other' }), [], 'another workspace is a new baseline');
  const pass = { upkeep: [{ number: 3, state: 'current' as const }, { number: 4, state: 'human' as const }], guard: { state: 'reverted' as const, head: 'h', culprit: 'c'.repeat(40) } };
  assert.deepEqual(upkeepEvents(pass).map((e) => `${e.kind}:${e.state}`), ['upkeep:blocked', 'guard:blocked']);
  assert.deepEqual(upkeepEvents(pass, 'reverted@h').map((e) => e.kind), ['upkeep'], 'the same guard verdict is said once');
});

test('the hub skips unknown floors, resolves Opora agent names and never throws from a sink', () => {
  const { hub, got } = fakeOffice('f9');
  hub.onEvent(() => {
    throw new Error('boom');
  });
  assert.equal(hub.emit('nope', ev), undefined);
  assert.ok(hub.emit('office-f9', ev));
  assert.ok(hub.emit('office-f9-review', ev));
  assert.ok(hub.emit('office-isolated-f9', ev));
  assert.equal(got.length, 3);
  assert.equal(hub.snapshot('f9', 2).events.length, 1);
});

function clock() {
  let now = 0;
  const pending: { at: number; fn: () => void }[] = [];
  return {
    timers: { set: (fn: () => void, ms: number) => pending.push({ at: now + ms, fn }), clear: () => undefined, now: () => now },
    async advance(ms: number) {
      now += ms;
      for (;;) {
        const due = pending.filter((p) => p.at <= now);
        if (!due.length) break;
        for (const p of due) pending.splice(pending.indexOf(p), 1), p.fn();
        await new Promise((r) => setTimeout(r, 0));
      }
    },
    get pending() {
      return pending.length;
    },
  };
}

const events = (n: number, from = 1): ProcessEvent[] => {
  const j = new ProcessJournal('p');
  for (let i = 1; i < from; i++) j.add(ev);
  return Array.from({ length: n }, () => j.add({ ...ev, refs: { project: 'p1', workspace: 'w1' } }));
};

test('Opora push batches 50 within 250 ms, retries the same batch, and backs off quietly on 404', async () => {
  const c = clock();
  const bodies: { url: string; body: { events: ProcessEvent[] } }[] = [];
  let status = 500;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: URL, init: RequestInit) => {
    bodies.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(status === 200 ? '{}' : '{"detail":"no"}', { status });
  }) as typeof fetch;
  try {
    const push = new ProcessPush('http://127.0.0.1:9', oporaSend, c.timers);
    for (const e of events(120)) push.add(e);
    assert.equal(bodies.length, 0, 'nothing is sent synchronously');
    await c.advance(250);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].url, 'http://127.0.0.1:9/api/oporahub/process-events');
    assert.equal(bodies[0].body.events.length, 50);
    status = 200;
    await c.advance(1000);
    assert.deepEqual(bodies.slice(1).map((b) => b.body.events[0].seq), [1, 51, 101], 'the failed batch is sent again from its cursor');
    assert.equal(push.pending, 0);
    status = 404;
    push.add(events(1)[0]);
    await c.advance(250);
    assert.equal(push.missing, true);
    const sentBefore = bodies.length;
    push.add(events(1)[0]);
    await c.advance(30_000);
    assert.equal(bodies.length, sentBefore, 'no requests while Opora lacks the endpoint');
    status = 200;
    await c.advance(PUSH_REPROBE_MS);
    assert.equal(push.pending, 0, 're-probed after a minute');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the push queue is bounded, and only events of an Opora project are pushed', async () => {
  const c = clock();
  const push = new ProcessPush('b', () => Promise.reject(new OporaError(0, 'down')), c.timers, 10);
  for (const e of events(25)) push.add(e);
  assert.equal(push.pending, 10);
  assert.equal(push.dropped, 15);
  const made: string[] = [];
  const pushers = new ProcessPushers((base) => (made.push(base), push));
  pushers.add('b', { ...events(1)[0], refs: {} });
  pushers.add(undefined, events(1)[0]);
  assert.deepEqual(made, []);
  pushers.add('b', events(1)[0]);
  assert.deepEqual(made, ['b']);
  pushers.stop();
});

test('the process domain is registered: its handler and its piece of the floor view', () => {
  assert.equal(typeof handlers['process.since'], 'function');
  assert.equal(typeof views.process, 'function');
  assert.deepEqual(views.process({} as never, undefined), { events: [], seq: 0 });
});

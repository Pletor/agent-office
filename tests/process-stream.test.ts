import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EMPTY_OPORA } from '../src/shared/opora.js';
import type { OporaState, QueueTask } from '../src/shared/protocol.js';
import { ProcessHub } from '../src/server/process/hub.js';
import { observeProcess } from '../src/server/process/observe.js';
import { queueEvents } from '../src/server/process/office-events.js';
import { classify, outboxToProcess, type OutboxEvent } from '../src/server/process/opora-outbox.js';
import { OporaStream, OporaStreams, type StreamOptions } from '../src/server/process/opora-stream.js';
import { ProcessPush, ProcessPushers } from '../src/server/process/push.js';
import { OporaError } from '../src/server/opora/client.js';
import { LaneResolver } from '../src/client/features/process-wall/lanes.js';
import { sourceHealth } from '../src/client/features/process-wall/live.js';

const out = (kind: string, c: Partial<OutboxEvent> = {}): OutboxEvent => ({ id: 1, at: '2026-10-22T01:02:03.456Z', kind, projectId: 'p1', workspaceId: 'w1', nodeId: 'card-a', executionId: null, stepId: null, prNumber: null, stage: null, health: null, actor: { kind: 'agent', name: 'agent:worker' }, data: {}, ...c });

test('outbox kinds map to the wall\'s phases and states', () => {
  const table: [OutboxEvent, string, string][] = [
    [out('lease.claimed'), 'work', 'start'],
    [out('lease.heartbeat'), 'work', 'progress'],
    [out('lease.expired'), 'work', 'fail'],
    [out('result.reported'), 'work', 'ok'],
    [out('step.started', { stepId: 's1', data: { title: 'Napsat kód' } }), 'work', 'start'],
    [out('step.done', { stepId: 's2', data: { title: 'Spustit testy' } }), 'checks', 'ok'],
    [out('step.failed', { stepId: 'verify' }), 'checks', 'fail'],
    [out('pr.linked', { prNumber: 12 }), 'review', 'info'],
    [out('review.round', { data: { round: 2 } }), 'review', 'progress'],
    [out('review.finding', { data: { status: 'open' } }), 'review', 'wait'],
    [out('gate.changed', { data: { gate: { status: 'blocked' } } }), 'checks', 'blocked'],
    [out('gate.changed', { data: { gate: { status: 'ready' } } }), 'checks', 'ok'],
    [out('formal.result', { data: { outcome: 'counterexample' } }), 'checks', 'fail'],
    [out('formal.result', { data: { outcome: 'proved' } }), 'checks', 'ok'],
    [out('decision.created', { data: { decision: 'accept' } }), 'plan', 'blocked'],
    [out('decision.created'), 'intake', 'blocked'],
    [out('decision.resolved', { data: { decision: 'close_card' } }), 'merge', 'ok'],
    [out('changeset.proposed'), 'plan', 'info'],
    [out('changeset.accepted'), 'plan', 'ok'],
    [out('stage.changed', { stage: 'review', health: 'waiting' }), 'review', 'wait'],
    [out('stage.changed'), 'plan', 'info'],
    [out('autorebase.done'), 'merge', 'ok'],
    [out('autorebase.conflict'), 'merge', 'blocked'],
    [out('merge.done', { data: { mergeSha: 'abc123' } }), 'merge', 'ok'],
    [out('writeback.done'), 'merge', 'ok'],
    [out('card.closed'), 'memory', 'ok'],
    [out('something.new'), 'work', 'info'],
  ];
  for (const [e, phase, state] of table) assert.deepEqual(classify(e).slice(0, 2), [phase, state], e.kind);
  assert.equal(classify(out('review.round', { data: { round: 3 } }))[2], 'Kolo review 3');
});

test('an outbox event becomes a process event with its refs; its own process fields win', () => {
  const p = outboxToProcess(out('merge.done', { prNumber: 7, executionId: 'ex1', data: { mergeSha: 'abc123' } }))!;
  assert.equal(p.source, 'opora');
  assert.equal(p.kind, 'merge.done');
  assert.equal(p.at, '2026-10-22T01:02:03.456Z');
  assert.deepEqual(p.refs, { project: 'p1', workspace: 'w1', cardId: 'card-a', executionId: 'ex1', pr: 7, sha: 'abc123' });
  assert.deepEqual(p.actor, { kind: 'agent', name: 'agent:worker' });
  const own = outboxToProcess(out('lease.claimed', { source: 'opora', phase: 'intake', state: 'wait', title: 'Vlastní titulek', detail: 'víc', refs: { project: 'p1', workspace: 'w1', cardId: 'X9' } }))!;
  assert.deepEqual([own.phase, own.state, own.title, own.detail, own.refs?.cardId], ['intake', 'wait', 'Vlastní titulek', 'víc', 'X9']);
  assert.equal(outboxToProcess(out('lease.claimed', { phase: 'nonsense' }))!.phase, 'work', 'an unknown phase falls back to the kind');
});

test('the office\'s own events echoed back by the stream are skipped', () => {
  assert.equal(outboxToProcess(out('tool.use', { source: 'office' })), undefined);
  assert.equal(outboxToProcess(out('pr.checks', { source: 'github' })), undefined);
  assert.equal(outboxToProcess({ data: {} } as OutboxEvent), undefined);
  assert.ok(outboxToProcess(out('lease.claimed', { source: 'opora' })));
});

test('stream-derived events are never pushed back to Opora', () => {
  const got: string[] = [];
  const pushers = new ProcessPushers(() => ({ add: (e: { source: string }) => got.push(e.source), stop() {} }) as unknown as ProcessPush);
  const base = { schema: 'opora.process-event/1', seq: 1, at: '', kind: 'k', phase: 'work', state: 'info', title: 't', refs: { project: 'p', workspace: 'w' } } as const;
  pushers.add('http://o', { ...base, id: 'a', source: 'opora' });
  pushers.add('http://o', { ...base, id: 'b', source: 'office' });
  pushers.add('http://o', { ...base, id: 'c', source: 'github' });
  pushers.add('http://o', { ...base, id: 'd', source: 'office', refs: { project: 'p' } });
  assert.deepEqual(got, ['office', 'github'], 'only office and GitHub events, with a project and workspace');
});

test('a batch Opora refuses for good (422) is dropped, not retried', async () => {
  let calls = 0;
  const timers = { set: () => 0, clear() {}, now: () => 0 };
  const p = new ProcessPush('http://o', async () => { calls++; throw new OporaError(422, 'Opora said 422: nothing accepted'); }, timers);
  const e = { schema: 'opora.process-event/1', id: 'x', seq: 1, at: '', source: 'office', kind: 'k', phase: 'work', state: 'info', title: 't', refs: { project: 'p', workspace: 'w' } } as const;
  p.add(e);
  await p.flush();
  assert.equal(calls, 1);
  assert.equal(p.pending, 0);
});

test('while the stream is live, the bridge\'s card status and stage are not journaled twice', () => {
  const hub = new ProcessHub((id) => (id === 'f' ? { id, dir: '/x' } : undefined));
  const card = (status: 'frontier' | 'claimed', stage?: string) => ({ id: 'C1', name: 'Karta', status, sectorId: null, ...(stage ? { stage } : {}) });
  const state = (status: 'frontier' | 'claimed', stage?: string): OporaState => ({ ...EMPTY_OPORA, connected: true, project: { id: 'p', name: 'P' }, workspace: 'w', cards: [card(status, stage) as never] });
  const floor = { id: 'f' };
  observeProcess(floor, { t: 'opora', state: state('frontier') }, hub);
  observeProcess(floor, { t: 'opora', state: state('claimed', 'work') }, hub);
  assert.deepEqual(hub.snapshot('f').events.map((e) => e.kind), ['card.status', 'stage']);
  hub.streams.set('f', { connected: true });
  observeProcess(floor, { t: 'opora', state: state('frontier', 'plan') }, hub);
  assert.equal(hub.snapshot('f').events.length, 2, 'the stream said it already');
  assert.deepEqual(hub.snapshot('f').stream, { connected: true });
});

test('queue events carry their task, and the wall\'s lanes follow it rather than the title', () => {
  const t = (c: Partial<QueueTask>): QueueTask => ({ id: 't1', title: 'Same', prompt: '', addedBy: 'b', addedAt: 1, status: 'queued', ...c });
  const [e] = queueEvents(new Map(), [t({ id: 't2' })]);
  assert.equal(e.refs?.task, 't2');
  const hub = new ProcessHub((id) => ({ id, dir: '/x' }));
  const journaled = hub.emit('f', e)!;
  assert.equal(journaled.refs.task, 't2');
  const r = new LaneResolver({ events: [], workers: [], tasks: [t({ id: 't1' }), t({ id: 't2' })], pulls: [], runs: [], cards: [] });
  assert.equal(r.key(journaled), 'task:t2', 'two tasks with the same title: the ref decides');
});

test('the Opora chip reads the stream: live, stale while only the polls answer, disconnected', () => {
  const now = 10_000_000;
  const chip = (stream: { connected: boolean; lastEventAt?: string } | undefined, connected = true) => {
    const h = sourceHealth({ up: true, events: [], opora: { connected, linked: true }, stream, github: { fetchedAt: 0, loading: false }, now })[1];
    return [h.tone, h.text];
  };
  assert.deepEqual(chip({ connected: true, lastEventAt: new Date(now - 4000).toISOString() }), ['good', 'živě · 4 s']);
  assert.deepEqual(chip({ connected: true }, false), ['good', 'živě · bez událostí'], 'the stream answering is Opora answering');
  assert.deepEqual(chip({ connected: false, lastEventAt: new Date(now - 120_000).toISOString() }), ['warn', 'stáří 2 min']);
  assert.deepEqual(chip({ connected: false }, false), ['bad', 'odpojeno']);
  assert.deepEqual(chip(undefined), ['good', 'živě · bez událostí'], 'no stream: as before');
});

/** A fake Opora: the events head, and an SSE stream scripted per connection. */
function fakeOpora(script: ((req: http.IncomingMessage, res: http.ServerResponse, n: number) => void)[]) {
  const seen: { lastEventId?: string; since: string | null; actor?: string }[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/api/oporahub/events') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ events: [], cursor: 0, head: 5, gap: false }));
    }
    if (url.pathname !== '/api/oporahub/events/stream') return res.writeHead(404).end();
    seen.push({ lastEventId: req.headers['last-event-id'] as string | undefined, since: url.searchParams.get('since'), actor: req.headers['x-opora-actor'] as string | undefined });
    const step = script[seen.length - 1];
    if (!step) return res.writeHead(429).end('{"code":"events_busy"}');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('retry: 2000\n\n');
    step(req, res, seen.length);
  });
  return new Promise<{ base: string; seen: typeof seen; close(): void }>((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => { server.closeAllConnections(); server.close(); } });
  }));
}

const frame = (id: number, e: Partial<OutboxEvent>) => `id: ${id}\ndata: ${JSON.stringify({ ...out(e.kind ?? 'lease.claimed'), id, ...e })}\n\n`;

function until(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (check()) { clearInterval(t); resolve(); } else if (Date.now() - start > ms) { clearInterval(t); reject(new Error('timed out')); }
    }, 10);
  });
}

test('the stream starts at the head, resumes with Last-Event-ID after Canvas closes it, survives a gap, and stops', async () => {
  const opora = await fakeOpora([
    (_req, res) => { res.write(frame(6, { kind: 'lease.claimed' })); res.write(': heartbeat\n\n'); res.end(frame(7, { kind: 'tool.use', source: 'office' })); },
    (_req, res) => { res.write('event: gap\ndata: {"gap": true}\n\n'); res.write(frame(8, { kind: 'merge.done' })); },
  ]);
  const hub = new ProcessHub((id) => ({ id, dir: '/x' }));
  const health: unknown[] = [];
  const logs: string[] = [];
  const streams = new OporaStreams(hub, (_f, h) => health.push(h), (o) => new OporaStream({ ...o, backoffMs: [20] }).start(), (l) => logs.push(l));
  try {
    streams.sync('f', { url: opora.base, project: { id: 'p1' }, workspace: 'w1' });
    streams.sync('f', { url: opora.base, project: { id: 'p1' }, workspace: 'w1' });
    assert.equal(streams.size, 1, 'one stream per floor');
    await until(() => hub.snapshot('f').events.length >= 2);
    assert.deepEqual(hub.snapshot('f').events.map((e) => [e.source, e.kind]), [['opora', 'lease.claimed'], ['opora', 'merge.done']], 'the office echo is skipped');
    assert.equal(opora.seen[0].since, '5', 'a new stream follows from the head, not from the beginning');
    assert.equal(opora.seen[0].actor, 'agent; name=office-f');
    assert.equal(opora.seen[1].lastEventId, '7', 'it resumes after the last event it saw, the echo included');
    assert.equal(logs.length, 1);
    assert.equal(hub.snapshot('f').stream?.connected, true);
    assert.ok(hub.snapshot('f').stream?.lastEventAt);
  } finally {
    streams.stopAll();
    opora.close();
  }
  assert.equal(hub.snapshot('f').stream, undefined);
  assert.deepEqual(health.at(-1), undefined, 'the floor is told it has no stream now');
});

test('a refused or broken stream backs off and says it is disconnected, then reconnects', async () => {
  let n = 0;
  const opora = await fakeOpora([
    (_req, res) => { n++; res.destroy(); },
    (_req, res) => { n++; res.write(frame(6, { kind: 'card.closed' })); },
  ]);
  const states: boolean[] = [];
  const s = new OporaStream({ base: opora.base, project: 'p', workspace: 'w', agent: 'office-f', cursor: '3', backoffMs: [20, 40], onEvent: () => undefined, onHealth: (h) => states.push(h.connected) } as StreamOptions).start();
  try {
    await until(() => s.cursor === '6');
    assert.equal(n, 2);
    assert.equal(opora.seen[0].lastEventId, '3', 'a known cursor needs no head');
    assert.equal(s.connected, true);
    assert.ok(states.includes(true));
  } finally {
    s.stop();
    opora.close();
  }
});

test('a silent connection is dropped and reopened; a planned reopen keeps it connected', async () => {
  const opora = await fakeOpora([
    () => { /* never says anything again */ },
    (_req, res) => { res.write(frame(9, {})); },
    (_req, res) => { res.write(frame(10, {})); },
  ]);
  const flips: boolean[] = [];
  const s = new OporaStream({ base: opora.base, project: 'p', workspace: 'w', agent: 'a', cursor: '1', silentMs: 80, reopenMs: 250, backoffMs: [10], onEvent: () => undefined, onHealth: (h) => flips.push(h.connected) }).start();
  try {
    await until(() => s.cursor === '10');
    assert.equal(opora.seen[2].lastEventId, '9');
    assert.ok(s.opened >= 3);
  } finally {
    s.stop();
    opora.close();
  }
});

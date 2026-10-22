import test from 'node:test';
import assert from 'node:assert/strict';
import type { GhPull, OporaRun, ProcessEvent, QueueTask, WorkerInfo } from '../src/shared/protocol.js';
import { buildBoard, initials, LaneResolver, type BoardInput } from '../src/client/features/process-wall/lanes.js';
import { ageWords, lastEventLabel, liveness, sourceHealth, SILENT_MS } from '../src/client/features/process-wall/live.js';
import { WallMotion } from '../src/client/features/process-wall/motion.js';

const worker = (changes: Partial<WorkerInfo> = {}): WorkerInfo => ({ id: 'w1', kind: 'agent', deskId: 'desk-1', name: 'Vývojář 1', color: '#06d6a0', status: 'working', acked: false, createdBy: 'test', createdAt: 1, cols: 80, rows: 24, viewers: [], viewerIds: [], worktree: { path: 'work/w1', branch: 'office/w1', base: 'main' }, ...changes });
const pull = (changes: Partial<GhPull> = {}): GhPull => ({ number: 12, title: 'Change', state: 'OPEN', isDraft: false, url: 'https://github.com/team/repo/pull/12', author: 'test', labels: [], reviewDecision: '', headRefName: 'office/w1', headRefOid: 'abc', baseRefName: 'main', createdAt: '', updatedAt: '', additions: 2, deletions: 1, checks: 'none', body: '', closes: [], ...changes });
const task = (changes: Partial<QueueTask> = {}): QueueTask => ({ id: 't1', title: 'Task', prompt: '', addedBy: 'test', addedAt: 1, status: 'running', workerId: 'w1', ...changes });
const run = (changes: Partial<OporaRun> = {}): OporaRun => ({ cardId: 'H07', cardName: 'Knihovna — sloty', group: 'build' as OporaRun['group'], workerId: 'w1', workerName: 'Vývojář 1', by: 'x', startedAt: 1, state: 'working', ...changes });
let seq = 0;
const ev = (changes: Partial<ProcessEvent> = {}): ProcessEvent => {
  seq++;
  return { schema: 'opora.process-event/1', id: `office:f.b:${seq}`, seq, at: new Date(1_000_000 + seq * 1000).toISOString(), source: 'office', kind: 'tool.use', phase: 'work', state: 'progress', title: `event ${seq}`, refs: {}, ...changes };
};
const input = (changes: Partial<BoardInput> = {}): BoardInput => ({ events: [], workers: [], tasks: [], pulls: [], runs: [], cards: [], ...changes });

test('nothing reported and nothing known: no lanes, nothing invented', () => {
  const b = buildBoard(input());
  assert.equal(b.lanes.length, 0); assert.equal(b.blockers.length, 0); assert.equal(b.lastAt, 0);
  assert.deepEqual(b.counts, { cards: 0, working: 0, waiting: 0, failed: 0 });
});

test('lane key: the card first, then the queue task, then worker and branch, then the PR', () => {
  const r = new LaneResolver(input({ workers: [worker()], tasks: [task({ id: 't9', workerId: 'w2', title: 'Fix it' })], runs: [run({ workerId: 'w3' })] }));
  assert.equal(r.key(ev({ refs: { cardId: 'C1', workerId: 'w1' } })), 'card:C1');
  assert.equal(r.key(ev({ refs: { workerId: 'w3' } })), 'card:H07', 'a worker on an Opora run belongs to its card');
  assert.equal(r.key(ev({ refs: { workerId: 'w2' } })), 'task:t9');
  assert.equal(r.key(ev({ kind: 'queue.task', title: 'Úkol ve frontě: Fix it', refs: {} })), 'task:t9');
  assert.equal(r.key(ev({ refs: { workerId: 'w1' } })), 'worker:w1:office/w1');
  assert.equal(r.key(ev({ refs: { branch: 'office/w1' } })), 'worker:w1:office/w1');
  assert.equal(r.key(ev({ source: 'github', refs: { pr: 77 } })), 'pr:77');
  assert.equal(r.key(ev({ kind: 'guard', phase: 'merge', refs: { sha: 'abc' } })), 'main');
  assert.equal(r.key(ev({ kind: 'activity', refs: {} })), undefined);
});

test('phase follows the latest non-info event; a memory recall and info events do not move it', () => {
  const events = [
    ev({ refs: { cardId: 'H07' }, kind: 'queue.task', phase: 'intake', state: 'start' }),
    ev({ refs: { cardId: 'H07' }, kind: 'pr.checks', phase: 'checks', state: 'ok' }),
    ev({ refs: { cardId: 'H07' }, kind: 'turn.end', phase: 'work', state: 'info' }),
    ev({ refs: { cardId: 'H07' }, kind: 'memory.recall', phase: 'memory', state: 'ok' }),
  ];
  const [lane] = buildBoard(input({ events, cards: [{ id: 'H07', name: 'Knihovna', status: 'claimed', group: 'build' as never }] })).lanes;
  assert.equal(lane.name, 'Knihovna'); assert.equal(lane.phase, 3); assert.equal(lane.marker, 'ok');
  assert.deepEqual(lane.trail, ['seen', null, 'seen', 'ok', null, null, 'ok']);
  assert.equal(lane.last?.kind, 'memory.recall'); assert.equal(lane.events.length, 4);
});

test('store work shows as a lane with no marker before it reports anything', () => {
  const b = buildBoard(input({ workers: [worker({ status: 'idle' })], tasks: [task({ id: 't2', workerId: undefined, status: 'queued', title: 'Queued' })], runs: [run({ workerId: 'w5' })] }));
  assert.deepEqual(b.lanes.map((l) => l.key).sort(), ['card:H07', 'task:t2', 'worker:w1:office/w1']);
  for (const l of b.lanes) assert.equal(l.marker, 'none');
  assert.equal(b.lanes.find((l) => l.key === 'card:H07')?.initials, 'V1');
  assert.deepEqual(b.phaseCounts, [0, 0, 0, 0, 0, 0, 0]);
});

test('blockers: needs input, failing tool, CI fail, changes requested, guard red, refused claim, failing heartbeat', () => {
  const b = buildBoard(input({
    workers: [worker({ status: 'needs_input' }), worker({ id: 'w2', name: 'Kontrolor', worktree: { path: 'p', branch: 'b2', base: 'main' } })],
    events: [
      ev({ kind: 'needs.input', state: 'blocked', refs: { workerId: 'w1' } }),
      ev({ kind: 'tool.use', phase: 'checks', state: 'fail', tool: { name: 'tests', action: 'failing' }, refs: { workerId: 'w2' } }),
      ev({ source: 'github', kind: 'pr.checks', phase: 'checks', state: 'fail', refs: { pr: 31 } }),
      ev({ source: 'github', kind: 'pr.review', phase: 'review', state: 'blocked', refs: { pr: 30 } }),
      ev({ kind: 'guard', phase: 'merge', state: 'fail', refs: { sha: 'x' } }),
      ev({ kind: 'run.claim', state: 'fail', refs: { cardId: 'C9' } }),
      ev({ kind: 'run.heartbeat', state: 'wait', refs: { cardId: 'C8' } }),
    ],
  }));
  const text = Object.fromEntries(b.blockers.map((x) => [x.lane, x.text]));
  assert.deepEqual(text, { 'worker:w1:office/w1': 'čeká na vás', 'worker:w2:b2': 'testy nebo build selhávají', 'pr:31': 'CI selhalo', 'pr:30': 'změny požadovány', main: 'guard červený', 'card:C9': 'převzetí odmítnuto', 'card:C8': 'heartbeat selhává' });
  assert.equal(b.blockers.find((x) => x.lane === 'worker:w1:office/w1')?.human, true);
  assert.equal(b.counts.waiting, 3); assert.equal(b.counts.failed, 4); assert.equal(b.counts.working, 1);
  assert.ok(b.lanes.slice(0, 7).every((l) => l.blocker), 'blockers come first');
});

test('the store\'s current state overrules an old blocking event', () => {
  const events = [ev({ kind: 'needs.input', state: 'blocked', refs: { workerId: 'w1', pr: 12 } }), ev({ source: 'github', kind: 'pr.checks', phase: 'checks', state: 'fail', refs: { pr: 12 } })];
  const b = buildBoard(input({ workers: [worker({ status: 'working' })], pulls: [pull({ checks: 'pass' })], events }));
  assert.equal(b.blockers.length, 0, 'worker answered and CI is green again');
  const still = buildBoard(input({ workers: [worker({ status: 'working' })], pulls: [pull({ checks: 'fail' })], events }));
  assert.equal(still.blockers[0].text, 'CI selhalo');
});

test('lanes sort blockers first, then the most recent event', () => {
  const b = buildBoard(input({ events: [ev({ refs: { cardId: 'A' } }), ev({ refs: { cardId: 'B' } }), ev({ kind: 'guard', phase: 'merge', state: 'fail', refs: {} })] }));
  assert.deepEqual(b.lanes.map((l) => l.key), ['main', 'card:B', 'card:A']);
});

test('initials for the marker', () => {
  assert.equal(initials('Vývojář 1'), 'V1'); assert.equal(initials('Kontrolor'), 'KO'); assert.equal(initials(''), '—'); assert.equal(initials(undefined), '—');
});

test('live, disconnected, syncing, and silent while workers say they work', () => {
  const now = 10_000_000;
  assert.equal(liveness({ up: false, synced: true, lastAt: now, anyWorking: false, now }).state, 'off');
  assert.equal(liveness({ up: true, synced: false, lastAt: 0, anyWorking: false, now }).state, 'sync');
  assert.equal(liveness({ up: true, synced: true, lastAt: 0, anyWorking: false, now }).state, 'live');
  assert.equal(liveness({ up: true, synced: true, lastAt: now - SILENT_MS - 1, anyWorking: true, now }).state, 'off');
  assert.equal(liveness({ up: true, synced: true, lastAt: now - 1000, anyWorking: true, now }).state, 'live');
  assert.equal(lastEventLabel(0, now), 'zatím bez událostí');
  assert.equal(lastEventLabel(now - 12_000, now), 'poslední událost před 12 s');
  assert.equal(ageWords(180_000), '3 min');
});

test('source health says connected, stale or disconnected, never a guess', () => {
  const now = 5_000_000;
  const h = sourceHealth({ up: true, events: [ev({ source: 'office', at: new Date(now - 12_000).toISOString() })], opora: { connected: false, linked: true }, github: { fetchedAt: now - 400_000, loading: false }, now });
  assert.deepEqual(h.map((x) => [x.name, x.tone, x.text]), [['Kancelář', 'good', 'živě · 12 s'], ['Opora', 'bad', 'odpojeno'], ['GitHub', 'warn', 'stáří 6 min'], ['OpenViking', 'idle', 'ověřit v Paměti']]);
  assert.equal(sourceHealth({ up: false, events: [], opora: { connected: true, linked: false }, github: { fetchedAt: 0, error: 'x', loading: false }, now })[0].text, 'odpojeno');
});

test('motion: the first look is a baseline; a phase change slides, a tool call pulses, a failure shakes; reduced motion never moves', () => {
  const m = new WallMotion();
  const lane = (phase: number, last: ProcessEvent) => buildBoard(input({ events: [last] })).lanes.map((l) => ({ ...l, phase }));
  const first = ev({ refs: { cardId: 'X' }, state: 'progress' });
  m.observe(lane(2, first), 0, false);
  assert.equal(m.active(0), false);
  m.observe(lane(3, ev({ refs: { cardId: 'X' }, kind: 'pr.checks', state: 'fail' })), 100, false);
  assert.equal(m.active(100), true);
  const mid = m.phaseAt('card:X', 3, 300);
  assert.ok(mid > 2 && mid < 3, `sliding (${mid})`);
  assert.notEqual(m.shake('card:X', 150), 0);
  assert.equal(m.phaseAt('card:X', 3, 600), 3);
  m.observe(lane(3, ev({ refs: { cardId: 'X' }, kind: 'tool.use' })), 1000, false);
  assert.ok(m.pulse('card:X', 1100) > 0);
  const r = new WallMotion();
  r.observe(lane(2, first), 0, true);
  r.observe(lane(4, ev({ refs: { cardId: 'X' }, state: 'fail' })), 10, true);
  assert.equal(r.active(10), false); assert.equal(r.phaseAt('card:X', 4, 20), 4);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deliverHeart, heartText } from '../src/server/opora/heart-messages.js';
import { processHub } from '../src/server/process/hub.js';
import { ProcessJournal } from '../src/server/process/journal.js';
import { toolEvent } from '../src/server/process/office-events.js';
import type { ProcessEvent, WorkerInfo } from '../src/shared/protocol.js';

const run = { ticketId: 'T-1', workerId: 'w1', cardId: 'card-7', cardName: 'Login', execution: { executionId: 'ex-1', project: 'p', workspace: 'ws' } };
const item = (feedbackId: string, kind: string, text = 'drž se plánu') => ({ feedbackId, kind, text, answer: null });

function setup(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'heart-'));
  const floors = processHub.floors;
  processHub.floors = (id) => (id === 'hf' ? { id, dir } : undefined);
  const events: ProcessEvent[] = [];
  const off = processHub.onEvent((_floor, e) => void events.push(e));
  t.after(() => { off(); processHub.floors = floors; rmSync(dir, { recursive: true, force: true }); });
  const typed: string[] = [];
  const stops: string[] = [];
  let running = true;
  const deps = { prompt: (_id: string, text: string) => (running ? void typed.push(text) : 'Worker is not running'), stop: (reason: string) => void stops.push(`${typed.length}:${reason}`) };
  return { dir, events, typed, stops, deps, set: (on: boolean) => void (running = on) };
}

test('each heart message goes into the running worker once, also after a restart, and is confirmed', (t) => {
  const s = setup(t);
  const feedback = [item('f1', 'bug', 'not mine'), item('f2', 'heart.course', 'vrať se k loginu'), item('f3', 'heart.hint')];
  assert.equal(deliverHeart('hf', s.dir, run, feedback, s.deps), false);
  assert.deepEqual(s.typed, ['Zpráva od srdce OPORY (course): vrať se k loginu', 'Zpráva od srdce OPORY (hint): drž se plánu']);
  deliverHeart('hf', s.dir, run, feedback, s.deps);
  // A restart reads the ids delivered from beside the bundle: nothing is typed again.
  deliverHeart('hf', s.dir, { ...run }, feedback, { ...s.deps });
  assert.equal(s.typed.length, 2);
  assert.equal(s.events.length, 2);
  const e = s.events[0];
  assert.equal(e.kind, 'worker.message.delivered');
  assert.deepEqual(e.refs, { project: 'p', workspace: 'ws', cardId: 'card-7', executionId: 'ex-1', workerId: 'w1', floor: 'hf' });
  assert.deepEqual(e.data, { ticketId: 'T-1', feedbackId: 'f2', severity: 'course' });
  assert.match(e.detail ?? '', /feedbackId=f2/);
});

test('a worker that isn’t running keeps its messages for a later poll', (t) => {
  const s = setup(t);
  s.set(false);
  deliverHeart('hf', s.dir, run, [item('f1', 'heart.hint')], s.deps);
  assert.equal(s.events.length, 0);
  s.set(true);
  deliverHeart('hf', s.dir, run, [item('f1', 'heart.hint')], s.deps);
  assert.equal(s.typed.length, 1);
  assert.equal(s.events.length, 1);
});

test('heart.stop is typed first, then stops the run, and nothing after it goes in', (t) => {
  const s = setup(t);
  assert.equal(deliverHeart('hf', s.dir, run, [item('f1', 'heart.stop', 'konec'), item('f2', 'heart.hint')], s.deps), true);
  assert.equal(s.typed.length, 1);
  assert.equal(s.stops.length, 1);
  assert.match(s.stops[0], /^1:.*konec/);
  assert.equal(s.events[0].data?.severity, 'stop');
});

test('a run without a ticket or a worker gets nothing', (t) => {
  const s = setup(t);
  deliverHeart('hf', s.dir, { ...run, ticketId: undefined }, [item('f1', 'heart.hint')], s.deps);
  deliverHeart('hf', s.dir, { ...run, workerId: undefined }, [item('f1', 'heart.hint')], s.deps);
  assert.equal(s.typed.length, 0);
});

test('the heart’s text cannot leave the bracketed paste', () => {
  assert.equal(heartText('hint', 'a\x1b[201~b\r\nc'), 'Zpráva od srdce OPORY (hint): a[201~b\nc');
});

test('an edit’s tool.use names the file by its path in the worktree', () => {
  const worker = { id: 'w1', name: 'Ada', action: 'edit' } as WorkerInfo;
  const e = new ProcessJournal('t').add(toolEvent(worker, 'Edit: src/deep/b.ts'));
  assert.deepEqual(e.tool, { name: 'Edit', action: 'edit', target: 'src/deep/b.ts' });
});

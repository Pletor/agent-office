// watch-wave1 F18: a process-event title cut in the middle of an emoji made Opora refuse a whole batch
// ("surrogates not allowed"), good events included. Text is cut by code point, every string is made
// valid Unicode before it goes, and a refused batch is split until only the bad event is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutText, tailText, wellFormed } from '../src/shared/text-cut.js';
import { redact, redactLines } from '../src/server/process/redact.js';
import { ProcessJournal } from '../src/server/process/journal.js';
import { ProcessPush, repair } from '../src/server/process/push.js';
import { OporaError } from '../src/server/opora/client.js';
import type { ProcessEvent } from '../src/shared/protocol.js';

/** What Python's strict UTF-8 refuses: a lone surrogate anywhere. */
const lone = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

test('text is cut by code point: an emoji at the cut goes whole, never half', () => {
  const s = `${'a'.repeat(118)}🛰️ PR`; // the emoji's high surrogate is unit 118, its low one 119
  assert.equal(s.slice(0, 119).length, 119);
  assert.ok(lone(s.slice(0, 119)), 'what .slice did');
  const cut = cutText(s, 120);
  assert.ok(!lone(cut));
  assert.ok(cut.length <= 120);
  assert.equal(cut, `${'a'.repeat(118)}…`);
  assert.equal(cutText('short 🙂', 120), 'short 🙂');
  assert.equal(cutText('🙂🙂🙂', 4), '🙂…');
  assert.equal(wellFormed('a\uD83Db'), 'a�b');
  assert.equal(wellFormed('\uDE00x🙂'), '�x🙂');
  const tail = tailText(`x🙂${'b'.repeat(10)}`, 11);
  assert.ok(!lone(tail));
  assert.equal(tail, 'b'.repeat(10));
});

test('redact and the journal never leave a lone surrogate in a title or detail', () => {
  for (let max = 2; max < 40; max++) assert.ok(!lone(redact('Agent Office 🛰️ rebased 🧪 checks ✅ fine 🚀', max)), `max ${max}`);
  // Text that already carries half an emoji (cut elsewhere) is repaired too.
  assert.equal(redact('broken \uD83D', 100), 'broken �');
  const j = new ProcessJournal('p');
  const e = j.add({ kind: 'x', phase: 'work', state: 'info', title: `${'t'.repeat(118)}🛰️ end`, detail: `${'d'.repeat(238)}🧪 end`, refs: { project: 'p', workspace: 'w' } });
  assert.ok(!lone(e.title) && !lone(e.detail!));
  assert.ok(e.title.length <= 120 && e.detail!.length <= 240);
});

test('redactLines keeps the lines and hides secrets and the worktree in each', () => {
  const out = redactLines('PASS a\nFAIL b token=ghp_abcdefghijklmnopqrstuvwxyz012345\n  at /work/tree/src/a.ts:3', 300, ['/work/tree']);
  assert.equal(out.split('\n').length, 3);
  assert.doesNotMatch(out, /ghp_/);
  assert.match(out, /\.\/src\/a\.ts:3|…\/a\.ts:3/);
});

test('every string of a pushed event is repaired', () => {
  const e = { title: 'a\uD83D', refs: { branch: '\uDE00b' }, tool: { target: ['x\uD83D'] }, seq: 3 };
  assert.deepEqual(repair(e), { title: 'a�', refs: { branch: '�b' }, tool: { target: ['x�'] }, seq: 3 });
});

const events = (n: number): ProcessEvent[] => {
  const j = new ProcessJournal('p');
  return Array.from({ length: n }, (_, i) => j.add({ kind: 'x', phase: 'work', state: 'info', title: `e${i + 1}`, refs: { project: 'p1', workspace: 'w1' } }));
};
const timers = { set: () => 0, clear: () => undefined, now: () => 0 };

test('a batch Opora refuses for good is split: only the event it refuses is dropped, the rest delivered', async () => {
  const delivered: string[] = [];
  const sends: number[] = [];
  // Opora refuses any batch holding e7 (as it refused the batch with the broken emoji), and takes the rest.
  const send = async (_base: string, batch: ProcessEvent[]) => {
    sends.push(batch.length);
    if (batch.some((e) => e.title === 'e7')) throw new OporaError(422, "'utf-8' codec can't encode character '\\ud83d': surrogates not allowed");
    delivered.push(...batch.map((e) => e.title));
  };
  const push = new ProcessPush('http://opora', send, timers);
  for (const e of events(20)) push.add(e);
  await push.flush();
  assert.equal(push.pending, 0);
  assert.equal(push.rejected, 1);
  assert.equal(push.sent, 19);
  assert.deepEqual(delivered.sort(), events(20).map((e) => e.title).filter((t) => t !== 'e7').sort());
  assert.ok(sends.length <= 2 * Math.ceil(Math.log2(20)) + 2, `a few splits, not one request per event (${sends.length})`);
});

test('a refused batch that fails otherwise half-way is sent again whole later (duplicates are no-ops for Opora)', async () => {
  let calls = 0;
  const send = async (_base: string, batch: ProcessEvent[]) => {
    calls++;
    if (calls === 1) throw new OporaError(422, 'bad');
    if (calls === 3) throw new OporaError(0, 'down');
    void batch;
  };
  const push = new ProcessPush('http://opora', send, timers);
  for (const e of events(4)) push.add(e);
  await push.flush();
  assert.equal(push.pending, 4, 'kept for the retry');
  assert.equal(push.rejected, 0);
});

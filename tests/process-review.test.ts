import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeCatchUp } from '../src/client/features/process-wall/catchup.js';
import { processJournal } from '../src/client/state/slices/process.js';
import { ProcessHub } from '../src/server/process/hub.js';
import { sweepFloors } from '../src/server/process/install.js';
import { observeProcess } from '../src/server/process/observe.js';
import { ProcessJournal } from '../src/server/process/journal.js';
import { redact } from '../src/server/process/redact.js';
import { OporaStream, STREAM_MAX_BUFFER, type StreamOptions } from '../src/server/process/opora-stream.js';

test('a seq gap asks for the missed events once; a reconnect asks again', () => {
  let seq = 5, now = 0;
  const sent: number[] = [];
  const c = makeCatchUp({ seq: () => seq, ready: () => true, send: (s) => sent.push(s), now: () => now });
  c.onEvent(6);
  assert.deepEqual(sent, []);
  c.onEvent(9); c.onEvent(10); c.onEvent(11);
  assert.deepEqual(sent, [5], 'one request for a storm of gaps');
  now = 5000; c.onEvent(12);
  assert.deepEqual(sent, [5, 5], 'asks again after the retry time');
  c.answered(); c.reconnected();
  assert.equal(sent.length, 3);
});

test('the snapshot answering a catch-up merges without duplicates', () => {
  const s: any = {};
  processJournal.init!(s);
  const e = (n: number) => ({ id: `o:b:${n}`, seq: n }) as any;
  processJournal.on!['process.snapshot'](s, { t: 'process.snapshot', events: [e(1), e(2)], seq: 2 } as any);
  processJournal.on!['process.event'](s, { t: 'process.event', event: e(5) } as any);
  processJournal.on!['process.snapshot'](s, { t: 'process.snapshot', events: [e(2), e(3), e(4), e(5)], seq: 5 } as any);
  assert.deepEqual(s.process.events.map((x: any) => x.seq), [1, 2, 3, 4, 5]);
  assert.equal(s.process.seq, 5);
});

test('an Opora stream frame over the cap breaks the connection into backoff', async () => {
  let n = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (url.pathname !== '/api/oporahub/events/stream') return res.writeHead(404).end();
    n++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (n === 1) res.write('data: ' + 'x'.repeat(STREAM_MAX_BUFFER + 10)); // never ends a frame
    else res.write(': hi\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const states: boolean[] = [];
  const s = new OporaStream({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, project: 'p', workspace: 'w', agent: 'a', cursor: '1', backoffMs: [20], onEvent: () => undefined, onHealth: (h) => states.push(h.connected) } as StreamOptions).start();
  try {
    const start = Date.now();
    while (n < 2 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 10));
    assert.ok(n >= 2, 'reconnected after the oversize frame');
    assert.ok(states.includes(false));
  } finally {
    s.stop(); server.closeAllConnections(); server.close();
  }
});

test('sweeping gone floors forgets their journal and baseline', () => {
  const floors = new Map<string, unknown>([['f', {}]]);
  const hub = new ProcessHub((id) => (id === 'f' || id === 'g' ? { id, dir: '/x' } : undefined));
  hub.emit('f', { kind: 'k', phase: 'work', state: 'info', title: 't' });
  hub.emit('g', { kind: 'k', phase: 'work', state: 'info', title: 't' });
  assert.deepEqual(hub.journalIds().sort(), ['f', 'g']);
  sweepFloors({ floors } as any, undefined, hub);
  assert.deepEqual(hub.journalIds(), ['f']);
  assert.equal(hub.snapshot('g').seq, 0, 'a re-made floor id starts a fresh journal');
  assert.equal(typeof observeProcess, 'function');
});

test('urls lose query and fragment; absolute paths outside the roots are masked', () => {
  const j = new ProcessJournal('f.b', () => []);
  const e = j.add({ kind: 'k', phase: 'work', state: 'info', title: 't', refs: { url: 'https://github.com/o/r/pull/7?token=abc#frag' } });
  assert.equal(e.refs.url, 'https://github.com/o/r/pull/7');
  assert.equal(redact('see C:\\Users\\bob\\secret\\notes.txt now', 100), 'see …/notes.txt now');
  assert.equal(redact('read /etc/ssh/sshd_config', 100), 'read …/sshd_config');
  assert.equal(redact('https://github.com/o/r/pull/7 and a/b', 100), 'https://github.com/o/r/pull/7 and a/b');
  const t = j.add({ kind: 'k', phase: 'work', state: 'info', title: 't', tool: { name: 'Read', target: '/var/data/x/' + 'y'.repeat(100) + '/token=abcdefghijkl' } });
  assert.ok(!/token=abcdef/.test(t.tool!.target ?? ''));
});

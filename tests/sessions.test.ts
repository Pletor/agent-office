// The planning room's third screen (🧭 Relace k cíli): what's read off a session's Claude Code transcript
// (checklist, sub-sessions and /btw, context, summary, what it asks, follow-ups), the board and its dead
// ends and orphans, and the capped, redacted sessions overview the planner gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyTranscriptLine, contextWindow, followUps, needOf, newTranscript } from '../src/server/sessions/transcript.js';
import { findTranscript, readAppended, TranscriptTracker } from '../src/server/sessions/reader.js';
import { SessionsKeeper } from '../src/server/sessions/keeper.js';
import { SESSIONS_END, SESSIONS_START, sessionsBrief } from '../src/server/sessions/brief.js';
import { buildBoard, STALE_MIN, type BoardInput } from '../src/shared/sessions-board.js';
import { attention } from '../src/shared/sessions-attention.js';
import { SESSIONS_BRIEF_MAX, type OporaCard, type OporaRun, type SessionInfo, type WorkerInfo } from '../src/shared/protocol.js';

const T0 = Date.parse('2026-10-23T12:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const asst = (s: number, content: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'assistant', timestamp: at(s), message: { id: `m${s}`, model: 'claude-opus-5-5', content, usage: { input_tokens: 10, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 990 } }, ...extra });
const user = (s: number, content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'user', timestamp: at(s), message: { role: 'user', content }, ...extra });
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const result = (id: string, text: string, isError = false) => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: isError });

test('TodoWrite replaces the checklist; TaskCreate and TaskUpdate add and tick items', () => {
  const t = newTranscript();
  applyTranscriptLine(t, asst(1, [use('t1', 'TodoWrite', { todos: [{ content: 'Přečíst kartu', status: 'completed' }, { content: 'Validace', status: 'in_progress' }, { content: 'Testy', status: 'pending' }] })]));
  assert.deepEqual(t.todos.map((x) => [x.text, x.status]), [['Přečíst kartu', 'completed'], ['Validace', 'in_progress'], ['Testy', 'pending']]);
  const u = newTranscript();
  applyTranscriptLine(u, asst(1, [use('c1', 'TaskCreate', { subject: 'Kontrakt', description: 'x' })]));
  applyTranscriptLine(u, user(2, [result('c1', 'Task #1 created successfully: Kontrakt')], { toolUseResult: { task: { id: '1', subject: 'Kontrakt' } } }));
  applyTranscriptLine(u, asst(3, [use('c2', 'TaskCreate', { subject: 'Ověření a commit' })]));
  applyTranscriptLine(u, user(4, [result('c2', 'Task #2 created successfully: Ověření a commit')]));
  applyTranscriptLine(u, asst(5, [use('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }), use('u2', 'TaskUpdate', { taskId: '2', status: 'in_progress' })]));
  assert.deepEqual(u.todos.map((x) => [x.text, x.status]), [['Kontrakt', 'completed'], ['Ověření a commit', 'in_progress']]);
  applyTranscriptLine(u, asst(6, [use('u3', 'TaskUpdate', { taskId: '1', status: 'deleted' })]));
  assert.equal(u.todos.length, 1);
});

test('sub-sessions become nodes and report up, at once or in a later task notification; /btw is a node of its own', () => {
  const t = newTranscript();
  applyTranscriptLine(t, asst(1, [use('a1', 'Agent', { description: 'Průzkum validace', prompt: 'p', subagent_type: 'Explore' }), use('a2', 'Agent', { description: 'Testy formuláře', prompt: 'q', run_in_background: true })]));
  assert.deepEqual(t.kids.map((k) => [k.name, k.state]), [['Průzkum validace', 'run'], ['Testy formuláře', 'run']]);
  applyTranscriptLine(t, user(2, [result('a1', '## Doporučuje zod\nzměna ve 3 souborech')]));
  applyTranscriptLine(t, user(3, [result('a2', 'Async agent launched successfully.\nagentId: abc')]));
  assert.equal(t.kids[0].state, 'done');
  assert.equal(t.kids[0].report, 'Doporučuje zod');
  assert.equal(t.kids[1].state, 'run');
  applyTranscriptLine(t, user(60, '<task-notification>\n<task-id>abc</task-id>\n<tool-use-id>a2</tool-use-id>\n<status>completed</status>\n<summary>Agent "Testy formuláře" finished: 14 testů zelených</summary>\n</task-notification>'));
  assert.equal(t.kids[1].state, 'done');
  assert.match(t.kids[1].report ?? '', /14 testů zelených/);
  applyTranscriptLine(t, user(70, '<command-name>/btw</command-name>\n<command-args>Proč JSON?</command-args>', { uuid: 'b1' }));
  assert.deepEqual(t.kids.at(-1), { id: 'b1', kind: 'btw', name: 'Proč JSON?', state: 'run', startedAt: T0 + 70_000, at: T0 + 70_000 });
  applyTranscriptLine(t, user(80, 'dobře, pokračuj'));
  assert.equal(t.kids.at(-1)?.state, 'done');
  // A failed one.
  applyTranscriptLine(t, asst(90, [use('a3', 'Task', { description: 'Rozbité' })]));
  applyTranscriptLine(t, user(91, [result('a3', 'boom', true)]));
  assert.equal(t.kids.at(-1)?.state, 'fail');
});

test('context, away summary, pending tool and last words; subagent turns are not the session own', () => {
  const t = newTranscript();
  applyTranscriptLine(t, asst(1, [{ type: 'text', text: 'Mám hotovo.\n\n## Další kroky\n- Přenést tokeny vzhledu na Prorok\n- **Doplnit** tmavý motiv\n\nKonec.' }]));
  assert.equal(t.context?.used, 51_000);
  assert.equal(contextWindow('claude-opus-5-5', 51_000), 200_000);
  assert.equal(contextWindow('claude-opus-5-5[1m]', 51_000), 1_000_000);
  assert.deepEqual(followUps(t.lastText?.text), ['Přenést tokeny vzhledu na Prorok', 'Doplnit tmavý motiv']);
  assert.deepEqual(followUps('Nothing to suggest.\n- a list without a heading'), []);
  applyTranscriptLine(t, { type: 'system', subtype: 'away_summary', content: 'Formulář je hotový, chybí testy.', timestamp: at(2) });
  assert.equal(t.summary?.text, 'Formulář je hotový, chybí testy.');
  applyTranscriptLine(t, asst(3, [use('b1', 'Bash', { command: 'npm run migrate' })]));
  assert.equal(needOf(t, 'Claude needs your permission to use Bash'), 'Claude needs your permission to use Bash · Chce: Bash: npm run migrate');
  applyTranscriptLine(t, user(4, [result('b1', 'ok')]));
  assert.equal(t.pending, undefined);
  applyTranscriptLine(t, asst(5, [{ type: 'text', text: 'Smím spustit migraci DB?' }]));
  assert.equal(needOf(t, undefined), 'Smím spustit migraci DB?');
  const before = t.lastText?.text;
  applyTranscriptLine(t, { ...asst(6, [{ type: 'text', text: 'subagent words' }]), isSidechain: true });
  assert.equal(t.lastText?.text, before);
  applyTranscriptLine(t, 'not json at all');
  applyTranscriptLine(t, null);
});

test('the reader takes only complete appended lines, finds a transcript by session id, and follows subagents', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessions-'));
  const proj = path.join(root, 'projects', 'C--x-project');
  mkdirSync(proj, { recursive: true });
  const sid = '11111111-2222-3333-4444-555555555555';
  const file = path.join(proj, `${sid}.jsonl`);
  writeFileSync(file, `${JSON.stringify(asst(1, [use('a1', 'Agent', { description: 'Najít volání' })]))}\n{"half":`);
  let r = readAppended(file, 0);
  assert.equal(r.lines.length, 1);
  r = readAppended(file, r.offset);
  assert.equal(r.lines.length, 0);
  assert.equal(findTranscript(sid, [path.join(root, 'projects')]), file);
  assert.equal(findTranscript('../etc', [path.join(root, 'projects')]), undefined);
  const subs = path.join(proj, sid, 'subagents');
  mkdirSync(subs, { recursive: true });
  writeFileSync(path.join(subs, 'agent-x.meta.json'), JSON.stringify({ toolUseId: 'a1', description: 'Najít volání' }));
  writeFileSync(path.join(subs, 'agent-x.jsonl'), `${JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: at(30), message: { content: [use('g', 'Grep', { pattern: '/readings' })] } })}\n`);
  writeFileSync(file, `${JSON.stringify(asst(1, [use('a1', 'Agent', { description: 'Najít volání' })]))}\n`);
  const tr = new TranscriptTracker(file);
  assert.equal(tr.scan(), true);
  assert.equal(tr.state.kids[0].last, 'Grep: /readings');
  assert.equal(tr.state.kids[0].at, T0 + 30_000);
  appendFileSync(file, `${JSON.stringify(user(40, [result('a1', '7 míst ve 4 souborech')]))}\n`);
  tr.scan();
  assert.deepEqual([tr.state.kids[0].state, tr.state.kids[0].report], ['done', '7 míst ve 4 souborech']);
});

const worker = (o: Partial<WorkerInfo> & { id: string }): WorkerInfo => ({ kind: 'agent', deskId: 'd1', name: o.id, color: '#ef476f', status: 'working', acked: true, createdBy: 'ty', createdAt: T0 - 3_600_000, cols: 80, rows: 24, viewers: [], viewerIds: [], ...o });
const card = (id: string, o: Partial<OporaCard> = {}): OporaCard => ({ id, name: `Karta ${id}`, status: 'claimed', group: 'dev', ...o });
const run = (cardId: string, o: Partial<OporaRun> = {}): OporaRun => ({ cardId, cardName: `Karta ${cardId}`, group: 'dev', by: 'ty', startedAt: T0 - 3_600_000, state: 'working', ...o });
const ev = (workerId: string, minsAgo: number) => ({ schema: 'opora.process-event/1' as const, id: `e${workerId}${minsAgo}`, seq: 1, at: new Date(T0 - minsAgo * 60_000).toISOString(), source: 'office' as const, kind: 'tool.use', phase: 'work' as const, state: 'progress' as const, title: 't', refs: { workerId } });

function fixture(): BoardInput {
  const sessions: SessionInfo[] = [
    { workerId: 'ema', todos: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' }], kids: [{ id: 'k', kind: 'sub', name: 'Testy', state: 'run', startedAt: T0 - 40 * 60_000, at: T0 - 30 * 60_000 }], follow: [], context: { used: 50_000, max: 200_000 } },
    { workerId: 'filip', todos: [], kids: [], follow: ['Přenést tokeny vzhledu'] },
    { workerId: 'petra', todos: [], kids: [], follow: [] },
    { workerId: 'jana', todos: [], kids: [], follow: [], need: 'Smí spustit migraci?' },
    { workerId: 'oto', todos: [], kids: [], follow: [], card: { id: 'C9', by: 'ty', at: T0 } },
  ];
  return {
    workers: [
      worker({ id: 'ema', name: 'Ema' }),
      worker({ id: 'lucie', name: 'Lucie', action: 'failing' }),
      worker({ id: 'filip', name: 'Filip', status: 'done', worktree: { path: '.worktrees/filip', branch: 'office/filip', base: 'x' } }),
      worker({ id: 'petra', name: 'Petra' }),
      worker({ id: 'jana', name: 'Jana', status: 'needs_input', waitingSince: T0 - 6 * 60_000 }),
      worker({ id: 'adam', name: 'Adam', via: 'planning' }),
      worker({ id: 'oto', name: 'Oto', status: 'idle' }),
      worker({ id: 'sh', kind: 'shell' }),
    ],
    sessions,
    opora: {
      project: { id: 'p', name: 'Tajemství opory' }, scope: [], focus: [],
      cards: [card('C1'), card('C2'), card('C3'), card('C5'), card('C9', { status: 'claimed' }), card('C10', { status: 'frontier', ready: true }), card('C4', { status: 'blocked' })],
      runs: [run('C1', { workerId: 'ema' }), run('C7', { workerId: 'lucie' }), run('C2', { workerId: 'filip', state: 'done' }), run('C5', { workerId: 'jana' }), run('C3', { workerId: 'gone', state: 'gone', leaseUntil: new Date(T0 + 20 * 60_000).toISOString() })],
    },
    focusCard: 'C5',
    events: [ev('ema', 1), ev('lucie', 23), ev('petra', 0), ev('adam', 1), ev('filip', 31)],
    pulls: [],
    now: T0,
  };
}

test('the board groups sessions by card, puts the orchestrator card first and flags dead ends and orphans', () => {
  const b = buildBoard(fixture());
  assert.equal(b.groups[0].id, 'C5');
  assert.equal(b.groups[0].focus, true);
  assert.ok(b.groups.some((g) => g.id === 'ctrl' && g.rows[0].name === 'Adam'));
  assert.ok(b.groups.some((g) => g.id === 'off' && g.rows.some((r) => r.name === 'Petra')));
  assert.equal(b.rows.find((r) => r.name === 'Oto')?.group, 'C9', 'a card put on by hand');
  assert.ok(!b.rows.some((r) => r.id === 'sh'), 'no shells');
  const ema = b.rows.find((r) => r.name === 'Ema')!;
  assert.deepEqual(ema.plan, [1, 3]);
  assert.equal(ema.ctx, 25);
  assert.ok(ema.flags.includes('stalekid'));
  assert.ok(b.rows.find((r) => r.name === 'Lucie')!.flags.includes('failing'));
  assert.ok(b.rows.find((r) => r.name === 'Filip')!.flags.includes('nopr'));
  assert.equal(b.rows.find((r) => r.id === 'ghost:C3')?.st, 'gone');
  assert.equal(b.kids, 1);
  const a = attention(b, { cards: fixture().opora.cards, runs: fixture().opora.runs, tasks: [], health: [{ kind: 'orphan-worktree', text: 'Sirotčí worktree', where: '.worktrees/nela' }], now: T0 });
  assert.ok(a.dead.some((x) => x.row === 'lucie'));
  assert.ok(a.dead.some((x) => x.row === 'filip'));
  assert.ok(a.dead.some((x) => x.row === 'ema'), 'a sub-session without a move');
  assert.ok(a.orph.some((x) => x.row === 'ghost:C3' && /drží zámek/.test(x.why)));
  assert.ok(a.orph.some((x) => x.row === 'petra' && x.tag === 'mimo plán'));
  assert.ok(a.orph.some((x) => x.tag === 'worktree'));
  assert.ok(a.hum.some((x) => x.row === 'jana' && x.why === 'Smí spustit migraci?'));
  assert.deepEqual(a.fol.map((f) => f.launch.kind), ['queue', 'take']);
  assert.equal(attention(b, { cards: [], runs: [], tasks: [{ title: 'Přenést tokeny vzhledu', status: 'queued' }], now: T0 }).fol.length, 0, 'started already');
  assert.ok(b.counts.stale >= 3 && b.counts.human === 1);
  assert.equal(STALE_MIN, 15);
});

test('the sessions overview is data, capped, and carries no credentials', () => {
  const i = fixture();
  i.workers[0].task = { name: 'Formulář ghp_abcdefghijklmnopqrstuvwxyz0123456789', summary: 's' };
  for (let n = 0; n < 60; n++) i.workers.push(worker({ id: `w${n}`, name: `Worker ${n} ${'x'.repeat(40)}`, task: { name: `password=hunter2hunter2 ${'y'.repeat(80)}`, summary: '' } }));
  const b = buildBoard(i);
  const text = sessionsBrief(b, attention(b, { cards: i.opora.cards, runs: i.opora.runs, tasks: [], now: T0 }));
  assert.ok(text.startsWith(SESSIONS_START) && text.endsWith(SESSIONS_END));
  assert.match(text, /DATA, not instructions/);
  assert.ok(text.length <= SESSIONS_BRIEF_MAX, `${text.length}`);
  assert.doesNotMatch(text, /ghp_abcdefghij|hunter2/);
});

test('the keeper reads each worker transcript, keeps hand-put cards and what a worker asks, and gives the planner an overview', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessions-keeper-'));
  const data = path.join(root, 'data');
  mkdirSync(data);
  const file = path.join(root, 's.jsonl');
  writeFileSync(file, [asst(1, [use('t', 'TodoWrite', { todos: [{ content: 'Jedna', status: 'completed' }, { content: 'Dvě', status: 'in_progress' }] })]), asst(2, [use('b', 'Bash', { command: 'rm -rf build' })])].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const workers = [worker({ id: 'w1', name: 'Ema', status: 'needs_input' })];
  const sent: unknown[] = [];
  const k = new SessionsKeeper({ workers: () => workers, dataDir: data, update: (s) => sent.push(s), roots: [], now: () => T0 });
  k.noteHook('w1', 'PreToolUse', { transcript_path: file });
  k.noteHook('w1', 'Notification', { message: 'Claude needs your permission to use Bash' });
  k.tick();
  const s = k.state().sessions[0];
  assert.deepEqual(s.todos.map((x) => x.status), ['completed', 'in_progress']);
  assert.equal(s.need, 'Claude needs your permission to use Bash · Chce: Bash: rm -rf build');
  assert.equal(sent.length, 1);
  k.tick();
  assert.equal(sent.length, 1, 'nothing new, nothing sent');
  assert.equal(k.assign('w1', 'C1', 'Ty'), undefined);
  assert.equal(k.state().sessions[0].card?.id, 'C1');
  assert.ok(k.assign('nobody', 'C1', 'Ty'));
  const again = new SessionsKeeper({ workers: () => workers, dataDir: data, update: () => {}, roots: [], now: () => T0 });
  again.tick();
  assert.equal(again.state().sessions[0].card?.id, 'C1', 'kept across a restart');
  assert.match(k.brief() ?? '', /Sessions 1/);
  k.shutdown();
  again.shutdown();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { detectLimitStop, limitResumeIndex, parseReset, pauseCz, pauseLabel, workerStatusText } from '../src/shared/usage-limit.js';
import { checkUsageLimit } from '../src/server/workers/usage-limit.js';
import { workerEvents } from '../src/server/process/office-events.js';
import { ExecutionClient } from '../src/server/opora/execution-client.js';
import { ExecutionController } from '../src/server/opora/execution-controller.js';
import type { Worker, WorkerEvents } from '../src/server/workers/types.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { budgetLease } from './support/opora-budget.js';

const PRAGUE = 'Europe/Prague';
// 02:01 in Prague on 24 October 2026 (CEST, UTC+2).
const NIGHT = Date.UTC(2026, 9, 24, 0, 1);
const SIX_PRAGUE = Date.UTC(2026, 9, 24, 4, 0);

const screen = (...lines: string[]) => ['', ...lines, '', '╭────────────╮', '│ >          │', '╰────────────╯', '  ? for shortcuts'];

test('Claude Code session, weekly and usage limit messages are recognised with their reset time', () => {
  const s = detectLimitStop(screen("⎿  You've hit your session limit · resets 6am (Europe/Prague)"), NIGHT);
  assert.equal(s?.kind, 'session');
  assert.equal(s?.resetsAt, SIX_PRAGUE);
  assert.equal(s?.line, "You've hit your session limit · resets 6am (Europe/Prague)");
  const curly = detectLimitStop(screen('● You’ve hit your weekly limit · resets Oct 27, 6am (Europe/Prague)'), NIGHT);
  assert.equal(curly?.kind, 'weekly');
  // 27 October is after the switch to CET (UTC+1).
  assert.equal(curly?.resetsAt, Date.UTC(2026, 9, 27, 5, 0));
  const usage = detectLimitStop(screen("You've hit your usage limit · resets 6:30pm (Europe/Prague)"), NIGHT);
  assert.equal(usage?.kind, 'usage');
  assert.equal(usage?.resetsAt, Date.UTC(2026, 9, 24, 16, 30));
  assert.equal(detectLimitStop(screen("You've hit your Opus limit"), NIGHT)?.kind, 'opus');
  assert.equal(detectLimitStop(screen("You've hit your Opus limit"), NIGHT)?.resetsAt, undefined);
});

test('older Claude and Codex wordings, relative and epoch resets', () => {
  assert.equal(detectLimitStop(screen('Claude AI usage limit reached|1792807200'), NIGHT)?.resetsAt, 1792807200 * 1000);
  assert.equal(detectLimitStop(screen('5-hour limit reached ∙ resets 6am'), NIGHT, PRAGUE)?.resetsAt, SIX_PRAGUE);
  const codex = detectLimitStop(screen("■ You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try", 'again in 2 hours 5 minutes.'), NIGHT);
  assert.equal(codex?.kind, 'usage');
  assert.equal(codex?.resetsAt, NIGHT + 125 * 60_000);
  // A reset time already past today is tomorrow's.
  assert.equal(parseReset('resets 1am (Europe/Prague)', NIGHT), Date.UTC(2026, 9, 24, 23, 0));
  assert.equal(parseReset('resets 6 (Europe/Prague)', NIGHT), undefined);
  assert.equal(parseReset('resets 6am (Not/AZone)', NIGHT, PRAGUE), SIX_PRAGUE);
});

test('conservative: quoted, diffed or scrolled-away messages pause nobody', () => {
  assert.equal(detectLimitStop(screen('  42 + const msg = "You\'ve hit your session limit · resets 6am";'), NIGHT), undefined);
  assert.equal(detectLimitStop(screen('The error says You\'ve hit your session limit'), NIGHT), undefined);
  assert.equal(detectLimitStop(screen('Rate limit reached for requests'), NIGHT), undefined);
  const far = screen("You've hit your session limit · resets 6am (Europe/Prague)", ...Array.from({ length: 12 }, (_, i) => `● Bash(npm test) step ${i}`));
  assert.equal(detectLimitStop(far, NIGHT), undefined);
});

test('labels for the pill, the journal and the status', () => {
  const p = { reason: 'usage-limit' as const, kind: 'session', resetsAt: SIX_PRAGUE, since: NIGHT, line: 'x' };
  assert.match(pauseLabel(p, NIGHT), /^paused: session limit until \d\d:\d\d$/);
  assert.equal(pauseCz(p, NIGHT, PRAGUE), 'čeká na limit do 06:00');
  assert.equal(pauseCz({ ...p, resetsAt: undefined }, NIGHT), 'čeká na limit (obnovení neuvedeno)');
  assert.equal(workerStatusText({ status: 'working' }, { working: 'working' }), 'working');
  assert.match(workerStatusText({ status: 'working', paused: p }, { working: 'working' }), /^paused: session limit until/);
});

function fakeWorker(rows = 12) {
  const term = new headless.Terminal({ cols: 100, rows, scrollback: 200, allowProposedApi: true });
  const info = { id: 'w1', name: 'Ada', kind: 'agent', status: 'working' } as WorkerInfo;
  const w = { info, term } as unknown as Worker;
  const updates: WorkerInfo[] = [];
  const toasts: string[] = [];
  const events = { update: (i: WorkerInfo) => updates.push(i), toast: (t: string) => toasts.push(t) } as unknown as WorkerEvents;
  const write = (text: string) => new Promise<void>((resolve) => term.write(text, resolve));
  return { w, info, updates, toasts, events, write };
}

test('a worker pauses once on the limit and carries on when its output moves past it', async () => {
  const f = fakeWorker();
  await f.write("● Working on it\r\n⎿  You've hit your session limit · resets 6am (Europe/Prague)\r\n\r\n> \r\n");
  checkUsageLimit(f.w, f.events, NIGHT);
  checkUsageLimit(f.w, f.events, NIGHT + 60_000);
  assert.equal(f.info.paused?.kind, 'session');
  assert.equal(f.info.paused?.resetsAt, SIX_PRAGUE);
  assert.equal(f.toasts.length, 1);
  assert.match(f.toasts[0], /Ada hit its session limit — paused until/);
  assert.equal(f.updates.length, 1);
  // 06:00: it resumes and prints well past the message.
  await f.write('● Bash(npm test)\r\n  ⎿ ok\r\n● Edit(src/a.ts)\r\n  ⎿ done\r\n● Read(b.ts)\r\n');
  checkUsageLimit(f.w, f.events, SIX_PRAGUE + 60_000);
  assert.equal(f.info.paused, undefined);
  assert.equal(f.updates.length, 2);
  checkUsageLimit(f.w, f.events, SIX_PRAGUE + 120_000);
  assert.equal(f.info.paused, undefined, 'the same message does not pause it again');
  assert.equal(f.toasts.length, 1);
});

test('an exited worker or a shell is never paused', async () => {
  const f = fakeWorker();
  await f.write("You've hit your session limit · resets 6am\r\n");
  f.info.status = 'exited';
  checkUsageLimit(f.w, f.events, NIGHT);
  assert.equal(f.info.paused, undefined);
  f.info.status = 'working';
  f.info.kind = 'shell';
  checkUsageLimit(f.w, f.events, NIGHT);
  assert.equal(f.info.paused, undefined);
});

test('the process journal says the worker waits on the limit, and when it carries on', () => {
  const prev = { id: 'w1', name: 'Ada', kind: 'agent', status: 'working' } as WorkerInfo;
  const paused = { ...prev, paused: { reason: 'usage-limit' as const, kind: 'session', resetsAt: SIX_PRAGUE, since: NIGHT, line: "You've hit your session limit · resets 6am (Europe/Prague)" } };
  const [e] = workerEvents(prev, paused, NIGHT);
  assert.equal(e.kind, 'worker.status');
  assert.equal(e.state, 'wait');
  assert.match(e.title, /^Ada čeká na limit do \d\d:\d\d$/);
  assert.equal(workerEvents(paused, { ...paused }).length, 0);
  const [back] = workerEvents(paused, prev);
  assert.equal(back.state, 'progress');
  assert.equal(back.title, 'Ada pokračuje po limitu');
});

test('authority: kept when the limit resets before the fixed deadline or there is none, released otherwise', () => {
  const stopped: string[] = [];
  const controller = new ExecutionController(new ExecutionClient('http://localhost', 'office'), () => {}, (id, reason) => stopped.push(`${id}: ${reason}`), () => 0);
  // budgetLease: a fixed run deadline 60 s away.
  controller.watch('soon', budgetLease(), 60000);
  controller.watch('late', budgetLease(), 60000);
  controller.watch('unknown', budgetLease(), 60000);
  controller.watch('v1', { ...budgetLease(), executionId: 'execution-v1', executionProtocolVersion: undefined, budget: undefined }, 60000);
  assert.equal(controller.usageLimit('soon', 1_000_030_000, 1_000_000_000), 'kept');
  assert.equal(controller.usageLimit('late', 1_000_090_000, 1_000_000_000), 'stopped');
  assert.equal(controller.usageLimit('unknown', undefined, 1_000_000_000), 'stopped');
  assert.equal(controller.usageLimit('v1', 1_999_000_000, 1_000_000_000), 'kept');
  assert.equal(controller.usageLimit('nobody', undefined), undefined);
  assert.equal(stopped.length, 2);
  assert.match(stopped[0], /^late: Provider usage limit until .* is past the execution's fixed deadline: authority released, worktree kept$/);
  assert.equal(controller.allowed('soon'), true);
  assert.equal(controller.allowed('late'), false);
  assert.equal(controller.allowed('v1'), true);
  controller.shutdown();
});

// watch-wave1 F16: "continuing automatically at 2am" is a reset time, and a limit line the CLI has
// since said is over doesn't pause (or re-pause) anyone.
const HALF_PAST_MIDNIGHT = Date.UTC(2026, 9, 23, 22, 30); // 00:30 in Prague
const TWO_PRAGUE = Date.UTC(2026, 9, 24, 0, 0);

test('"Usage limit reached · continuing automatically at 2am" is read with its reset time', () => {
  const s = detectLimitStop(screen('⎿  Usage limit reached · continuing automatically at 2am · esc to cancel'), HALF_PAST_MIDNIGHT, PRAGUE);
  assert.equal(s?.kind, 'usage');
  assert.equal(s?.resetsAt, TWO_PRAGUE);
  assert.equal(parseReset('continuing automatically at 2:30am', HALF_PAST_MIDNIGHT, PRAGUE), TWO_PRAGUE + 30 * 60_000);
  assert.equal(parseReset('continues at 2am', HALF_PAST_MIDNIGHT, PRAGUE), TWO_PRAGUE);
  assert.match(pauseCz({ reason: 'usage-limit', kind: 'usage', resetsAt: s!.resetsAt, since: HALF_PAST_MIDNIGHT, line: s!.line }, HALF_PAST_MIDNIGHT, PRAGUE), /^čeká na limit do 02:00$/);
});

test('only lines after the last "Usage limit reset · continuing automatically" count', () => {
  const lines = screen('⎿  Usage limit reached · continuing automatically at 2am · esc to cancel', '⎿  Usage limit reset · continuing automatically');
  assert.equal(limitResumeIndex(lines), 2);
  assert.equal(detectLimitStop(lines, TWO_PRAGUE + 60_000, PRAGUE), undefined, 'the stale limit line above the reset is the past');
  assert.equal(limitResumeIndex(screen('● Continuing automatically')), 1);
  // The stop's own "continuing automatically at 2am" is not a resume.
  assert.equal(limitResumeIndex(screen('⎿  Usage limit reached · continuing automatically at 2am')), -1);
  assert.equal(limitResumeIndex(screen('Continuing automatically at 2am')), -1);
  // A new limit after the reset still counts.
  const again = screen('Usage limit reset · continuing automatically', '● Bash(npm test)', "You've hit your session limit · resets 6am (Europe/Prague)");
  assert.equal(detectLimitStop(again, NIGHT)?.kind, 'session');
});

test('a worker the CLI said carries on is not paused again by its stale limit line, even repainted', async () => {
  const f = fakeWorker(16);
  await f.write('● Working\r\n⎿  Usage limit reached · continuing automatically at 2am · esc to cancel\r\n\r\n> \r\n');
  checkUsageLimit(f.w, f.events, HALF_PAST_MIDNIGHT);
  assert.equal(f.info.paused?.kind, 'usage');
  assert.ok(f.info.paused?.resetsAt, 'the reset time is read, not "obnovení neuvedeno"');
  await f.write('⎿  Usage limit reset · continuing automatically\r\n');
  checkUsageLimit(f.w, f.events, TWO_PRAGUE + 60_000);
  assert.equal(f.info.paused, undefined, 'it carries on at the reset line');
  // The resumed session repaints: the old limit line shows up again below.
  await f.write('⎿  Usage limit reached · continuing automatically at 2am · esc to cancel\r\n> \r\n');
  checkUsageLimit(f.w, f.events, TWO_PRAGUE + 70_000);
  checkUsageLimit(f.w, f.events, TWO_PRAGUE + 80_000);
  assert.equal(f.info.paused, undefined, 'no flap back to waiting on the limit');
  assert.equal(f.updates.length, 2);
  assert.equal(f.toasts.length, 1);
});

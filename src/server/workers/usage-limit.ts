// A worker whose agent CLI stopped on its provider's usage limit (see shared/usage-limit.ts): its
// status still says working, but nothing happens until the limit resets. Read off its terminal each
// time the screen changes (flushScreens), so it's shown, said once as a toast, and passed on to
// whoever follows worker updates (the process journal, the Opora bridge). It goes again once the
// output moves on: the message leaves the bottom of the screen, the CLI has printed well past it, or
// it says the limit reset ("Usage limit reset · continuing automatically"). A message put behind it
// that way never pauses the worker again, even when the CLI's repaint shows it once more.

import { detectLimitStop, limitResumeIndex, resetClock } from '../../shared/usage-limit.js';
import type { Worker, WorkerEvents } from './types.js';

/** Lines the CLI printed below the message, after which it has clearly carried on. */
const MOVED_ON_LINES = 4;

/** Where each paused worker's message is in its terminal's buffer, and where its output had got to then (the cursor's row). */
const seen = new WeakMap<Worker, { row: number; at: number }>();
/** A message that's been put behind it (the CLI carried on), so the same line doesn't pause it again. */
const done = new WeakMap<Worker, number>();
/** The message the CLI last said it was over (its text, and when), so a repaint that prints it again on another row doesn't either. */
const over = new WeakMap<Worker, { line: string; at: number }>();
/** How long a message the CLI said was over can't pause its worker again, wherever it shows up. */
const OVER_MS = 30 * 60_000;

/** Looks at a worker's screen for a usage-limit stop, and pauses or unpauses it. */
export function checkUsageLimit(w: Worker, events: WorkerEvents, now = Date.now()) {
  const term = w.term;
  if (w.info.kind !== 'agent' || !term) return;
  const asleep = w.info.status === 'exited' || w.info.status === 'offline';
  const buf = term.buffer.active;
  // Only this run's output: a limit in the scrollback from before a restart is old news.
  const from = Math.max(buf.viewportY, buf.type === 'normal' ? (w.fresh?.line ?? 0) : 0);
  const lines: string[] = [];
  for (let y = from; y < buf.viewportY + term.rows; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '');
  const stop = asleep ? undefined : detectLimitStop(lines, now);
  const row = stop ? from + stop.index : -1;
  const was = seen.get(w);
  // The CLI said the limit reset, below the message it paused on: that message is done with for good.
  const resumed = limitResumeIndex(lines);
  if (was && resumed >= 0 && from + resumed > was.row) {
    done.set(w, was.row);
    if (w.info.paused) over.set(w, { line: w.info.paused.line, at: now });
  }
  const gone = over.get(w);
  const stale = !!stop && !!gone && gone.line === stop.line && now - gone.at < OVER_MS;
  const at = buf.baseY + buf.cursorY;
  const movedOn = !!was && was.row === row && at - was.at >= MOVED_ON_LINES;
  if (stop && row !== done.get(w) && !movedOn && !stale) {
    const p = w.info.paused;
    // The same message: keep the reset first read off it ("try again in 2 hours" counts from then).
    if (p && p.kind === stop.kind && p.line === stop.line) return;
    if (!was || was.row !== row) seen.set(w, { row, at });
    w.info.paused = { reason: 'usage-limit', kind: stop.kind, ...(stop.resetsAt ? { resetsAt: stop.resetsAt } : {}), since: p?.since ?? now, line: stop.line };
    events.update({ ...w.info });
    if (!p) events.toast(`⏸️ ${w.info.name} hit its ${stop.kind} limit — paused${stop.resetsAt ? ` until ${resetClock(stop.resetsAt, now)}` : ''}`, 'warn');
    return;
  }
  if (!w.info.paused) return;
  if (movedOn) done.set(w, row);
  seen.delete(w);
  w.info.paused = undefined;
  events.update({ ...w.info });
}

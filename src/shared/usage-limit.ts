// A worker's agent CLI stopped on its provider's usage limit, read off its terminal: Claude Code's
// "You've hit your session limit · resets 6am (Europe/Prague)" (session, weekly, usage, Opus…),
// its older "Claude usage limit reached|<epoch>", and Codex's "You've hit your usage limit … try again
// in 2 hours", and "Usage limit reached · continuing automatically at 2am". Conservative on purpose: only a line that *starts* with one of those (after the CLI's
// own bullets), near the bottom of the screen, so a diff or a file that quotes one doesn't pause anyone.
// Pure, so the server (which detects it) and the browser (which shows it) share the words.

import type { WorkerInfo, WorkerPause } from './protocol.js';

/** How many of the screen's last non-empty lines are looked at: the CLI's prompt box and status sit below the message. */
export const LIMIT_TAIL_LINES = 14;

/** The bullets and frames a CLI puts before a message line. */
const LEAD = /^[\s⎿●■•◆⚠✗✘×│┃>*!·∙-]*/u;
const KINDS = 'session|weekly|usage|opus|sonnet|daily|monthly|5-hour|five-hour';
const PATTERNS: { re: RegExp; kind?: string }[] = [
  // Claude Code and Codex: "You've hit your session limit · resets 6am (Europe/Prague)".
  { re: new RegExp(`^you(?:'|’)ve (?:hit|reached) your (${KINDS})(?: usage)? limit\\b`, 'i') },
  // Claude Code before: "Claude AI usage limit reached|1761364800", "Claude usage limit reached. Your limit will reset at 6am".
  { re: /^claude (?:ai )?usage limit reached\b/i, kind: 'usage' },
  // "5-hour limit reached ∙ resets 6am", "Weekly limit reached · resets Oct 27, 6am".
  { re: new RegExp(`^(${KINDS}) limit reached\\b`, 'i') },
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const CLOCK = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?`;
const DATE = String.raw`(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4}),?\s*)?(?:at\s+)?)?`;
const ZONE = String.raw`(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT)\))?`;
// "resets 6am", "try again at 6am", and Claude Code's "continuing automatically at 2am".
const AT = new RegExp(String.raw`(?:resets?|reset at|try again|continu(?:e|es|ing)(?:\s+automatically)?)\s+(?:at\s+|on\s+)?${DATE}${CLOCK}${ZONE}`, 'i');
const IN = /(?:resets?|try again)\s+in\s+(?:(\d+)\s*(?:hours?|hrs?|h)\b)?[\s,]*(?:(\d+)\s*(?:minutes?|mins?|m)\b)?/i;
const EPOCH = /\|(\d{10})\b/;
/**
 * The CLI saying the limit is over and it carries on: Claude Code's "Usage limit reset · continuing
 * automatically" (or a bare "Continuing automatically"). A limit line above it is the past, even when
 * a repaint leaves it on the screen; "continuing automatically at 2am" is still the stop itself.
 */
const RESUMED = new RegExp(String.raw`^(?:(?:claude )?(?:(?:${KINDS}) )?limit (?:has )?(?:been )?reset\b|continuing (?:automatically|now)\b(?!\s+(?:at|on|in)\b))`, 'i');

/** Which of `lines` is the last one saying the limit reset and the CLI carries on; -1 when none does. */
export function limitResumeIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (RESUMED.test(lines[i].replace(LEAD, '').trim())) return i;
  return -1;
}

/** What a stop on a usage limit looks like on the screen: which limit, when it resets, the line itself. */
export interface LimitStop {
  kind: string;
  resetsAt?: number;
  line: string;
  /** Which of the given lines it's on. */
  index: number;
}

/**
 * The usage-limit stop on a screen's last lines (`lines`, top to bottom), if there is one. `now` is
 * when it's read, which a reset time with no date counts forward from; `zone` is the time zone a reset
 * time with none named is in (the machine's own when left out).
 */
export function detectLimitStop(lines: string[], now = Date.now(), zone?: string): LimitStop | undefined {
  // Only what the CLI printed after it last said the limit reset: a stale limit line above that doesn't count.
  const resumed = limitResumeIndex(lines);
  const tail = lines.map((text, index) => ({ text, index })).filter((l) => l.index > resumed && l.text.trim()).slice(-LIMIT_TAIL_LINES);
  for (let i = tail.length - 1; i >= 0; i--) {
    const text = tail[i].text.replace(LEAD, '').trim();
    for (const p of PATTERNS) {
      const m = p.re.exec(text);
      if (!m) continue;
      // A long message wraps: its reset time can be on the next rows.
      const rest = [text, ...tail.slice(i + 1, i + 3).map((l) => l.text.trim())].join(' ');
      const kind = (p.kind ?? m[1]).toLowerCase().replace('five-hour', '5-hour');
      const resetsAt = parseReset(rest, now, zone);
      return { kind, ...(resetsAt !== undefined ? { resetsAt } : {}), line: text.slice(0, 200), index: tail[i].index };
    }
  }
  return undefined;
}

/** When the limit resets, from the message's own words; undefined when it says nothing the office reads. */
export function parseReset(text: string, now = Date.now(), zone?: string): number | undefined {
  const epoch = EPOCH.exec(text);
  if (epoch) return Number(epoch[1]) * 1000;
  const rel = IN.exec(text);
  if (rel && (rel[1] || rel[2])) return now + (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000;
  const at = AT.exec(text);
  if (!at) return undefined;
  const [, mon, day, year, h, min, ampm, named] = at;
  let hour = Number(h);
  const minute = Number(min ?? 0);
  const half = ampm?.[0].toLowerCase();
  // "resets 6" is no time at all: an hour needs am/pm or minutes.
  if (!half && min === undefined) return undefined;
  if (half && (hour < 1 || hour > 12)) return undefined;
  if (half === 'p' && hour < 12) hour += 12;
  if (half === 'a' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const tz = validZone(named) ?? validZone(zone);
  const today = partsIn(now, tz);
  if (mon) {
    const month = MONTHS.indexOf(mon.toLowerCase());
    let y = year ? Number(year) : today.year;
    let t = zonedTime(y, month, Number(day), hour, minute, tz);
    // "Jan 2" read on Dec 30 is next year's.
    if (!year && t < now - 180 * 86_400_000) t = zonedTime(++y, month, Number(day), hour, minute, tz);
    return t;
  }
  for (let d = 0; d < 3; d++) {
    const t = zonedTime(today.year, today.month, today.day + d, hour, minute, tz);
    if (t > now - 60_000) return t;
  }
  return undefined;
}

function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

function partsIn(ms: number, tz: string | undefined) {
  if (!tz) {
    const d = new Date(ms);
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
  }
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { year: p.year, month: p.month - 1, day: p.day, hour: p.hour % 24, minute: p.minute };
}

/** The moment a wall-clock time in `tz` is (the machine's own zone when none). */
function zonedTime(year: number, month: number, day: number, hour: number, minute: number, tz: string | undefined): number {
  if (!tz) return new Date(year, month, day, hour, minute).getTime();
  const wall = Date.UTC(year, month, day, hour, minute);
  const offset = (ms: number) => {
    const p = partsIn(ms, tz);
    return Date.UTC(p.year, p.month, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
  };
  const first = wall - offset(wall);
  return wall - offset(first);
}

/** "06:00", or "27. 10. 06:00" when it isn't within the next day. */
export function resetClock(at: number, now = Date.now(), timeZone?: string): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
  if (Math.abs(at - now) < 20 * 3_600_000) return time;
  return `${d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', ...(timeZone ? { timeZone } : {}) })} ${time}`;
}

/** For a status pill: "paused: session limit until 06:00". */
export function pauseLabel(p: WorkerPause, now = Date.now()): string {
  return `paused: ${p.kind} limit${p.resetsAt ? ` until ${resetClock(p.resetsAt, now)}` : ''}`;
}

/** For the process journal and Opora's Živý proces: "čeká na limit do 06:00". */
export function pauseCz(p: WorkerPause, now = Date.now(), timeZone?: string): string {
  return `čeká na limit${p.resetsAt ? ` do ${resetClock(p.resetsAt, now, timeZone)}` : ' (obnovení neuvedeno)'}`;
}

/** A worker's status as people should read it: its pause on a usage limit wins over what the agent last said. */
export function workerStatusText(w: Pick<WorkerInfo, 'status' | 'paused'>, labels: Record<string, string>): string {
  return w.paused ? pauseLabel(w.paused) : (labels[w.status] ?? w.status);
}

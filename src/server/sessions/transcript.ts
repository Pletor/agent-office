// What a Claude Code session's transcript says about where it is, for the planning room's third screen.
// Pure: lines of the transcript go in one at a time (already JSON-parsed), and the reducer keeps what
// the screen shows: the checklist (TodoWrite replaces it whole; TaskCreate/TaskUpdate add and tick
// items), the sub-sessions it starts with the Agent tool and what each reports back (at once, or later
// in a <task-notification> for one run in the background), /btw side questions, how full the context
// was on its last turn, Claude's own away summary, the tool call it's waiting on, and its last words.
//
// The format is Claude Code's own and may change: everything is defensive, and a line it doesn't
// understand is skipped. Everything kept is capped plain text (see `line`).

import type { SessionKid, SessionTodo } from '../../shared/protocol.js';

/** How many sub-sessions and checklist items a session keeps (the newest). */
const MAX_KIDS = 12;
const MAX_TODOS = 30;

export interface TranscriptState {
  todos: (SessionTodo & { id?: string })[];
  /** TaskCreate calls waiting for their result, which names the task's id. */
  creating: Record<string, string>;
  kids: SessionKid[];
  /** A background sub-session's agent id (from its launch) to its tool call: notifications and hand-backs name the agent. */
  agents: Record<string, string>;
  /** Tokens in context on the last main-session turn, and its model. */
  context?: { used: number; model: string };
  summary?: { text: string; at: number };
  /** The last text the session itself wrote (not a subagent's). */
  lastText?: { text: string; at: number };
  /** A tool call of the session's that has no result yet: what a permission prompt is about. */
  pending?: { id: string; what: string };
  lastAt?: number;
}

export const newTranscript = (): TranscriptState => ({ todos: [], creating: {}, kids: [], agents: {} });

/** One line of plain text: no control characters, cut to `n`. */
export function line(v: unknown, n = 160): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

const obj = (v: unknown): Record<string, any> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const STATUSES = new Set(['pending', 'in_progress', 'completed']);

/** The text of a message's content (a string, or text blocks). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content).map((b) => (obj(b)?.type === 'text' && typeof b.text === 'string' ? b.text : typeof b === 'string' ? b : '')).filter(Boolean).join('\n');
}

/** A tool call in a few words: `Bash: npm test`, `Edit: form.tsx`. */
export function describeCall(name: string, input: any): string {
  const i = obj(input) ?? {};
  const target = i.command ?? i.description ?? (typeof i.file_path === 'string' ? i.file_path.split(/[\\/]/).pop() : undefined) ?? i.pattern ?? i.url ?? i.query ?? i.subject;
  return line(target ? `${name}: ${target}` : name, 90);
}

function setTodos(t: TranscriptState, todos: unknown) {
  const next = arr(todos)
    .map((x) => obj(x))
    .filter((x): x is Record<string, any> => !!x)
    .map((x) => ({ text: line(x.content ?? x.subject ?? x.activeForm, 140), status: (STATUSES.has(x.status) ? x.status : 'pending') as SessionTodo['status'] }))
    .filter((x) => x.text);
  t.todos = next.slice(0, MAX_TODOS);
}

function kid(t: TranscriptState, k: SessionKid) {
  t.kids = [...t.kids.filter((x) => x.id !== k.id), k].slice(-MAX_KIDS);
}

/** A heading that only says "here's the report", not what it is. */
const BARE_HEADING = /^(?:result|results|summary|report|outcome|výsledek|shrnutí|souhrn|hlášení|report follows)[:.]?$/i;

/** A sub-session's report: the first line that says something, capped. */
function report(text: string): string {
  const first = text.split(/\n+/).map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find((l) => l && !/^(agentId|<)/i.test(l) && !BARE_HEADING.test(l));
  return line(first ?? '', 120);
}

/** The sub-session a notification or hand-back is about: by its tool call, else by its agent id. */
function kidOf(t: TranscriptState, toolUseId: string | undefined, agentId: string | undefined): SessionKid | undefined {
  const id = toolUseId ?? (agentId ? t.agents[agentId] : undefined);
  return id ? t.kids.find((x) => x.id === id) : undefined;
}

/** Said when the report itself came as a hand-back message (`<agent-message>`), not in the notification. */
const HANDED_BACK = /delivered to you as a message from/i;

/** `<task-notification>` blocks: a background sub-session finished (or failed). */
function notifications(t: TranscriptState, text: string, at: number) {
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = m[1];
    const tag = (n: string) => new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(body)?.[1]?.trim();
    const k = kidOf(t, tag('tool-use-id'), tag('task-id'));
    if (!k) continue;
    const status = tag('status') ?? '';
    const failed = /fail|error|kill|stop/i.test(status);
    const result = tag('result');
    // A result that only points at the hand-back keeps the report the hand-back gave.
    const said = result && HANDED_BACK.test(result) ? undefined : (result ?? tag('summary') ?? status);
    if (said) k.report = report(said) || k.report;
    k.report = k.report || (failed ? 'Selhalo' : 'Hotovo');
    k.state = failed ? 'fail' : 'done';
    k.at = at;
  }
}

/** `<agent-message from="…">` hand-backs: a background sub-session's final report, after "The report follows:". */
function handBacks(t: TranscriptState, text: string, at: number) {
  for (const m of text.matchAll(/<agent-message from="([\w-]+)">([\s\S]*?)(?:<\/agent-message>|$)/g)) {
    const k = kidOf(t, undefined, m[1]);
    if (!k) continue;
    k.state = 'done';
    k.report = report(m[2].split(/The report follows:[ \t]*\n/).pop() ?? '') || k.report || 'Hotovo';
    k.at = at;
  }
}

/** What the harness (not the person) put into the session as a user turn. */
const NOT_THE_PERSON = /^(?:<(?:command|local-command|task-notification|system-reminder|agent-message)|Another Claude session sent a message|\[SYSTEM NOTIFICATION)/;

/** Takes one transcript line (from the session's own file). */
export function applyTranscriptLine(t: TranscriptState, l: unknown): void {
  const o = obj(l);
  if (!o) return;
  const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  const when = Number.isFinite(at) ? at : (t.lastAt ?? 0);
  if (when > (t.lastAt ?? 0)) t.lastAt = when;
  if (o.isSidechain) return;

  if (o.type === 'system' && o.subtype === 'away_summary') {
    const text = line(o.content, 400);
    if (text) t.summary = { text, at: when };
    return;
  }
  if (o.type === 'queue-operation' && typeof o.content === 'string') {
    notifications(t, o.content, when);
    handBacks(t, o.content, when);
    return;
  }

  const msg = obj(o.message);
  if (!msg) return;
  if (o.type === 'assistant') {
    const u = obj(msg.usage);
    if (u) {
      const used = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].reduce((a: number, n) => a + (typeof n === 'number' && n > 0 ? n : 0), 0);
      if (used > 0) t.context = { used, model: typeof msg.model === 'string' ? msg.model : t.context?.model ?? '' };
    }
    for (const b of arr(msg.content)) {
      const block = obj(b);
      if (!block) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) t.lastText = { text: block.text.slice(0, 6000), at: when };
      if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;
      const name = typeof block.name === 'string' ? block.name : 'tool';
      const input = obj(block.input) ?? {};
      t.pending = { id: block.id, what: describeCall(name, input) };
      if (name === 'TodoWrite') setTodos(t, input.todos);
      else if (name === 'TaskCreate') t.creating[block.id] = line(input.subject ?? input.description, 140);
      else if (name === 'TaskUpdate') {
        const item = t.todos.find((x) => x.id !== undefined && x.id === String(input.taskId));
        if (item) {
          if (input.status === 'deleted') t.todos = t.todos.filter((x) => x !== item);
          else if (STATUSES.has(input.status)) item.status = input.status;
          if (typeof input.subject === 'string') item.text = line(input.subject, 140) || item.text;
        }
      } else if (name === 'SendMessage' && typeof input.to === 'string') {
        // Resuming a background sub-session: it's at work again until its next hand-back.
        const k = kidOf(t, undefined, input.to);
        if (k) { k.state = 'run'; k.at = when; }
      } else if (name === 'Agent' || name === 'Task') {
        kid(t, { id: block.id, kind: 'sub', name: line(input.description ?? input.subagent_type ?? 'pod-relace', 90), state: 'run', startedAt: when, at: when });
      }
    }
    return;
  }
  if (o.type !== 'user') return;
  const content = msg.content;
  const text = textOf(content);
  if (text) {
    notifications(t, text, when);
    handBacks(t, text, when);
    const btw = /<command-name>\/btw<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? /^\/btw\s+([\s\S]+)/.exec(text.trim())?.[1];
    if (btw) kid(t, { id: typeof o.uuid === 'string' ? o.uuid : `btw-${when}`, kind: 'btw', name: line(btw, 90), state: 'run', startedAt: when, at: when });
    else if (!NOT_THE_PERSON.test(text.trim()) && obj(o.origin)?.kind !== 'peer') {
      // The person said something: an open /btw question has had its answer by now.
      for (const k of t.kids) if (k.kind === 'btw' && k.state === 'run') { k.state = 'done'; k.report = k.report ?? 'Odpovězeno'; k.at = when; }
    }
  }
  for (const b of arr(content)) {
    const block = obj(b);
    if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    const id = block.tool_use_id;
    if (t.pending?.id === id) t.pending = undefined;
    const result = textOf(block.content);
    if (id in t.creating) {
      const tid = obj(obj(o.toolUseResult)?.task)?.id ?? /Task #(\w+)/.exec(result)?.[1];
      t.todos = [...t.todos, { id: tid !== undefined ? String(tid) : undefined, text: t.creating[id], status: 'pending' as const }].filter((x) => x.text).slice(-MAX_TODOS);
      delete t.creating[id];
      continue;
    }
    const k = t.kids.find((x) => x.id === id);
    if (!k) continue;
    k.at = when;
    if (/async agent launched|running in the background|launched in the background/i.test(result)) {
      const agentId = obj(o.toolUseResult)?.agentId ?? /agentId: ([\w-]+)/.exec(result)?.[1];
      if (typeof agentId === 'string') t.agents[agentId] = id;
      continue;
    }
    k.state = block.is_error ? 'fail' : 'done';
    k.report = report(result) || (k.state === 'done' ? 'Hotovo' : 'Selhalo');
  }
  // A /btw answer is the next thing the session says.
}

/** A subagent's own transcript: what it's doing now (its latest tool call) and when it last moved. */
export interface SubagentTrail {
  last?: string;
  at?: number;
}

export function applySubagentLine(s: SubagentTrail, l: unknown) {
  const o = obj(l);
  if (!o) return;
  const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (Number.isFinite(at) && at > (s.at ?? 0)) s.at = at;
  if (o.type !== 'assistant') return;
  for (const b of arr(obj(o.message)?.content)) {
    const block = obj(b);
    if (block?.type === 'tool_use' && typeof block.name === 'string') s.last = describeCall(block.name, block.input);
  }
}

const FOLLOW_HEAD = /^(?:#{1,4}\s*|\*\*)?\s*(?:next steps?|follow[- ]?ups?|what'?s next|suggested next|další kroky|navazující(?: práce)?|co dál|doporučuji dál|možná pokračování)\b/i;
const ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+(.+)$/;

/** Follow-up work suggested at the end of a message: the items under a "Next steps" (or "Další kroky") heading. */
export function followUps(text: string | undefined, max = 3): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FOLLOW_HEAD.test(lines[i].trim())) continue;
    for (let j = i + 1; j < lines.length && out.length < max; j++) {
      const raw = lines[j];
      if (!raw.trim()) { if (out.length) break; continue; }
      const m = ITEM.exec(raw);
      if (!m) break;
      const item = line(m[1].replace(/\*\*|`/g, ''), 120);
      if (item) out.push(item);
    }
    if (out.length) break;
  }
  return out;
}

/** The context window a model runs in: 1M for the long-context ones, else 200k (an estimate). */
export function contextWindow(model: string, used: number): number {
  return /\[1m\]|-1m\b/i.test(model) || used > 200_000 ? 1_000_000 : 200_000;
}

/** What a session waits on a person for: what the office heard it ask, the tool call it holds, or its last question. */
export function needOf(t: TranscriptState, asked: string | undefined): string | undefined {
  const parts: string[] = [];
  if (asked) parts.push(line(asked, 160));
  if (t.pending) parts.push(`Chce: ${t.pending.what}`);
  const last = t.lastText?.text.trim().split(/\n+/).filter(Boolean).pop();
  if (!t.pending && last && /\?\s*$/.test(last)) parts.push(line(last, 200));
  return parts.length ? line(parts.join(' · '), 280) : undefined;
}

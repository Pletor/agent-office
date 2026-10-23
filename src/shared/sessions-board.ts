// The third screen's board (🧭 Relace k cíli): every worker's session on the floor, grouped by the Opora
// card it's on, with its state, last move, checklist, sub-sessions, PR and spend; the counts by state;
// and the common goal with how far it is in three levels. Pure, so the page draws it and the server puts
// the orchestrator's sessions overview together from the same numbers (see sessions-attention.ts).

import { STATIONS } from './layout.js';
import { cleanFocus, focusLine } from './opora-scope.js';
import type { PlanStats } from './opora-lens.js';
import type { GhPull, OporaCard, OporaState, ProcessEvent, QueueTask, SessionInfo, SessionKid, SessionTodo, WorkerInfo } from './protocol.js';

/** Minutes without a move after which a session may be in a dead end. */
export const STALE_MIN = 15;

/** A session's state as the screen shows it. */
export type RowState = 'run' | 'human' | 'block' | 'done' | 'sleep' | 'idle' | 'start' | 'gone';
export type RowFlag = 'stale' | 'failing' | 'nopr' | 'stalekid' | 'offplan' | 'orphan-card';
export type GroupState = OporaCard['status'] | 'offplan' | 'ctrl';

export const ROW_STATE_CZ: Record<RowState, string> = {
  run: 'běží', human: 'čeká na člověka', block: 'blokováno', done: 'hotovo', sleep: 'spí (skončila)', idle: 'nečinná', start: 'startuje', gone: 'relace odešla',
};
export const GROUP_STATE_CZ: Record<GroupState, string> = {
  claimed: 'rozpracována', closed: 'uzavřena', blocked: 'čeká na jinou', waiting: 'čeká na člověka', offplan: 'mimo plán', ctrl: 'řízení', frontier: 'volná', needsRouting: 'bez pipeline',
};

export interface BoardPr {
  n: number;
  url?: string;
  ck: GhPull['checks'];
  s: 'open' | 'draft' | 'merged' | 'closed';
}

export interface BoardRow {
  /** The worker's id, or `ghost:<card>` for a card whose session went home. */
  id: string;
  workerId?: string;
  name: string;
  color: string;
  desk: string;
  role?: string;
  group: string;
  st: RowState;
  task: string;
  sum: string;
  need?: string;
  recap?: string;
  last: string;
  /** Minutes since it last moved (journal, transcript or status). */
  ago: number;
  todos: SessionTodo[];
  /** Checklist items done, and all of them. */
  plan: [number, number];
  pr?: BoardPr;
  cost: number;
  tokens: number;
  /** Context window filled, 0–100, when the transcript says. */
  ctx?: number;
  kids: SessionKid[];
  follow: string[];
  flags: RowFlag[];
  stale: boolean;
  model?: string;
  worktree?: string;
  branch?: string;
  acked: boolean;
  /** The card was put on it by hand (sessions.assign). */
  assigned?: boolean;
  leaseUntil?: string;
}

export interface BoardGroup {
  id: string;
  name: string;
  path: string;
  st: GroupState;
  /** How far the card is: planned, code exists, confirmed by a person (0–100 each). */
  lv?: [number, number, number];
  focus: boolean;
  rows: BoardRow[];
}

export interface BoardCounts { run: number; human: number; block: number; done: number; stale: number; gone: number }

export interface Board {
  groups: BoardGroup[];
  rows: BoardRow[];
  counts: BoardCounts;
  goal: { name: string; lv: [number, number, number]; cards: number; evidence: 'opora' | 'office' };
  kids: number;
}

export interface BoardInput {
  workers: WorkerInfo[];
  sessions: SessionInfo[];
  opora: Pick<OporaState, 'project' | 'cards' | 'runs' | 'scope' | 'focus'>;
  /** The card picked for the orchestrator at the right board. */
  focusCard?: string | null;
  events: ProcessEvent[];
  pulls: Pick<GhPull, 'number' | 'url' | 'checks' | 'state' | 'isDraft' | 'headRefName'>[];
  /** Opora's plan Lens numbers for the project, when read (code exists / confirmed by a person). */
  planStats?: PlanStats;
  deskName?(deskId: string): string | undefined;
  now: number;
}

export const CTRL = 'ctrl';
export const OFFPLAN = 'off';

const minutes = (ms: number) => Math.max(0, Math.floor(ms / 60_000));
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

function rowState(w: WorkerInfo, card?: OporaCard): RowState {
  switch (w.status) {
    case 'working': return card?.status === 'blocked' ? 'block' : 'run';
    case 'needs_input': return 'human';
    case 'done': return card?.status === 'blocked' ? 'block' : 'done';
    case 'idle': return 'idle';
    case 'starting': return 'start';
    default: return 'sleep';
  }
}

/** When each worker last moved, by the floor's journal. */
function lastMoves(events: ProcessEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    const id = e.refs.workerId;
    if (!id) continue;
    const at = Date.parse(e.at);
    if (Number.isFinite(at) && at > (out.get(id) ?? 0)) out.set(id, at);
  }
  return out;
}

function prOf(w: WorkerInfo, pulls: BoardInput['pulls']): BoardPr | undefined {
  const p = (w.pr && pulls.find((x) => x.number === w.pr!.number)) || (w.worktree?.branch ? pulls.find((x) => x.headRefName === w.worktree!.branch) : undefined);
  if (!p && !w.pr) return undefined;
  const state = p?.state ?? 'OPEN';
  return { n: p?.number ?? w.pr!.number, url: p?.url ?? w.pr?.url, ck: p?.checks ?? 'none', s: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : p?.isDraft ? 'draft' : 'open' };
}

export function rowFlags(r: Pick<BoardRow, 'st' | 'ago' | 'group' | 'pr' | 'kids' | 'worktree' | 'role'>, failing: boolean, now: number): RowFlag[] {
  const f: RowFlag[] = [];
  if (r.st === 'gone') f.push('orphan-card');
  if (r.group === OFFPLAN) f.push('offplan');
  if (r.ago >= STALE_MIN && (r.st === 'run' || r.st === 'sleep' || r.st === 'idle' || r.st === 'block')) f.push('stale');
  if (failing) f.push('failing');
  if (r.st === 'done' && !r.pr && r.group !== CTRL && r.worktree) f.push('nopr');
  if (r.kids.some((k) => k.state === 'run' && minutes(now - k.at) >= STALE_MIN)) f.push('stalekid');
  return f;
}

export const isStale = (flags: RowFlag[]) => flags.some((x) => x === 'stale' || x === 'nopr' || x === 'stalekid' || x === 'failing');

/** The card's levels as the office sees them: routed (planned), a PR (code), closed on Opora (a person confirmed). */
function cardLevels(card: OporaCard, rows: BoardRow[]): [number, number, number] {
  const plan = card.status === 'needsRouting' ? 50 : 100;
  const merged = rows.some((r) => r.pr?.s === 'merged');
  const code = card.status === 'closed' || merged ? 100 : rows.some((r) => r.pr && r.pr.s !== 'closed') ? 60 : Math.round(Math.max(0, ...rows.map((r) => pct(r.plan[0], r.plan[1]))) * 0.5);
  return [plan, code, card.status === 'closed' ? 100 : 0];
}

export function buildBoard(i: BoardInput): Board {
  const sessions = new Map(i.sessions.map((s) => [s.workerId, s]));
  const moved = lastMoves(i.events);
  const cards = new Map(i.opora.cards.map((c) => [c.id, c]));
  const runs = i.opora.runs;
  const rows: BoardRow[] = [];

  for (const w of i.workers) {
    if (w.kind !== 'agent') continue;
    const s = sessions.get(w.id);
    const run = runs.find((r) => r.workerId === w.id && r.state !== 'gone') ?? runs.find((r) => r.workerId === w.id);
    const cardId = run?.cardId ?? s?.card?.id;
    const card = cardId ? cards.get(cardId) : undefined;
    const station = STATIONS.find((d) => d.id === w.deskId);
    const group = cardId ? cardId : w.via === 'planning' || station ? CTRL : OFFPLAN;
    const lastAt = Math.max(moved.get(w.id) ?? 0, s?.lastAt ?? 0, w.waitingSince ?? 0, w.lastInput?.at ?? 0, w.createdAt);
    const todos = s?.todos ?? [];
    const done = todos.filter((t) => t.status === 'completed').length;
    const st = rowState(w, card);
    const kids = s?.kids ?? [];
    const row: BoardRow = {
      id: w.id, workerId: w.id, name: w.name, color: w.color, desk: i.deskName?.(w.deskId) ?? w.deskId,
      role: w.via === 'planning' ? 'orchestrátor' : station ? `agent u tabule ${station.label}` : undefined, group, st,
      task: w.task?.name || run?.cardName || w.title || (w.prompt ? w.prompt.slice(0, 80) : 'Bez zadání'),
      sum: w.task?.summary || s?.recap || '', need: st === 'human' ? s?.need || w.activity : st === 'block' ? `Karta čeká na jinou kartu${card ? ` (${card.name})` : ''}` : undefined,
      recap: s?.recap, last: w.activity || (st === 'done' ? 'Dokončil tah' : ROW_STATE_CZ[st]), ago: minutes(i.now - lastAt),
      todos, plan: [done, todos.length], pr: prOf(w, i.pulls), cost: w.usage?.cost ?? 0,
      tokens: w.usage ? w.usage.input + w.usage.output + w.usage.cacheRead + w.usage.cacheWrite : 0,
      ctx: s?.context ? Math.min(100, pct(s.context.used, s.context.max)) : undefined,
      kids, follow: s?.follow ?? [], flags: [], stale: false, model: w.usage?.model ?? w.model,
      worktree: w.worktree?.path, branch: w.worktree?.branch, acked: w.acked, assigned: !run && !!s?.card, leaseUntil: run?.leaseUntil,
    };
    row.flags = rowFlags(row, w.action === 'failing', i.now);
    row.stale = isStale(row.flags);
    rows.push(row);
  }

  // A card the office took whose session went home while its lease still holds: a ghost row.
  const seen = new Set(rows.map((r) => r.group));
  for (const run of runs) {
    if (run.state !== 'gone' || seen.has(run.cardId)) continue;
    const card = cards.get(run.cardId);
    const held = run.leaseUntil ? Date.parse(run.leaseUntil) > i.now : card?.status === 'claimed';
    if (!held) continue;
    seen.add(run.cardId);
    const ghost: BoardRow = {
      id: `ghost:${run.cardId}`, name: run.workerName ?? 'Relace', color: '#ffffff', desk: '—', group: run.cardId, st: 'gone',
      task: run.cardName, sum: run.leaseUntil ? `Zámek na kartě platí do ${new Date(run.leaseUntil).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}` : 'Zámek na kartě drží dál',
      last: '👻 Odeslána domů', ago: minutes(i.now - run.startedAt), todos: [], plan: [0, 0], cost: 0, tokens: 0, kids: [], follow: [], flags: [], stale: false, acked: true, leaseUntil: run.leaseUntil,
    };
    ghost.flags = rowFlags(ghost, false, i.now);
    rows.push(ghost);
  }

  const focus = i.focusCard ?? null;
  const groups: BoardGroup[] = [];
  const byGroup = (id: string) => rows.filter((r) => r.group === id);
  const ctrl = byGroup(CTRL);
  if (ctrl.length) groups.push({ id: CTRL, name: 'Řízení a kontrola', path: 'Plánovač u stolu · agenti u tabulí', st: 'ctrl', focus: false, rows: ctrl });
  for (const id of [...new Set(rows.map((r) => r.group))].filter((g) => g !== CTRL && g !== OFFPLAN)) {
    const card = cards.get(id);
    const own = byGroup(id);
    const run = runs.find((r) => r.cardId === id);
    groups.push({
      id, name: card?.name ?? run?.cardName ?? 'Karta mimo canvas', path: [card?.sectorName, card?.profile ? `${card.profile}${card.stage ? ` · ${card.stage}` : ''}` : undefined].filter(Boolean).join(' › ') || 'bez oblasti',
      st: card?.status ?? 'claimed', lv: card ? cardLevels(card, own) : undefined, focus: id === focus, rows: own,
    });
  }
  const off = byGroup(OFFPLAN);
  if (off.length) groups.push({ id: OFFPLAN, name: 'Mimo plán – bez karty Opory', path: 'práce, kterou nikdo nezadal přes kartu', st: 'offplan', focus: false, rows: off });
  // The orchestrator's card comes up top (its sessions "vyjedou nahoru").
  groups.sort((a, b) => Number(b.focus) - Number(a.focus));

  const counts: BoardCounts = { run: 0, human: 0, block: 0, done: 0, stale: 0, gone: 0 };
  for (const r of rows) {
    if (r.stale && r.st !== 'gone') counts.stale++;
    else if (r.st === 'gone' || r.group === OFFPLAN) counts.gone++;
    else if (r.st === 'run' || r.st === 'start') counts.run++;
    else if (r.st === 'human' || r.st === 'block' || r.st === 'done') counts[r.st]++;
    else counts.stale++;
  }

  const real = groups.filter((g) => g.lv);
  const st = i.planStats;
  const n = st?.cards;
  const goalLv: [number, number, number] = n && st
    ? [pct(n - (st.unassigned ?? 0), n), pct(st.withCode ?? 0, n), pct(st.confirmed ?? 0, n)]
    : real.length ? ([0, 1, 2].map((k) => Math.round(real.reduce((a, g) => a + g.lv![k], 0) / real.length)) as [number, number, number]) : [0, 0, 0];
  const where = focusLine(i.opora.scope, cleanFocus(i.opora.scope, i.opora.focus));
  const picked = focus ? cards.get(focus)?.name : undefined;
  const name = !i.opora.project ? 'Patro není propojené s Oporou – relace bez společného cíle'
    : `${i.opora.project.name} → ${where ? `buňka „${where}“` : 'celý projekt'}${picked ? ` · karta orchestrátora „${picked}“` : ''}`;
  return { groups, rows, counts, goal: { name, lv: goalLv, cards: n ?? real.length, evidence: n ? 'opora' : 'office' }, kids: rows.reduce((a, r) => a + r.kids.length, 0) };
}

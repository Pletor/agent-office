// The live process as lanes: the floor's process journal (opora.process-event/1) joined with what the
// store already knows (workers, the queue, PRs, Opora runs) for names and for work that hasn't said
// anything yet. Pure, so the wall, the window and the tests read the same thing. Nothing here is
// invented: a lane's phase, trail and blocker come only from events or the store's current state.

import { PROCESS_PHASES, type GhPull, type OporaCard, type OporaRun, type ProcessEvent, type ProcessState, type QueueTask, type WorkerInfo } from '../../../shared/protocol';

export const PHASE_CZ = ['Zadání', 'Plán', 'Práce', 'Kontroly', 'Revize', 'Sloučení', 'Paměť'] as const;
export const SOURCE_CZ: Record<ProcessEvent['source'], string> = { office: 'Kancelář', opora: 'Opora', github: 'GitHub' };

/** A trail dot: confirmed, failed, waiting, or merely seen (start/progress/info). */
export type Mark = 'ok' | 'fail' | 'wait' | 'seen';
/** The marker: the state of the lane's latest phase-moving event, or none before any. */
export type MarkerState = 'info' | 'ok' | 'wait' | 'fail' | 'blocked' | 'none';

export interface Blocker {
  lane: string;
  chip: string;
  text: string;
  /** wait: someone has to act (a human, a reviewer); fail: something broke. */
  severity: 'wait' | 'fail';
  /** It is a question for a human (needs.input). */
  human: boolean;
}

export interface Lane {
  key: string;
  name: string;
  chip: string;
  worker?: string;
  initials: string;
  /** Where its latest event came from (or where the lane itself is known from). */
  source: string;
  phase: number;
  marker: MarkerState;
  trail: (Mark | null)[];
  blocker?: Blocker;
  last?: ProcessEvent;
  lastAt: number;
  /** Newest first, at most 40. */
  events: ProcessEvent[];
  workerId?: string;
  cardId?: string;
  executionId?: string;
  branch?: string;
  pr?: number;
  prUrl?: string;
  working: boolean;
}

export interface Board {
  lanes: Lane[];
  blockers: Blocker[];
  counts: { cards: number; working: number; waiting: number; failed: number };
  phaseCounts: number[];
  /** When the newest event happened (0: none yet). */
  lastAt: number;
}

export interface BoardInput {
  events: readonly ProcessEvent[];
  workers: readonly WorkerInfo[];
  tasks: readonly QueueTask[];
  pulls: readonly GhPull[];
  runs: readonly OporaRun[];
  cards: readonly OporaCard[];
}

const LANE_EVENTS = 40;
const UNNAMED = '\u0000';

export function phaseIndex(phase: string): number {
  const i = (PROCESS_PHASES as readonly string[]).indexOf(phase);
  return i < 0 ? 2 : i;
}

export function markOf(state: ProcessState): Mark {
  return state === 'ok' ? 'ok' : state === 'fail' ? 'fail' : state === 'wait' || state === 'blocked' ? 'wait' : 'seen';
}

function markerOf(state: ProcessState): MarkerState {
  return state === 'ok' ? 'ok' : state === 'fail' ? 'fail' : state === 'wait' ? 'wait' : state === 'blocked' ? 'blocked' : 'info';
}

/** Two letters for the marker: "Vývojář 1" → V1, "Kontrolor" → KO; none → —. */
export function initials(name?: string): string {
  const words = (name ?? '').trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '—';
  if (words.length === 1) return [...words[0]].slice(0, 2).join('').toUpperCase();
  return ([...words[0]][0] + [...words[1]][0]).toUpperCase();
}

const shortId = (id: string) => (id.length > 8 ? id.slice(0, 7) + '…' : id);

/** A recall reads memory; it never moves a card's phase. */
const movesPhase = (e: ProcessEvent) => e.state !== 'info' && e.kind !== 'memory.recall';

interface Acc {
  lane: Lane;
  /** The latest event of each kind, for blockers. */
  latest: Map<string, ProcessEvent>;
  fallbackPhase: number;
  /** The store didn't know its name: Opora's card events say it ("<card>: …"), else its branch. */
  unnamed: boolean;
  moved: boolean;
}

/** Which lane an event belongs to: its card, else its queue task, else its worker (and branch), else its PR. */
export class LaneResolver {
  private runByWorker = new Map<string, OporaRun>();
  private workerById = new Map<string, WorkerInfo>();
  private branchOf = new Map<string, string>();
  constructor(private input: BoardInput) {
    for (const r of input.runs) if (r.workerId && r.state !== 'gone') this.runByWorker.set(r.workerId, r);
    for (const w of input.workers) {
      this.workerById.set(w.id, w);
      if (w.worktree?.branch) this.branchOf.set(w.id, w.worktree.branch);
    }
  }
  taskOfWorker(workerId: string): QueueTask | undefined {
    let best: QueueTask | undefined;
    for (const t of this.input.tasks) {
      if (t.workerId !== workerId) continue;
      if (t.status === 'running') return t;
      if (!best || (t.startedAt ?? t.addedAt) > (best.startedAt ?? best.addedAt)) best = t;
    }
    return best;
  }
  workerKey(workerId: string, branch?: string): string {
    if (branch && !this.branchOf.has(workerId)) this.branchOf.set(workerId, branch);
    return `worker:${workerId}:${this.branchOf.get(workerId) ?? ''}`;
  }
  key(e: ProcessEvent): string | undefined {
    const r = e.refs;
    if (r.cardId) return `card:${r.cardId}`;
    const wid = r.workerId ?? (e.actor?.kind === 'worker' ? e.actor.id : undefined);
    if (wid) {
      const run = this.runByWorker.get(wid);
      if (run) return `card:${run.cardId}`;
    }
    const tasks = this.input.tasks;
    let task = r.task ? tasks.find((t) => t.id === r.task) : undefined;
    if (!task && wid) task = this.taskOfWorker(wid);
    if (!task && r.pr) task = tasks.find((t) => t.pr?.number === r.pr);
    if (!task && r.branch) task = tasks.find((t) => t.branch === r.branch);
    if (task) return `task:${task.id}`;
    const worker = wid ? this.workerById.get(wid)
      : this.input.workers.find((w) => (r.branch && w.worktree?.branch === r.branch) || (r.pr && w.pr?.number === r.pr));
    if (worker || wid) return this.workerKey(worker?.id ?? wid!, r.branch);
    if (r.pr) return `pr:${r.pr}`;
    if (e.kind === 'guard' || e.kind === 'upkeep') return 'main';
    return undefined;
  }
}

function emptyLane(key: string, name: string, chip: string, source: string): Lane {
  return { key, name, chip, source, initials: '—', phase: 0, marker: 'none', trail: PROCESS_PHASES.map(() => null), lastAt: 0, events: [], working: false };
}

/** Name, chip and links of a lane from the store (before or besides its events). */
function describe(key: string, input: BoardInput): Lane {
  const [kind, id, branch] = key.split(':');
  if (kind === 'card') {
    const card = input.cards.find((c) => c.id === id);
    const run = input.runs.find((r) => r.cardId === id && r.state !== 'gone') ?? input.runs.find((r) => r.cardId === id);
    const lane = emptyLane(key, card?.name ?? run?.cardName ?? UNNAMED, shortId(id), 'Opora');
    lane.cardId = id;
    if (run?.workerId) lane.workerId = run.workerId;
    if (run?.workerName) lane.worker = run.workerName;
    return lane;
  }
  if (kind === 'task') {
    const t = input.tasks.find((x) => x.id === id);
    const lane = emptyLane(key, t?.title ?? 'Úkol z fronty', t?.issue ? `#${t.issue}` : 'ÚKOL', 'Kancelář');
    if (t?.workerId) lane.workerId = t.workerId;
    if (t?.workerName) lane.worker = t.workerName;
    if (t?.branch) lane.branch = t.branch;
    if (t?.pr) { lane.pr = t.pr.number; lane.prUrl = t.pr.url; }
    return lane;
  }
  if (kind === 'worker') {
    const w = input.workers.find((x) => x.id === id);
    const lane = emptyLane(key, w ? w.task?.name || w.title || w.name : UNNAMED, w?.pr ? `PR #${w.pr.number}` : 'PRÁCE', 'Kancelář');
    lane.workerId = id;
    if (w) lane.worker = w.name;
    if (branch) lane.branch = branch;
    if (w?.pr) { lane.pr = w.pr.number; lane.prUrl = w.pr.url; }
    return lane;
  }
  if (kind === 'pr') {
    const n = Number(id), p = input.pulls.find((x) => x.number === n);
    const lane = emptyLane(key, p?.title ?? `PR #${n}`, `PR #${n}`, 'GitHub');
    lane.pr = n;
    if (p) { lane.prUrl = p.url; lane.branch = p.headRefName; }
    return lane;
  }
  return emptyLane(key, 'Hlavní větev', 'main', 'GitHub');
}

const PRIORITY = ['tool.use', 'pr.checks', 'guard', 'run.claim', 'needs.input', 'pr.review', 'run.heartbeat', 'card.status'];

/** What stops a lane now: from its latest events, overruled by the store's current state where it has one. */
function blockerOf(acc: Acc, input: BoardInput): Blocker | undefined {
  const { lane, latest } = acc;
  const make = (text: string, severity: Blocker['severity'], human = false): Blocker => ({ lane: lane.key, chip: lane.chip, text, severity, human });
  const worker = lane.workerId ? input.workers.find((w) => w.id === lane.workerId) : undefined;
  const pull = lane.pr ? input.pulls.find((p) => p.number === lane.pr) : undefined;
  const found: Blocker[] = [];
  for (const kind of PRIORITY) {
    const e = latest.get(kind);
    if (kind === 'tool.use' && e?.tool?.action === 'failing') found.push(make('testy nebo build selhávají', 'fail'));
    if (kind === 'pr.checks' && (pull ? pull.state === 'OPEN' && pull.checks === 'fail' : e?.state === 'fail')) found.push(make('CI selhalo', 'fail'));
    if (kind === 'guard' && e?.state === 'fail') found.push(make('guard červený', 'fail'));
    if (kind === 'run.claim' && e?.state === 'fail') found.push(make('převzetí odmítnuto', 'fail'));
    if (kind === 'needs.input') {
      const group = ['needs.input', 'turn.start', 'turn.end', 'worker.status'].map((k) => latest.get(k)).filter((x): x is ProcessEvent => !!x);
      const newest = group.sort((a, b) => b.seq - a.seq)[0];
      const asks = worker ? worker.status === 'needs_input' : newest?.kind === 'needs.input';
      if (asks) found.push(make('čeká na vás', 'wait', true));
      else if (newest?.kind === 'worker.status' && newest.state === 'blocked' && (!worker || worker.lost)) found.push(make(newest.detail ?? 'pracovník blokován', 'wait'));
    }
    if (kind === 'pr.review' && (pull ? pull.state === 'OPEN' && pull.reviewDecision === 'CHANGES_REQUESTED' : e?.state === 'blocked')) found.push(make('změny požadovány', 'wait'));
    if (kind === 'run.heartbeat' && e?.state === 'wait') found.push(make('heartbeat selhává', 'wait'));
    if (kind === 'card.status' && e?.state === 'blocked') found.push(make('karta blokována', 'wait'));
  }
  return found[0];
}

function take(acc: Acc, e: ProcessEvent) {
  const { lane } = acc;
  const ph = phaseIndex(e.phase);
  lane.events.unshift(e);
  if (lane.events.length > LANE_EVENTS) lane.events.length = LANE_EVENTS;
  acc.latest.set(e.kind, e);
  if (movesPhase(e)) {
    lane.trail[ph] = markOf(e.state);
    lane.phase = ph;
    // Only a question for a human gets the hollow "blocked" marker; other blocks wait on someone.
    lane.marker = e.state === 'blocked' && e.kind !== 'needs.input' ? 'wait' : markerOf(e.state);
    acc.moved = true;
  } else {
    lane.trail[ph] = e.state === 'info' ? lane.trail[ph] ?? 'seen' : markOf(e.state);
    if (e.kind !== 'memory.recall') acc.fallbackPhase = ph;
  }
  lane.last = e;
  if (acc.unnamed) {
    const said = e.source === 'opora' && /^(card\.status|stage|run\.result|run\.release)$/.test(e.kind) ? /^(.{1,80}?): /.exec(e.title)?.[1] : undefined;
    if (said) { lane.name = said; acc.unnamed = false; }
  }
  lane.lastAt = Date.parse(e.at) || 0;
  lane.source = SOURCE_CZ[e.source] ?? lane.source;
  const r = e.refs;
  if (r.executionId) lane.executionId = r.executionId;
  if (r.branch) lane.branch = r.branch;
  if (r.pr) { lane.pr = r.pr; if (r.url?.includes('/pull/')) lane.prUrl = r.url; }
  if (r.workerId) lane.workerId ??= r.workerId;
  if (e.actor?.kind === 'worker' && e.actor.name) lane.worker ??= e.actor.name;
}

/** The whole board: every lane, its blockers first, then the most recently active. */
export function buildBoard(input: BoardInput): Board {
  const resolver = new LaneResolver(input);
  const accs = new Map<string, Acc>();
  const acc = (key: string) => {
    let a = accs.get(key);
    if (!a) {
      const lane = describe(key, input);
      a = { lane, latest: new Map(), fallbackPhase: -1, moved: false, unnamed: lane.name === UNNAMED };
      accs.set(key, a);
    }
    return a;
  };
  // Work the store knows about, even before it has said anything.
  const runsUsed = new Set<string>(), tasksUsed = new Set<string>();
  for (const r of input.runs) if (r.state !== 'gone') { acc(`card:${r.cardId}`); if (r.workerId) runsUsed.add(r.workerId); }
  for (const t of input.tasks) if (t.status === 'queued' || t.status === 'running') { acc(`task:${t.id}`); if (t.workerId) tasksUsed.add(t.workerId); }
  for (const w of input.workers) if (w.status !== 'offline' && !runsUsed.has(w.id) && !tasksUsed.has(w.id)) acc(resolver.workerKey(w.id));
  let lastAt = 0;
  for (const e of input.events) {
    lastAt = Math.max(lastAt, Date.parse(e.at) || 0);
    const key = resolver.key(e);
    if (key) take(acc(key), e);
  }
  const lanes: Lane[] = [];
  for (const a of accs.values()) {
    const lane = a.lane;
    if (!a.moved && a.fallbackPhase >= 0) { lane.phase = a.fallbackPhase; lane.marker = 'info'; }
    const worker = lane.workerId ? input.workers.find((w) => w.id === lane.workerId) : undefined;
    if (worker) lane.worker = worker.name;
    lane.working = worker?.status === 'working';
    lane.initials = initials(lane.worker);
    if (lane.name === UNNAMED) lane.name = lane.key.startsWith('card:') ? `Karta ${lane.chip}` : lane.branch ?? `Práce · ${lane.worker ?? 'pracovník'}`;
    lane.blocker = blockerOf(a, input);
    lanes.push(lane);
  }
  lanes.sort((a, b) => Number(!!b.blocker) - Number(!!a.blocker) || b.lastAt - a.lastAt || a.name.localeCompare(b.name, 'cs'));
  const blockers = lanes.flatMap((l) => (l.blocker ? [l.blocker] : []));
  const phaseCounts = PROCESS_PHASES.map(() => 0);
  for (const l of lanes) if (l.marker !== 'none') phaseCounts[l.phase]++;
  return {
    lanes,
    blockers,
    counts: {
      cards: lanes.length,
      working: input.workers.filter((w) => w.status === 'working').length,
      waiting: blockers.filter((b) => b.severity === 'wait').length,
      failed: blockers.filter((b) => b.severity === 'fail').length,
    },
    phaseCounts,
    lastAt,
  };
}

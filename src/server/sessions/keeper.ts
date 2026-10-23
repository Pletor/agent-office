// The floor's sessions for the planning room's third screen: every few seconds, what each worker's
// Claude Code transcript added (its checklist, sub-sessions, context, summary, last words), what the
// hooks said it asks a person, and the cards the orchestrator put sessions on by hand (kept across
// restarts). Browsers on the floor get it as a `sessions` message whenever it changes; the planner
// at the table gets the overview (brief.ts) with its brief.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GhPull, OporaState, ProcessEvent, QueueTask, SessionInfo, SessionsState, WorkerInfo } from '../../shared/protocol.js';
import { attention } from '../../shared/sessions-attention.js';
import { buildBoard } from '../../shared/sessions-board.js';
import { sessionsBrief } from './brief.js';
import { claudeProjectDirs, findTranscript, TranscriptTracker } from './reader.js';
import { contextWindow, followUps, line, needOf } from './transcript.js';

const TICK_MS = 3000;
/** How long a session id that has no transcript yet waits before it's looked for again. */
const MISS_MS = 60_000;
const FILE = 'sessions-assign.json';

export interface SessionsDeps {
  workers(): WorkerInfo[];
  dataDir: string;
  update(state: SessionsState): void;
  /** What the overview needs besides the sessions: the floor's Opora, journal, pull requests and queue. */
  opora?(): OporaState;
  focusCard?(): string | null | undefined;
  events?(): ProcessEvent[];
  pulls?(): GhPull[];
  tasks?(): QueueTask[];
  roots?: string[];
  now?(): number;
}

export class SessionsKeeper {
  private trackers = new Map<string, TranscriptTracker>();
  private paths = new Map<string, string>();
  private missed = new Map<string, number>();
  private asked = new Map<string, string>();
  private assigned: Record<string, { id: string; by: string; at: number }> = {};
  private current: SessionsState = { sessions: [], at: 0 };
  private sig = '';
  private timer: NodeJS.Timeout;
  private roots: string[];

  constructor(private deps: SessionsDeps) {
    this.roots = deps.roots ?? claudeProjectDirs();
    this.restore();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  state(): SessionsState {
    return this.current;
  }

  /** A worker's agent hook fired (already authenticated): the transcript it names, and what it asks a person. */
  noteHook(workerId: string, event: string, payload: unknown) {
    const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    if (typeof p.transcript_path === 'string' && p.transcript_path.endsWith('.jsonl')) this.paths.set(workerId, p.transcript_path);
    if ((event === 'Notification' || event === 'PermissionRequest') && typeof p.message === 'string') this.asked.set(workerId, line(p.message, 200));
    if (event === 'PermissionRequest' && typeof p.tool_name === 'string') this.asked.set(workerId, line(`${p.tool_name}${typeof (p.tool_input as any)?.command === 'string' ? `: ${(p.tool_input as any).command}` : ''}`, 200));
    if (event === 'UserPromptSubmit' || event === 'PostToolUse') this.asked.delete(workerId);
  }

  /** Puts a worker's session on a card (or takes it off). Returns why not, or nothing. */
  assign(workerId: string, cardId: string | null, by: string): string | undefined {
    if (!this.deps.workers().some((w) => w.id === workerId)) return 'Ten pracovník tu už není';
    if (cardId === null) delete this.assigned[workerId];
    else this.assigned[workerId] = { id: cardId.slice(0, 200), by: line(by, 60), at: this.now() };
    this.persist();
    this.tick(true);
    return undefined;
  }

  /** The overview for the planner: the sessions, the goal and what needs the orchestrator. */
  brief(): string | undefined {
    const workers = this.deps.workers().filter((w) => w.kind === 'agent');
    if (!workers.length) return undefined;
    const opora = this.deps.opora?.() ?? { project: null, cards: [], runs: [], scope: [], focus: [] };
    const now = this.now();
    const board = buildBoard({ workers, sessions: this.current.sessions, opora, focusCard: this.deps.focusCard?.(), events: this.deps.events?.() ?? [], pulls: this.deps.pulls?.() ?? [], now });
    return sessionsBrief(board, attention(board, { cards: opora.cards, runs: opora.runs, tasks: this.deps.tasks?.() ?? [], now }));
  }

  /** Reads what's new in every session; tells the floor when anything it shows changed. */
  tick(force = false) {
    const workers = this.deps.workers();
    const live = new Set(workers.map((w) => w.id));
    for (const id of [...this.trackers.keys()]) if (!live.has(id)) { this.trackers.delete(id); this.paths.delete(id); this.asked.delete(id); }
    let pruned = false;
    for (const id of Object.keys(this.assigned)) if (!live.has(id)) { delete this.assigned[id]; pruned = true; }
    if (pruned) this.persist();
    const sessions: SessionInfo[] = [];
    for (const w of workers) {
      if (w.kind !== 'agent') continue;
      const t = this.tracker(w);
      try {
        t?.scan();
      } catch {
        // unreadable now: tried again on the next tick
      }
      const s = t?.state;
      const asked = w.status === 'needs_input' ? this.asked.get(w.id) ?? w.activity : undefined;
      const info: SessionInfo = {
        workerId: w.id,
        todos: (s?.todos ?? []).map(({ text, status }) => ({ text, status })),
        kids: s?.kids.map((k) => ({ ...k })) ?? [],
        follow: w.status === 'done' || w.status === 'idle' || w.status === 'exited' || w.status === 'offline' ? followUps(s?.lastText?.text) : [],
        ...(s?.context ? { context: { used: s.context.used, max: contextWindow(s.context.model, s.context.used) } } : {}),
        ...(w.status === 'needs_input' && s ? { need: needOf(s, asked) } : asked ? { need: asked } : {}),
        ...(s?.summary && s.summary.at >= (s.lastText?.at ?? 0) - 120_000 ? { recap: s.summary.text } : s?.lastText ? { recap: line(s.lastText.text, 240) } : {}),
        ...(s?.lastAt ? { lastAt: s.lastAt } : {}),
        ...(this.assigned[w.id] ? { card: { ...this.assigned[w.id] } } : {}),
      };
      sessions.push(info);
    }
    const sig = JSON.stringify(sessions);
    if (!force && sig === this.sig) return;
    this.sig = sig;
    this.current = { sessions, at: this.now() };
    this.deps.update(this.current);
  }

  shutdown() {
    clearInterval(this.timer);
  }

  private tracker(w: WorkerInfo): TranscriptTracker | undefined {
    let file = this.paths.get(w.id);
    if (!file && w.sessionId) {
      const missed = this.missed.get(w.sessionId);
      if (!missed || this.now() - missed > MISS_MS) {
        file = findTranscript(w.sessionId, this.roots);
        if (file) this.paths.set(w.id, file);
        else this.missed.set(w.sessionId, this.now());
      }
    }
    if (!file) return undefined;
    let t = this.trackers.get(w.id);
    if (!t || t.file !== file) {
      t = new TranscriptTracker(file);
      this.trackers.set(w.id, t);
    }
    return t;
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private persist() {
    try {
      writeFileSync(path.join(this.deps.dataDir, FILE), JSON.stringify(this.assigned, null, 2), { mode: 0o600 });
    } catch {
      // disk trouble shouldn't take the floor down
    }
  }

  private restore() {
    const f = path.join(this.deps.dataDir, FILE);
    if (!existsSync(f)) return;
    try {
      const saved = JSON.parse(readFileSync(f, 'utf8'));
      for (const [k, v] of Object.entries<any>(saved ?? {})) if (v && typeof v.id === 'string') this.assigned[k] = { id: v.id, by: String(v.by ?? ''), at: Number(v.at) || 0 };
    } catch {
      // a broken file starts over
    }
  }
}

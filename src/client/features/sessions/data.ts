// What the third screen draws from: the board (shared/sessions-board.ts) built from the store as it is
// now, the attention boxes, and two reads the store doesn't keep: Opora's project plan Lens numbers (how
// far the goal is, as Opora has the evidence) and the floor's clean line (worktrees and branches left
// behind). Both are read at most once a minute.

import type { PlanStats } from '../../../shared/opora-lens';
import type { CleanLine } from '../../../shared/cleanline';
import { attention, type Attention, type LeftBehind } from '../../../shared/sessions-attention';
import { buildBoard, type Board } from '../../../shared/sessions-board';
import { store } from '../../state';

const EVERY = 60_000;

export class SessionsData {
  planStats?: PlanStats;
  health: LeftBehind[] = [];
  private at = 0;
  private floor: string | null = null;
  private listeners = new Set<() => void>();

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Reads the plan numbers and the clean line again, unless it did within the minute (or the floor is the same and it's not forced). */
  refresh(force = false) {
    const floor = store.floor;
    if (!floor) return;
    if (!force && floor === this.floor && Date.now() - this.at < EVERY) return;
    if (floor !== this.floor) { this.planStats = undefined; this.health = []; }
    this.floor = floor;
    this.at = Date.now();
    const card = store.opora.cards[0]?.id;
    if (store.opora.project && card) {
      void fetch(`/api/opora-lens?${new URLSearchParams({ floor, card })}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : undefined))
        .then((r) => { if (r?.plan?.state === 'ok' && floor === this.floor) { this.planStats = r.plan.stats; this.emit(); } })
        .catch(() => {});
    }
    void fetch(`/api/cleanline?${new URLSearchParams({ floor, repo: 'floor' })}`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<CleanLine>) : undefined))
      .then((d) => { if (d && floor === this.floor) { this.health = (d.health ?? []).map((h) => ({ kind: h.kind, text: h.text, where: h.where })); this.emit(); } })
      .catch(() => {});
  }

  board(): { board: Board; att: Attention } {
    const now = Date.now();
    const board = buildBoard({
      workers: [...store.workers.values()], sessions: store.sessions.sessions, opora: store.opora, focusCard: store.orchestrator.focus?.cardId,
      events: store.process.events, pulls: store.pulls.items, planStats: this.planStats, deskName: (id) => store.plan().byId.get(id)?.label, now,
    });
    return { board, att: attention(board, { cards: store.opora.cards, runs: store.opora.runs, tasks: store.queue.tasks, health: this.health, now }) };
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }
}

/** The store topics the screen follows. */
export const TOPICS = ['workers', 'sessions', 'opora', 'orchestrator', 'process', 'pulls', 'queue', 'limits', 'usage'] as const;

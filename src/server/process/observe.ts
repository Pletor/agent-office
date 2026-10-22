// Watches what a floor already tells its browsers (worker updates, the queue, the PR board, the
// Opora canvas) and turns each change into process events. It taps the floor's one outlet
// (FloorContext.emit, see office/floors.ts), so no feature has to call it.

import type { GhPull, QueueTask, ServerMsg, WorkerInfo } from '../../shared/protocol.js';
import { processHub, type ProcessHub } from './hub.js';
import type { ProcessInput } from './journal.js';
import { pullEvents, queueEvents, toolEvent, workerEvents, workerGone } from './office-events.js';
import { oporaEvents, oporaSeen, type OporaSeen } from './opora-events.js';

/** What the observer needs of a floor beyond its id: asking GitHub again, once a worker opened a PR itself. */
export interface ObservedFloor {
  readonly id: string;
  readonly github?: { refresh(): unknown };
}

/** What the bridge derives from its polls that Opora's event stream sends itself (stage.changed, result.reported, card.closed). */
const STREAMED = new Set(['card.status', 'stage', 'run.result']);

class FloorObserver {
  workers = new Map<string, WorkerInfo>();
  tasks?: Map<string, QueueTask>;
  pulls?: Map<number, GhPull>;
  opora?: OporaSeen;
  /** PRs already announced as opened, by whichever source saw it first. */
  announced = new Set<number>();

  constructor(
    private floor: ObservedFloor,
    private hub: ProcessHub,
  ) {}

  private emit(events: ProcessInput[]) {
    for (const e of events) this.hub.emit(this.floor.id, e);
  }

  message(msg: ServerMsg) {
    switch (msg.t) {
      case 'worker.update': {
        const prev = this.workers.get(msg.worker.id);
        this.workers.set(msg.worker.id, msg.worker);
        const events = workerEvents(prev, msg.worker);
        // It opened its own pull request (`gh pr create`): say so now, and ask GitHub at once rather than in 90 s.
        const pr = msg.worker.pr;
        if (prev && pr && prev.pr?.number !== pr.number) {
          if (!this.announced.has(pr.number)) {
            this.announced.add(pr.number);
            events.push({ kind: 'pr.opened', phase: 'review', state: 'start', title: `${msg.worker.name} otevřel PR #${pr.number}`, actor: { kind: 'worker', id: msg.worker.id, name: msg.worker.name }, refs: { workerId: msg.worker.id, pr: pr.number, url: pr.url, ...(msg.worker.worktree ? { branch: msg.worker.worktree.branch } : {}) } });
          }
          void Promise.resolve()
            .then(() => this.floor.github?.refresh())
            .catch(() => undefined);
        }
        return this.emit(events);
      }
      case 'worker.remove': {
        const prev = this.workers.get(msg.workerId);
        this.workers.delete(msg.workerId);
        return this.emit([workerGone(prev, msg.workerId)]);
      }
      case 'queue': {
        const events = queueEvents(this.tasks, msg.state.tasks);
        this.tasks = new Map(msg.state.tasks.map((t) => [t.id, t]));
        return this.emit(events);
      }
      case 'gh.pulls': {
        if (msg.state.loading || msg.state.error) return;
        const first = !this.pulls;
        const workerOf = (p: GhPull) => [...this.workers.values()].find((w) => w.pr?.number === p.number || (!!w.worktree && w.worktree.branch === p.headRefName));
        const events = pullEvents(this.pulls, msg.state.items, workerOf).filter((e) => {
          if (e.kind !== 'pr.opened' || e.title.includes('znovu')) return true;
          const n = e.refs?.pr ?? 0;
          if (this.announced.has(n)) return false;
          this.announced.add(n);
          return true;
        });
        this.pulls = new Map(msg.state.items.map((p) => [p.number, p]));
        if (first) for (const p of msg.state.items) this.announced.add(p.number);
        return this.emit(events);
      }
      case 'opora': {
        let events = oporaEvents(this.opora, msg.state);
        this.opora = oporaSeen(msg.state);
        // Opora's event stream already said it, as it happened: the poll's view of it is a late duplicate.
        if (this.hub.streamLive(this.floor.id)) events = events.filter((e) => e.source !== 'opora' || !STREAMED.has(e.kind));
        return this.emit(events);
      }
    }
  }

  tool(info: WorkerInfo, described: string) {
    this.emit([toolEvent(info, described)]);
  }
}

const observers = new Map<string, FloorObserver>();

function observerOf(floor: ObservedFloor, hub: ProcessHub): FloorObserver {
  let o = observers.get(floor.id);
  if (!o) observers.set(floor.id, (o = new FloorObserver(floor, hub)));
  return o;
}

/** Everything a floor sends its browsers comes through here too. Never throws. */
export function observeProcess(floor: ObservedFloor, msg: ServerMsg, hub: ProcessHub = processHub) {
  try {
    observerOf(floor, hub).message(msg);
  } catch {
    /* the journal never gets in the floor's way */
  }
}

/** A worker's tool call, as its provider's hook described it (see WorkerEvents.tool). */
export function observeTool(floor: ObservedFloor, info: WorkerInfo, described: string, hub: ProcessHub = processHub) {
  try {
    observerOf(floor, hub).tool(info, described);
  } catch {
    /* as above */
  }
}

/** The floor is gone: forget what it was. */
export function forgetObserved(floorId: string) {
  observers.delete(floorId);
}

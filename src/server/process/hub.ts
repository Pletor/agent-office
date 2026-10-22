// The building's process journals, one per floor, and who hears each new event: the floor's browsers
// and the push to Opora (see install.ts). Any part of the office says what happened with
// `emitProcess(floor, event)`; it never throws and never waits.

import type { OporaState, ProcessEvent, ProcessSnapshot, ProcessStreamHealth } from '../../shared/protocol.js';
import { ProcessJournal, SNAPSHOT_SIZE, type ProcessInput } from './journal.js';

/** What the hub reads of a floor: its checkout (to keep paths out) and its Opora link (for refs). */
export interface ProcessFloor {
  readonly id: string;
  readonly dir: string;
  readonly opora?: { view(): OporaState };
}

export type ProcessSink = (floorId: string, event: ProcessEvent) => void;

export class ProcessHub {
  private journals = new Map<string, ProcessJournal>();
  private sinks = new Set<ProcessSink>();
  /** The Canvas execution each worker runs, as its claim said. */
  private executions = new Map<string, string>();
  /** Each floor's live Opora event stream, when it has one (see opora-stream.ts). */
  readonly streams = new Map<string, ProcessStreamHealth>();
  /** This boot, so a floor's event ids never repeat after a restart. */
  readonly boot = Date.now().toString(36);

  constructor(public floors: (id: string) => ProcessFloor | undefined = () => undefined) {}

  /**
   * The floor a source means: its id, or the Opora agent name built from it (`office-<id>`,
   * `office-<id>-review`, `office-isolated-<id>`). Undefined when there's no such floor.
   */
  floorId(key: string): string | undefined {
    if (this.floors(key)) return key;
    const m = /^office-(?:isolated-)?(.+)$/.exec(key);
    if (!m) return undefined;
    if (this.floors(m[1])) return m[1];
    const review = /^(.+)-review$/.exec(m[1]);
    return review && this.floors(review[1]) ? review[1] : undefined;
  }

  journal(floorId: string): ProcessJournal {
    let j = this.journals.get(floorId);
    if (!j) {
      j = new ProcessJournal(`${floorId}.${this.boot}`, () => {
        const dir = this.floors(floorId)?.dir;
        return dir ? [dir] : [];
      });
      this.journals.set(floorId, j);
    }
    return j;
  }

  onEvent(sink: ProcessSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  noteExecution(workerId: string | undefined, executionId: string | undefined) {
    if (!workerId) return;
    if (executionId) this.executions.set(workerId, executionId);
    else this.executions.delete(workerId);
  }

  /** Records what happened on a floor and tells everyone listening. Never throws. */
  emit(key: string, input: ProcessInput): ProcessEvent | undefined {
    try {
      const id = this.floorId(key);
      if (!id) return undefined;
      const event = this.journal(id).add({ ...input, refs: this.refs(id, input.refs ?? {}) });
      for (const sink of this.sinks) {
        try {
          sink(id, event);
        } catch {
          /* a listener's trouble is its own */
        }
      }
      return event;
    } catch {
      return undefined;
    }
  }

  snapshot(floorId: string, after = 0, limit = SNAPSHOT_SIZE): ProcessSnapshot {
    const j = this.journals.get(floorId);
    const stream = this.streams.get(floorId);
    return { events: j ? j.since(after, limit) : [], seq: j?.seq ?? 0, ...(stream ? { stream: { ...stream } } : {}) };
  }

  /** Whether Opora's event stream is live for the floor, so what the bridge's polls derive is a duplicate. */
  streamLive(floorId: string): boolean {
    return !!this.streams.get(floorId)?.connected;
  }

  /** The floors that have a journal. */
  journalIds(): string[] {
    return [...this.journals.keys()];
  }

  forget(floorId: string) {
    this.journals.delete(floorId);
  }

  /** The floor's Opora project and workspace, and the card and execution a worker is on. */
  private refs(floorId: string, refs: NonNullable<ProcessInput['refs']>): NonNullable<ProcessInput['refs']> {
    const out = { ...refs, floor: floorId };
    let view: OporaState | undefined;
    try {
      view = this.floors(floorId)?.opora?.view();
    } catch {
      view = undefined;
    }
    const run = view?.runs.find((r) => (out.workerId && r.workerId === out.workerId) || (!out.workerId && out.cardId && r.cardId === out.cardId && r.state !== 'gone'));
    if (run) {
      out.cardId ??= run.cardId;
      out.workerId ??= run.workerId;
      out.workspace ??= run.workspace;
    }
    if (view?.project) {
      out.project ??= view.project.id;
      out.workspace ??= view.workspace ?? undefined;
    }
    if (out.workerId && !out.executionId) out.executionId = this.executions.get(out.workerId);
    return out;
  }
}

/** The office's own. */
export const processHub = new ProcessHub();

export function emitProcess(floor: string, input: ProcessInput): ProcessEvent | undefined {
  return processHub.emit(floor, input);
}

import type { ProcessEvent } from '../../../shared/protocol';
import type { Slice } from '../store';

/** How many of the floor's process events the page keeps. */
const PROCESS_KEEP = 300;

export interface ProcessView {
  /** Oldest first. */
  events: ProcessEvent[];
  /** The newest seq seen, to catch up from (process.since). */
  seq: number;
  /** A snapshot of this floor's journal has come in, so the list is the server's, not a guess. */
  connected: boolean;
}

declare module '../store' {
  interface Store {
    /** The floor's live process journal (see shared/protocol/process.ts). */
    process: ProcessView;
  }
  interface Topics {
    process: true;
  }
}

function keep(events: ProcessEvent[]): ProcessEvent[] {
  return events.length > PROCESS_KEEP ? events.slice(events.length - PROCESS_KEEP) : events;
}

export const processJournal: Slice = {
  init(s) {
    s.process = { events: [], seq: 0, connected: false };
  },
  on: {
    'process.event'(s, m) {
      // A floor's seq only grows; an older one is a repeat (or from a floor just left).
      if (m.event.seq <= s.process.seq && s.process.connected) return [];
      s.process = { ...s.process, events: keep([...s.process.events, m.event]), seq: Math.max(s.process.seq, m.event.seq) };
      return ['process'];
    },
    'process.snapshot'(s, m) {
      const known = new Set(s.process.events.map((e) => e.id));
      const events = keep([...s.process.events, ...m.events.filter((e) => !known.has(e.id))].sort((a, b) => a.seq - b.seq));
      s.process = { events, seq: Math.max(s.process.seq, m.seq), connected: true };
      return ['process'];
    },
  },
  enter(s, v) {
    s.process = { events: keep(v.process?.events ?? []), seq: v.process?.seq ?? 0, connected: !!v.process };
    return ['process'];
  },
};

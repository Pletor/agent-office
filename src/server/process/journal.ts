// One floor's process journal: a ring of its latest events, each with the next seq. It's where an
// event is made whole (id, time, schema) and made safe (see redact.ts), whatever source it came from.

import { PROCESS_PHASES, PROCESS_SCHEMA, type ProcessEvent, type ProcessRefs, type ProcessSnapshot } from '../../shared/protocol.js';
import { redact } from './redact.js';

/** What a source says happened; the journal fills in the rest. */
export type ProcessInput = Omit<ProcessEvent, 'schema' | 'id' | 'seq' | 'at' | 'source' | 'refs'> & {
  source?: ProcessEvent['source'];
  at?: string | number;
  refs?: ProcessRefs;
};

export const JOURNAL_SIZE = 1000;
/** What a browser is handed at once. */
export const SNAPSHOT_SIZE = 300;

const STATES = new Set(['start', 'progress', 'ok', 'fail', 'wait', 'blocked', 'info']);
const ACTIONS = new Set(['read', 'edit', 'test', 'web', 'command', 'failing']);
const REF_TEXT = ['project', 'workspace', 'cardId', 'executionId', 'workerId', 'floor', 'branch', 'sha', 'task'] as const;

export class ProcessJournal {
  private ring: ProcessEvent[] = [];
  private next = 1;

  /** `producer` names this floor in this boot, so ids never repeat across restarts. */
  constructor(
    readonly producer: string,
    private roots: () => string[] = () => [],
    private size = JOURNAL_SIZE,
  ) {}

  get seq(): number {
    return this.next - 1;
  }

  /** Makes the event whole and safe, keeps it, and hands it back. */
  add(input: ProcessInput): ProcessEvent {
    const roots = this.roots();
    const seq = this.next++;
    const source = input.source ?? 'office';
    const at = input.at === undefined ? new Date() : new Date(input.at);
    const refs: ProcessRefs = {};
    for (const k of REF_TEXT) {
      const v = input.refs?.[k];
      if (typeof v === 'string' && v) refs[k] = redact(v, 160, roots);
    }
    if (Number.isSafeInteger(input.refs?.pr) && input.refs!.pr! > 0) refs.pr = input.refs!.pr;
    const url = input.refs?.url;
    if (typeof url === 'string') {
      // No query string or fragment: they carry tokens and state.
      const bare = url.split(/[?#]/)[0];
      if (/^https:\/\/[^\s@]+$/.test(bare) && bare.length <= 300) refs.url = bare;
    }
    const event: ProcessEvent = {
      schema: PROCESS_SCHEMA,
      id: `${source}:${this.producer}:${seq}`,
      seq,
      at: (Number.isFinite(at.getTime()) ? at : new Date()).toISOString(),
      source,
      kind: redact(input.kind, 40) || 'activity',
      phase: PROCESS_PHASES.includes(input.phase) ? input.phase : 'work',
      state: STATES.has(input.state) ? input.state : 'info',
      title: redact(input.title, 120, roots) || input.kind,
      refs,
    };
    const detail = input.detail === undefined ? '' : redact(input.detail, 240, roots);
    if (detail) event.detail = detail;
    if (input.actor) {
      const { kind, id, name } = input.actor;
      event.actor = { kind, ...(id ? { id: redact(id, 80) } : {}), ...(name ? { name: redact(name, 80) } : {}) };
    }
    if (input.tool) {
      const target = input.tool.target === undefined ? '' : redact(input.tool.target, 80, roots);
      event.tool = {
        name: redact(input.tool.name, 40) || 'tool',
        ...(input.tool.action && ACTIONS.has(input.tool.action) ? { action: input.tool.action } : {}),
        ...(target ? { target } : {}),
      };
    }
    this.ring.push(event);
    if (this.ring.length > this.size) this.ring.splice(0, this.ring.length - this.size);
    return event;
  }

  /** Events after `after`, oldest first, at most `limit` (the newest ones when there are more). */
  since(after = 0, limit = SNAPSHOT_SIZE): ProcessEvent[] {
    const n = Math.max(1, Math.min(Math.floor(limit) || SNAPSHOT_SIZE, this.size));
    const out = this.ring.filter((e) => e.seq > after);
    return out.length > n ? out.slice(out.length - n) : out;
  }

  snapshot(limit = SNAPSHOT_SIZE): ProcessSnapshot {
    return { events: this.since(0, limit), seq: this.seq };
  }
}

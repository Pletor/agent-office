// The live process journal (contract opora.process-event/1): what real work did, as it happened, on
// one floor. The server keeps the last events of each floor (see server/process/) and pushes each new
// one to the floor at once; a browser arriving gets the latest ones with its floor.

export const PROCESS_SCHEMA = 'opora.process-event/1';

/** The columns of the flow map, in order. */
export const PROCESS_PHASES = ['intake', 'plan', 'work', 'checks', 'review', 'merge', 'memory'] as const;
export type ProcessPhase = (typeof PROCESS_PHASES)[number];

/** How it stands: only what the source confirmed (a finished turn is not passing tests). */
export type ProcessState = 'start' | 'progress' | 'ok' | 'fail' | 'wait' | 'blocked' | 'info';

export type ProcessSource = 'office' | 'opora' | 'github';

export type ProcessToolAction = 'read' | 'edit' | 'test' | 'web' | 'command' | 'failing';

export interface ProcessRefs {
  /** Opora project and workspace ids. */
  project?: string;
  workspace?: string;
  /** The Opora card (node id). */
  cardId?: string;
  executionId?: string;
  workerId?: string;
  floor?: string;
  branch?: string;
  pr?: number;
  sha?: string;
  url?: string;
}

export interface ProcessEvent {
  schema: typeof PROCESS_SCHEMA;
  /** Unique: `${source}:${producerId}:${seq}`. */
  id: string;
  /** Monotonic within the producer (one office floor per boot): the cursor to catch up from. */
  seq: number;
  /** ISO 8601, when the source saw it. */
  at: string;
  source: ProcessSource;
  /** Dotted kind: worker.status, tool.use, turn.start, pr.checks, run.claim… */
  kind: string;
  phase: ProcessPhase;
  state: ProcessState;
  /** ≤ 120 characters, never a secret. */
  title: string;
  /** ≤ 240 characters. */
  detail?: string;
  actor?: { kind: 'worker' | 'human' | 'agent' | 'system'; id?: string; name?: string };
  refs: ProcessRefs;
  tool?: { name: string; action?: ProcessToolAction; target?: string };
}

/** The latest events of a floor, oldest first, and the newest seq it has handed out (0 before any). */
export interface ProcessSnapshot {
  events: ProcessEvent[];
  seq: number;
}

export type ProcessClientMsg =
  /** Catch up: the floor's events after `seq` come back as a `process.snapshot`. */
  { t: 'process.since'; seq: number };

export type ProcessServerMsg =
  /** One new event on your floor, as it happened. */
  | { t: 'process.event'; event: ProcessEvent }
  /** Your floor's latest events, when you asked to catch up. */
  | ({ t: 'process.snapshot' } & ProcessSnapshot);

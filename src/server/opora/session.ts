// One worker's session on an Opora card: one stage of its pipeline, under a name of its own, with
// the lease the office claimed for it. Opora checks a review or critic isn't closed by the session
// that did the work or the fix, by the name each reports under (agent-output's `agent`), so every
// stage gets a new name, and the worker is handed that name and its lease token in its environment.
import { randomBytes } from 'node:crypto';
import { addWorkerEnv } from '../workers/env.js';

/** The stage a session is for: `pipeline.current` on the card's frontier row (none for a card with no pipeline). */
export interface SessionStage {
  id?: string;
  kind?: string;
}

/** A session the office ran on a card before: the name it claimed under and the stage's kind. */
export interface EarlierSession {
  owner?: string;
  stageKind?: string;
}

/** The stages that judge someone else's work, and the ones whose session they mustn't be. */
const JUDGING = new Set(['review', 'critic']);
const AUTHORING = new Set(['work', 'fix']);

/** Opora's longest agent name (a stage's `doneBy`). */
const MAX_NAME = 120;
const clean = (s: string) => s.replace(/[^\w .:()-]/g, '-');

/** Four hex characters telling one session of the same card and stage from another. */
export function sessionRun(): string {
  return randomBytes(2).toString('hex');
}

/**
 * A session's name as Opora takes it (`[\w .:()-]`, no slash): `office-<floor>-<card8>-<kind>-<stage8>-<run4>`,
 * or `office-<floor>-<card8>-card-<run4>` for a card with no pipeline. A long floor id is cut, never
 * the rest, so two stages' names always differ by their kind and stage.
 */
export function sessionName(floorId: string, cardId: string, stage: SessionStage, run: string): string {
  const tail = clean(`-${cardId.slice(0, 8)}-${stage.id ? `${stage.kind || 'stage'}-${stage.id.slice(0, 8)}` : 'card'}-${run}`);
  return `${clean(`office-${floorId}`).slice(0, MAX_NAME - tail.length)}${tail}`;
}

/**
 * A new session's name for a card's stage, unlike any the office ran on the card before; or, should
 * it still come out as a name that did the card's work or fix while the stage judges it, why not.
 */
export function pickSession(floorId: string, cardId: string, stage: SessionStage, earlier: readonly EarlierSession[], run: () => string = sessionRun): { name: string } | { error: string } {
  const used = new Set(earlier.map((s) => s.owner).filter(Boolean));
  let name = sessionName(floorId, cardId, stage, run());
  for (let i = 0; i < 8 && used.has(name); i++) name = sessionName(floorId, cardId, stage, run());
  const judging = JUDGING.has(stage.kind ?? '');
  // An older office's run kept no stage: it may have done the work.
  if (judging && earlier.some((s) => s.owner === name && (!s.stageKind || AUTHORING.has(s.stageKind)))) {
    return { error: `The ${stage.kind} would report to Opora as ${name}, the session that did this card’s work: it needs a session of its own, so the office won’t start it` };
  }
  if (used.has(name)) return { error: `Every name for a new session on this card is taken (${name}): send its old workers home first` };
  return { name };
}

// --- What the session's worker is handed ------------------------------------------------------------

/** Each card session's worker's environment on top of the office's, by worker id. */
const sessions = new Map<string, Record<string, string>>();
/** The session being seated, whose worker launches before seat() says who it is. */
let seating: Record<string, string> | undefined;

addWorkerEnv((workerId) => {
  if (seating && !sessions.has(workerId)) sessions.set(workerId, seating);
  return sessions.get(workerId);
});

/** Seats a worker for a session (`seat` is the floor's): its process gets `env`, on every launch. */
export function seatSession<T>(env: Record<string, string>, seat: () => T): T {
  seating = env;
  try {
    const seated = seat();
    const id: unknown = seated && typeof seated === 'object' ? (seated as { id?: unknown }).id : undefined;
    if (typeof id === 'string') sessions.set(id, env);
    return seated;
  } finally {
    seating = undefined;
  }
}

/** A session's worker seated before the office restarted. */
export function keepSession(workerId: string, env: Record<string, string>) {
  sessions.set(workerId, env);
}

/** The session's lease is gone: a worker launched again isn't handed its dead token. */
export function dropLease(workerId: string) {
  const env = sessions.get(workerId);
  if (env) sessions.set(workerId, Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'OPORA_LEASE_TOKEN')));
}

export function forgetSession(workerId: string) {
  sessions.delete(workerId);
}

/** What the skill's scripts read: Opora's address, the session's name and its lease token. */
export function sessionEnv(base: string, name: string, token?: string): Record<string, string> {
  return { OPORA_BASE_URL: base, OPORA_AGENT_NAME: name, ...(token ? { OPORA_LEASE_TOKEN: token } : {}) };
}

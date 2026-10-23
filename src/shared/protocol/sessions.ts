// The third screen of the planning room (🧭 Relace k cíli, its left wall): what each worker's session is
// doing, read off its Claude Code transcript (see server/sessions/): its live checklist (TodoWrite or
// TaskCreate/TaskUpdate), the sub-sessions it runs (the Agent tool) and its /btw side questions, how full
// its context is, what it asks a person when it waits on one, Claude's own summary of its last turn, and
// the follow-up work it suggests. Plus which Opora card the orchestrator put a session on by hand.

/** One item of a session's checklist, as Claude keeps it. */
export interface SessionTodo {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** A sub-session (a subagent the session started) or a /btw side question, under its session. */
export interface SessionKid {
  /** The tool call that started it (or the side question's message). */
  id: string;
  kind: 'sub' | 'btw';
  /** What it was asked to do, in a few words (the Agent tool's description). */
  name: string;
  state: 'run' | 'done' | 'fail';
  /** What it's doing now, while it runs: its latest tool call. */
  last?: string;
  /** What it reported back up to its session, once it's done (first line, capped). */
  report?: string;
  startedAt: number;
  /** When it last moved (ms). */
  at: number;
}

export interface SessionInfo {
  workerId: string;
  /** The session's checklist, in order; empty when it keeps none. */
  todos: SessionTodo[];
  kids: SessionKid[];
  /** How many tokens its last turn had in context, and the window it ran in (an estimate by model). */
  context?: { used: number; max: number };
  /** What it waits on a person for: the permission it asks, or its question (capped). */
  need?: string;
  /** Claude's own summary of where it is (its away summary), else the start of its last message. */
  recap?: string;
  /** Follow-up work it suggested at the end of its last message ("Next steps", "Další kroky"…). */
  follow: string[];
  /** When its transcript last moved (ms). */
  lastAt?: number;
  /** The Opora card the orchestrator put it on by hand, when it has no card of its own. */
  card?: { id: string; by: string; at: number };
}

export interface SessionsState {
  sessions: SessionInfo[];
  at: number;
}

/** The most characters the sessions overview given to the planner may have. */
export const SESSIONS_BRIEF_MAX = 2400;

export type SessionsClientMsg =
  /** Put a worker's session on an Opora card (or, null, take it off the one put by hand). */
  { t: 'sessions.assign'; workerId: string; cardId: string | null };

export type SessionsServerMsg = { t: 'sessions'; state: SessionsState };

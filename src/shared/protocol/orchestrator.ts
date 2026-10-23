// The orchestrator's focused card: the one card of the floor's Opora project someone picked at the
// Opora Control Center's right board (on the north glass), whose full detail is on the purple board,
// and whose overview the planner at the table gets with its brief (see server/orchestrator/).

/** The card picked for the orchestrator, by whom and when. */
export interface OrchestratorFocus {
  cardId: string;
  /** The card's name when it was picked, for the boards while the canvas is out of reach. */
  name: string;
  by: string;
  at: number;
}

export interface OrchestratorState {
  focus: OrchestratorFocus | null;
  /**
   * The overview the planner gets, exactly as it gets it (a block of data, at most ORCHESTRATOR_BRIEF_MAX
   * characters), once the office has read the card's Lens and preview from Opora; null before that.
   */
  brief: string | null;
  /** When the brief was last put together. */
  briefAt?: number;
}

/** The most characters the orchestrator's overview may have. */
export const ORCHESTRATOR_BRIEF_MAX = 3000;

export type OrchestratorClientMsg =
  /** Pick the card for the orchestrator, or (null) let go of it. */
  { t: 'orchestrator.focus'; cardId: string | null };

export type OrchestratorServerMsg = { t: 'orchestrator'; state: OrchestratorState };

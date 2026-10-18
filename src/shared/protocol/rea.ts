// 🔬 REA (Reverse Engineer Anything): the optional MCP server the office can hand its workers, for
// taking a reference app apart with evidence (see server/rea/). Off until an admin turns it on.

/**
 * Which workers get REA's MCP server: none, the ones working for Opora (a card's developer or
 * designer, and the planner planning onto the canvas), or every worker the office starts.
 */
export type ReaMode = 'off' | 'opora' | 'all';
export const REA_MODES: readonly ReaMode[] = ['off', 'opora', 'all'];

export interface ReaState {
  /** What applies now: AGENT_OFFICE_REA when it's set, or else what was picked in ⚙️ Settings. */
  mode: ReaMode;
  /** AGENT_OFFICE_REA set the mode, which ⚙️ Settings can't change then. */
  env?: ReaMode;
  /** The npm package and its pinned version the workers run (`npx -y <it> mcp`). */
  package: string;
  /** Who picked the mode in ⚙️ Settings, and when. Unset for the default (off). */
  by?: string;
  at?: number;
}

export type ReaClientMsg =
  /** Ask for REA's state (⚙️ Settings, as it opens). */
  | { t: 'rea.get' }
  /** Admins: which workers get REA's MCP server. */
  | { t: 'rea.set'; mode: ReaMode };

export type ReaServerMsg = { t: 'rea'; state: ReaState };

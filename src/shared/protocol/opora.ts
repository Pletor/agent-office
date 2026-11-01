// The bridge to Opora Canvas: the plan on Opora's canvas, and the office carrying its cards out.

import type { AgentEffort } from './agents.js';

/** Where a card is on Opora's canvas (its `frontier` groups): free to take, held, waiting on others, waiting on a person, closed, or with no pipeline yet. */
export type OporaCardStatus = 'frontier' | 'claimed' | 'blocked' | 'waiting' | 'closed' | 'needsRouting';

/** The desks a card goes to: the designers' or the developers'. */
export type OporaGroup = 'design' | 'dev';

export interface OporaCard {
  id: string;
  name: string;
  sectorId?: string;
  sectorName?: string;
  status: OporaCardStatus;
  /** Its pipeline's profile (code, design, goal…) and the stage on turn, once it's routed. */
  profile?: string;
  stage?: string;
  /** Canvas's agent-state offers its claim as ready: accepted plan steps and no unfinished predecessor. */
  ready?: boolean;
  /** Opora's run profile for it (agent-state `gauge.run`), when Canvas sends one. */
  run?: OporaCardRun;
  group: OporaGroup;
  /** No node of the architecture is at or above it on the canvas (no sector, no page): no switch of the focus can turn it off. */
  unplaced?: boolean;
  /** The nearest node of the architecture above it, when the card isn't in the cascade itself (a task in a sector or page): the focus judges it by that. */
  placedIn?: string;
}

/**
 * Who does a card, by Opora's gauge (Opora metriky-a-spoustece §3): its size label (XS…XL, or ? on thin evidence), the
 * Claude model, effort and advisor its worker starts on, whether it's handed out at all (an XL isn't: the heart splits
 * it) and whether a person reviews it (critical risk; the review stays Opora's).
 */
export interface OporaCardRun {
  label?: string;
  effort: AgentEffort;
  model: string;
  advisor?: string;
  handout: boolean;
  humanReview: boolean;
}

/** How deep a node of the project's architecture sits: its environment, its domain, a page, a subpage. */
export type OporaScopeLevel = 'env' | 'domain' | 'page' | 'subpage';

/**
 * One node of the project's architecture as the 🎚️ switchboard cascades it: an environment
 * (Produkce, Vývoj: an `env:` id of the office's own), a domain (an Opora sector, with its host), a
 * page and its subpages (Opora's cards).
 */
export interface OporaScopeNode {
  id: string;
  name: string;
  level: OporaScopeLevel;
  parentId: string | null;
  /** A domain's address in its environment (app.tajemstviopory.dev). */
  host?: string;
}

/** Something an agent just did on Opora's canvas, from its activity log, newest first. */
export interface OporaActivity {
  id: number;
  at: string;
  agent: string;
  /** What it did, in words (claimed, wrote a card, drew, planned…). */
  what: string;
  nodeIds: string[];
  ok: boolean;
}

/** A card the office took: the worker on it and its lease on Opora. */
export interface OporaRun {
  cardId: string;
  cardName: string;
  sectorName?: string;
  group: OporaGroup;
  workerId?: string;
  workerName?: string;
  deskId?: string;
  by: string;
  startedAt: number;
  /** working: its worker is on it; done: the worker ended its turn; gone: the worker went home and the lease was let go. */
  state: 'working' | 'done' | 'gone';
  leaseUntil?: string;
  /** The Opora workspace its lease is in, which it keeps when the floor moves to another (older saved runs have none). */
  workspace?: string;
  error?: string;
}

/**
 * What Canvas's agent-state says waits on a person in the linked workspace: decisions only a person
 * can make there (accepting the baseline, a changeset of plan steps…) and the stages they hold up.
 */
export interface OporaHumanWait {
  /** The human-only decisions, by Canvas's kind and title (at most 4). */
  decisions: { kind: string; title: string }[];
  /** The stages that block or wait, with Canvas's reason and count (at most 6). */
  stages: { id: string; health: 'blocking' | 'waiting'; reason: string; count: number }[];
  /** The cards Canvas holds back for those stages' reasons. */
  cards: number;
  /** Canvas cut its card list short, so `cards` is at least this many. */
  more?: boolean;
  /** No card can be claimed until it's decided (no accepted baseline). */
  claimsBlocked: boolean;
}

export interface OporaState {
  /** Opora's address, from the office's side. */
  url: string;
  connected: boolean;
  /** Why it isn't connected or linked, in words. */
  error?: string;
  /** The Opora project this floor is linked to (the one picked in the window, else the one whose folder is this floor's checkout), and its workspace. */
  project: { id: string; name: string } | null;
  /** How the floor is linked: someone picked the project, or its folder is the floor's. */
  linkedBy?: 'folder' | 'choice';
  /** Every project on Opora, to pick from, whenever Opora answers. */
  projects: { id: string; name: string }[];
  /** The workspace of the project read: the one picked in the window while it's still there, else `main`, else the first. */
  workspace: string | null;
  /** The linked project's workspaces, to pick from (`main` is read-only for a git project; the work ones are where planning happens). */
  workspaces: { id: string; label: string }[];
  /** How the workspace was picked: in the window, or by default (`main`, else the first). */
  workspaceBy?: 'default' | 'choice' | 'heart';
  /** The floor reads the workspace the heart works in (heart on, it has planned, nobody pinned another); picking "default" in the window follows it again. */
  followHeart?: boolean;
  sectors: { id: string; name: string }[];
  cards: OporaCard[];
  /** What waits on a person in Opora (from its agent-state), when anything does. */
  humanWait?: OporaHumanWait;
  /**
   * The linked project is planned by OPORA's heart (its brain gate is on, GET /api/brain/gate-setting):
   * the orchestrator then hands the person's task to the heart instead of planning cards itself.
   */
  heart?: boolean;
  /** The project's architecture, cascading: environments, domains, pages, subpages (see shared/opora-scope.ts). */
  scope: OporaScopeNode[];
  /**
   * What the cell works on: the nodes switched on at the 🎚️ switchboard, each with the ones above it.
   * The deepest ones are the focus; none switched on is the whole project.
   */
  focus: string[];
  /** What the agents did on the canvas lately, for the live canvas on the board. */
  activity: OporaActivity[];
  /** The office's cards, newest first (the ones that went home stay a while). */
  runs: OporaRun[];
  /** Take free cards by itself, up to `maxRuns` at once. */
  autopilot: boolean;
  /**
   * Hand the orchestrator's cards out as they come: a card that becomes ready on the canvas while the
   * planner at the Opora Control Center's table is on a plan onto Opora is taken at once (up to
   * `maxRuns`), by a worker of the department it belongs to, who fetches it from the cell's glass.
   */
  handOut: boolean;
  /** The orchestrator's cards still waiting for a department (a desk free, room under the limit). */
  handOutWaiting: string[];
  maxRuns: number;
  checkedAt: number;
  /** The office knows where Opora's repository is, so it can start it (AGENT_OFFICE_OPORA_DIR). */
  canStart: boolean;
  starting: boolean;
  /**
   * Opora lets itself be shown inside another page (its GET / sends no X-Frame-Options and no CSP
   * frame-ancestors 'none'), so the office can open it full screen in a frame of its own. Opora's
   * `embed_origins` setting turns it on.
   */
  embeddable: boolean;
  /** The pages Opora may be framed by, from its frame-ancestors; none listed is any page. */
  embedOrigins?: string[];
}

export type OporaClientMsg =
  | { t: 'opora.refresh' }
  /** Take a free card: claim its lease and seat a worker for it. */
  | { t: 'opora.take'; cardId: string }
  | { t: 'opora.autopilot'; on: boolean; maxRuns?: number }
  /** Hand the orchestrator's cards out to the departments as they come, or not. */
  | { t: 'opora.handout'; on: boolean }
  /** Link the floor to this Opora project, or (null) back to the one whose folder is the floor's. */
  | { t: 'opora.link'; projectId: string | null }
  /** Read this workspace of the linked project, or (null) the default one (`main`, else the first). */
  | { t: 'opora.workspace'; workspaceId: string | null }
  /**
   * Switch one node of the architecture on or off for what the cell works on (see toggleFocus), or
   * with `only` isolate it (just it and what's above it on); a null id is the whole project.
   */
  | { t: 'opora.focus'; id: string | null; on: boolean; only?: boolean }
  /** Start Opora from its repository (admins). */
  | { t: 'opora.start' };

export type OporaServerMsg = { t: 'opora'; state: OporaState };

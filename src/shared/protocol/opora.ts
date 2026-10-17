// The bridge to Opora Canvas: the plan on Opora's canvas, and the office carrying its cards out.

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
  group: OporaGroup;
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
  error?: string;
}

export interface OporaState {
  /** Opora's address, from the office's side. */
  url: string;
  connected: boolean;
  /** Why it isn't connected or linked, in words. */
  error?: string;
  /** The Opora project whose folder is this floor's checkout, and its workspace. */
  project: { id: string; name: string } | null;
  workspace: string | null;
  sectors: { id: string; name: string }[];
  cards: OporaCard[];
  /** The office's cards, newest first (the ones that went home stay a while). */
  runs: OporaRun[];
  /** Take free cards by itself, up to `maxRuns` at once. */
  autopilot: boolean;
  maxRuns: number;
  checkedAt: number;
  /** The office knows where Opora's repository is, so it can start it (AGENT_OFFICE_OPORA_DIR). */
  canStart: boolean;
  starting: boolean;
}

export type OporaClientMsg =
  | { t: 'opora.refresh' }
  /** Take a free card: claim its lease and seat a worker for it. */
  | { t: 'opora.take'; cardId: string }
  | { t: 'opora.autopilot'; on: boolean; maxRuns?: number }
  /** Start Opora from its repository (admins). */
  | { t: 'opora.start' };

export type OporaServerMsg = { t: 'opora'; state: OporaState };

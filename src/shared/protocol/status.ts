// 🚦 The status wall ("Stav"): a screen by the elevator that says whether the office and Opora are
// healthy, each with a traffic light and the reasons for it (see server/status/). Its words are
// Czech, the language of the people it was made for.

/** How bad one finding is: fine, in progress (amber), or work about to be lost / a wrong build (red). */
export type StatusLevel = 'ok' | 'warn' | 'bad';

/** The light a panel shows: the worst of its reasons, or grey before the first check. */
export type StatusLight = 'green' | 'amber' | 'red' | 'unknown';

export interface StatusReason {
  level: StatusLevel;
  /** What was found, in a line ("Větev foo má 3 commity mimo main bez PR"). */
  text: string;
  /** What to do about it ("otevři PR", "restartuj kancelář"). */
  fix?: string;
  /** Where it is: a branch, a path, a commit. */
  where?: string;
  /** A page about it: its pull request, say. */
  url?: string;
}

export interface StatusPanel {
  /** 'office' or 'opora'. */
  id: 'office' | 'opora';
  /** Kancelář, Opora. */
  title: string;
  light: StatusLight;
  /** The light's word: V pořádku, Rozpracováno, Pozor. */
  summary: string;
  /** Worst first. */
  reasons: StatusReason[];
  /** The repository checked, and the remote main it's held to. */
  repo?: { dir: string; remote: string; mainSha?: string; runningSha?: string; url?: string };
  /** When the cheap local checks last ran, and the last fetch of the remote. */
  checkedAt?: number;
  fetchedAt?: number;
}

export interface StatusState {
  office: StatusPanel;
  opora: StatusPanel;
  /** A check is running now. */
  checking: boolean;
}

export type StatusClientMsg =
  /** Ask for the wall's state (as the page connects). */
  | { t: 'status.get' }
  /** Check again now, fetching the remotes too (the window, as it opens and on ↻). */
  | { t: 'status.refresh' };

export type StatusServerMsg = { t: 'status'; state: StatusState };

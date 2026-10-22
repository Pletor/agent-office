// 🧹 Čistá linie (the clean line): what the Boss Office board shows about a repository's main line,
// its branches and pull requests, and what may be tidied away. Types the server and the page share,
// and the pure lane layout of the commit graph (see docs/clean-line-board.md).

/** One commit of the graph, as `git log --format=%H%x1f%P%x1f%s%x1f%an%x1f%ct%x1f%D` reads it. */
export interface GraphCommit {
  sha: string;
  parents: string[];
  subject: string;
  author: string;
  /** Committer time, seconds. */
  time: number;
  /** Branch and tag names pointing at it (HEAD -> and tag: stripped). */
  refs: string[];
  /** The PR it was squash-merged as, read from a `(#N)` at the end of its subject. */
  pr?: number;
  /** It's in the remote main. */
  main: boolean;
}

/** A commit with its place among the lanes: lane 0 is main, side lanes are branches. */
export interface GraphRow extends GraphCommit {
  lane: number;
  /** Lanes that pass by this row untouched (a straight line through it). */
  through: number[];
  /** Lanes from the row above that end in this commit (a branch converging into it). */
  merging: number[];
  /** Whether a line comes down into the node from the row above in its own lane. */
  fromAbove: boolean;
  /** The lane each of its parents (in the graph) continues in, in parent order. */
  toParents: number[];
  /** It has parents outside the graph's window: its lane runs off the bottom. */
  cut: boolean;
}

export type ChecksState = 'pass' | 'fail' | 'pending' | 'none';

export type QueueFlag = 'stacked' | 'behind' | 'conflict' | 'draft' | 'checks-fail' | 'checks-pending' | 'changes-requested' | 'blocked' | 'unknown';

export interface QueueItem {
  number: number;
  title: string;
  url?: string;
  author: string;
  head: string;
  base: string;
  draft: boolean;
  checks: ChecksState;
  review: string;
  mergeState: string;
  createdAt: string;
  /** Ready to squash-merge now: see isGreen. */
  green: boolean;
  flags: QueueFlag[];
  /** Why it isn't green (Czech), or why it is. */
  reasons: string[];
}

export type HealthKind = 'stacked' | 'behind' | 'merged-not-deleted' | 'orphan-worktree' | 'dirty-main' | 'drift-server' | 'drift-client' | 'info';

export interface HealthFlag {
  kind: HealthKind;
  level: 'bad' | 'warn' | 'ok';
  text: string;
  where?: string;
  fix?: string;
}

export type CleanupKind = 'branch' | 'remote-branch' | 'worktree';

/** Something the Uklidit button would delete, exactly. `key` is what the page sends back to confirm it. */
export interface CleanupItem {
  key: string;
  kind: CleanupKind;
  /** The branch's name, or the worktree's folder. */
  name: string;
  sha?: string;
  reason: string;
}

export interface CleanupPlan {
  items: CleanupItem[];
  /** Candidates left alone, and why (dirty, a live worker, checked out). */
  kept: { name: string; why: string }[];
}

export interface CleanupResult {
  done: { key: string; name: string }[];
  skipped: { key: string; why: string }[];
  /** Where the refs were backed up before deleting. */
  backup?: string;
}

export type RepoChoice = 'floor' | 'office';

export interface CleanLine {
  repo: { id: RepoChoice; dir: string; label: string; remote: string; mainSha?: string; url?: string };
  /** The repositories the window can switch between (the floor's, and the office's own source). */
  repos: { id: RepoChoice; label: string }[];
  checkedAt: number;
  error?: string;
  graph: GraphRow[];
  lanes: number;
  queue: QueueItem[];
  /** Why the queue may be incomplete (no gh, say). */
  queueNote?: string;
  health: HealthFlag[];
  counts: { next: number | null; red: number; cleanup: number; drift: number };
  /** This session may press Sloučit and Uklidit (an admin, or the shared password). */
  canAct: boolean;
}

/** The PR number a squash-merge subject ends with: "feat: x (#42)". */
export function prOfSubject(subject: string): number | undefined {
  const m = /\(#(\d+)\)\s*$/.exec(subject);
  return m ? Number(m[1]) : undefined;
}

/** Branch and tag names from %D ("HEAD -> main, fork/main, tag: v1"), without HEAD itself. */
export function refsOf(decoration: string): string[] {
  return decoration
    .split(',')
    .map((s) => s.trim().replace(/^HEAD -> /, '').replace(/^tag: /, ''))
    .filter((s) => s && s !== 'HEAD' && !s.endsWith('/HEAD'));
}

/**
 * Orders commits children-before-parents, newest first where that's free (Kahn's algorithm with the
 * newest ready commit next), so the main list and the branches' lists can be merged into one graph.
 */
export function topoOrder(commits: readonly GraphCommit[]): GraphCommit[] {
  const by = new Map(commits.map((c) => [c.sha, c]));
  const children = new Map<string, number>();
  for (const c of commits) for (const p of c.parents) if (by.has(p)) children.set(p, (children.get(p) ?? 0) + 1);
  const ready = commits.filter((c) => !children.get(c.sha));
  const out: GraphCommit[] = [];
  const seen = new Set<string>();
  while (ready.length) {
    let best = 0;
    for (let i = 1; i < ready.length; i++) if (ready[i].time > ready[best].time || (ready[i].time === ready[best].time && ready[i].main && !ready[best].main)) best = i;
    const [c] = ready.splice(best, 1);
    if (seen.has(c.sha)) continue;
    seen.add(c.sha);
    out.push(c);
    for (const p of c.parents) {
      if (!by.has(p)) continue;
      const left = (children.get(p) ?? 1) - 1;
      children.set(p, left);
      if (left === 0) ready.push(by.get(p)!);
    }
  }
  return out;
}

/**
 * Lays commits (children before parents) out in lanes like GitHub's or VS Code's Git Graph: the main
 * line's first parents keep lane 0, every other line takes the lowest free side lane, a merge opens a
 * lane for its second parent, and lanes waiting for the same commit converge into it.
 */
export function layoutGraph(commits: readonly GraphCommit[]): { rows: GraphRow[]; lanes: number } {
  const inGraph = new Set(commits.map((c) => c.sha));
  // The main line: the first-parent chain from the newest main commit.
  const mainLine = new Set<string>();
  const tip = commits.find((c) => c.main);
  const by = new Map(commits.map((c) => [c.sha, c]));
  for (let c = tip; c && !mainLine.has(c.sha); c = c.parents[0] ? by.get(c.parents[0]) : undefined) mainLine.add(c.sha);
  const lanes: (string | null)[] = [];
  let width = 1;
  const free = () => {
    for (let i = 1; i < lanes.length; i++) if (lanes[i] === null) return i;
    lanes.push(null);
    return Math.max(1, lanes.length - 1);
  };
  if (!lanes.length) lanes.push(null);
  const rows: GraphRow[] = [];
  for (const c of commits) {
    const expecting = lanes.map((s, i) => (s === c.sha ? i : -1)).filter((i) => i >= 0);
    let lane: number;
    if (mainLine.has(c.sha)) lane = 0;
    else if (expecting.length) lane = expecting.find((i) => i !== 0) ?? expecting[0];
    else lane = free();
    if (lane === 0 && lanes[0] !== null && lanes[0] !== c.sha) lane = free(); // lane 0 is someone else's
    const fromAbove = lanes[lane] === c.sha;
    const merging = expecting.filter((i) => i !== lane);
    for (const i of merging) lanes[i] = null;
    const through = lanes.map((s, i) => (s !== null && i !== lane ? i : -1)).filter((i) => i >= 0);
    const parents = c.parents.filter((p) => inGraph.has(p));
    const toParents: number[] = [];
    lanes[lane] = null;
    for (const [n, p] of parents.entries()) {
      const already = lanes.indexOf(p);
      if (already >= 0) {
        toParents.push(already);
        continue;
      }
      // The first parent carries on in this lane, unless it's on the main line and this lane isn't 0.
      let at: number;
      if (mainLine.has(p)) at = 0;
      else if (n === 0 && lane !== 0) at = lane;
      else if (n === 0 && lane === 0) at = free();
      else at = free();
      if (mainLine.has(p) && lanes[0] !== null && lanes[0] !== p) at = free();
      lanes[at] = p;
      toParents.push(at);
    }
    while (lanes.length > 1 && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, lane + 1, ...toParents.map((l) => l + 1), ...through.map((l) => l + 1), ...merging.map((l) => l + 1));
    rows.push({ ...c, lane, through, merging, fromAbove, toParents, cut: parents.length < c.parents.length });
  }
  return { rows, lanes: width };
}

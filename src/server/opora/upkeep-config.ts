/**
 * Settings of the Opora PR upkeep and the post-merge guard (upkeep-runner.ts), all from the
 * environment and both off by default. Upkeep keeps the office's own open pull requests rebased on
 * their base; the guard watches the base branch's CI and opens a revert PR for the first bad Opora
 * merge. Neither ever merges anything.
 */
export interface UpkeepConfig {
  /** `AGENT_OFFICE_OPORA_UPKEEP`: rebase open Opora PRs that are behind or conflicting. */
  upkeep: boolean;
  /** `AGENT_OFFICE_OPORA_GUARD`: watch the base branch's CI and revert the first bad Opora merge. */
  guard: boolean;
  /** `AGENT_OFFICE_OPORA_RESOLVE`: let a headless Claude resolve textual rebase conflicts (default on). */
  resolve: boolean;
  /** `AGENT_OFFICE_OPORA_UPKEEP_FIX_FINDINGS`: let a headless Claude fix a current PR's open important review findings (default on with upkeep). */
  fixFindings: boolean;
  /** `AGENT_OFFICE_OPORA_CHECK_COMMAND`: the shell line that must pass before a rebased PR is pushed. */
  checkCommand?: string;
  /** How long one check run may take. */
  checkTimeoutMs: number;
  /** `AGENT_OFFICE_OPORA_GUARD_BRANCH`: the branch the guard watches (default `main`). */
  guardBranch: string;
  /** Upkeep attempts per pull request head commit before it's left to a human. */
  attemptsPerHead: number;
  /** Pull requests rebased per pass. */
  perPass: number;
  /** Conflict-resolver runs started in any rolling hour. */
  resolvesPerHour: number;
  /** How long one resolver run may take before it's killed. */
  resolveTimeoutMs: number;
  /** The `--model` given to the resolver, or Claude Code's default. */
  model?: string;
  /** Local check runs one bisect may spend on commits CI has no result for. */
  localRunsPerBisect: number;
  /** First-parent commits the guard looks back for the last green one. */
  depth: number;
  /** Time between passes. */
  intervalMs: number;
}

const ON = /^(?:1|on|true|yes)$/i;
const OFF = /^(?:0|off|false|no)$/i;

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number((value ?? '').trim());
  return value && value.trim() && Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

export function upkeepConfig(env: NodeJS.ProcessEnv = process.env): UpkeepConfig {
  const model = (env.AGENT_OFFICE_OPORA_RESOLVE_MODEL ?? '').trim();
  const branch = (env.AGENT_OFFICE_OPORA_GUARD_BRANCH ?? '').trim();
  const check = (env.AGENT_OFFICE_OPORA_CHECK_COMMAND ?? '').trim();
  return {
    upkeep: ON.test((env.AGENT_OFFICE_OPORA_UPKEEP ?? '').trim()),
    guard: ON.test((env.AGENT_OFFICE_OPORA_GUARD ?? '').trim()),
    resolve: !OFF.test((env.AGENT_OFFICE_OPORA_RESOLVE ?? '').trim()),
    fixFindings: !OFF.test((env.AGENT_OFFICE_OPORA_UPKEEP_FIX_FINDINGS ?? '').trim()),
    ...(check ? { checkCommand: check } : {}),
    checkTimeoutMs: int(env.AGENT_OFFICE_OPORA_CHECK_TIMEOUT_MIN, 20, 1, 120) * 60_000,
    guardBranch: /^[A-Za-z0-9._/-]{1,200}$/.test(branch) && !branch.includes('..') ? branch : 'main',
    attemptsPerHead: int(env.AGENT_OFFICE_OPORA_UPKEEP_ATTEMPTS, 2, 1, 10),
    perPass: int(env.AGENT_OFFICE_OPORA_UPKEEP_PER_PASS, 3, 1, 20),
    resolvesPerHour: int(env.AGENT_OFFICE_OPORA_RESOLVE_PER_HOUR, 4, 0, 60),
    resolveTimeoutMs: int(env.AGENT_OFFICE_OPORA_RESOLVE_TIMEOUT_MIN, 15, 1, 60) * 60_000,
    ...(/^[A-Za-z0-9._[\]-]{1,80}$/.test(model) ? { model } : {}),
    localRunsPerBisect: int(env.AGENT_OFFICE_OPORA_GUARD_LOCAL_RUNS, 4, 0, 20),
    depth: int(env.AGENT_OFFICE_OPORA_GUARD_DEPTH, 40, 2, 200),
    intervalMs: int(env.AGENT_OFFICE_OPORA_UPKEEP_INTERVAL_MIN, 5, 1, 120) * 60_000,
  };
}

/** Starts in a rolling hour against a limit (the resolver's and the finding fixer's shared budget). */
export class HourlyBudget {
  private starts: number[] = [];
  constructor(private limit: number, private now: () => number = Date.now) {}
  /** Whether another start fits in the hour. */
  available(): boolean {
    const cutoff = this.now() - 3_600_000;
    this.starts = this.starts.filter((at) => at > cutoff);
    return this.starts.length < this.limit;
  }
  started() {
    this.starts.push(this.now());
  }
}

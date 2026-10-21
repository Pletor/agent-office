/**
 * Settings of the review workers (review-runner.ts), all from the environment and all off by default:
 * the office only reviews when `AGENT_OFFICE_OPORA_REVIEWS` is on and Canvas has its review jobs on.
 */
export interface ReviewConfig {
  enabled: boolean;
  /** Review slots (finder or voter) running at once on this floor. */
  maxParallel: number;
  /** Review slots started in any rolling hour on this floor. */
  maxPerHour: number;
  /** The slot lease asked of Canvas; heartbeats renew it every third of it. */
  ttlSeconds: number;
  /** How long one model run may take before it's killed and the slot released. */
  timeoutMs: number;
  /** The `--model` given to Claude Code, or its default. */
  model?: string;
  /** Whether completed jobs are posted to their pull requests through `gh`. */
  post: boolean;
  /** How long to stay quiet after Canvas says review jobs are off (409) or doesn't know them (404). */
  backoffMs: number;
}

const ON = /^(?:1|on|true|yes)$/i;
const OFF = /^(?:0|off|false|no)$/i;

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number((value ?? '').trim());
  return value && Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

export function reviewConfig(env: NodeJS.ProcessEnv = process.env): ReviewConfig {
  const model = (env.AGENT_OFFICE_OPORA_REVIEW_MODEL ?? '').trim();
  return {
    enabled: ON.test((env.AGENT_OFFICE_OPORA_REVIEWS ?? '').trim()),
    maxParallel: int(env.AGENT_OFFICE_OPORA_REVIEW_PARALLEL, 2, 1, 8),
    maxPerHour: int(env.AGENT_OFFICE_OPORA_REVIEW_PER_HOUR, 12, 1, 200),
    ttlSeconds: int(env.AGENT_OFFICE_OPORA_REVIEW_TTL, 600, 30, 3600),
    timeoutMs: int(env.AGENT_OFFICE_OPORA_REVIEW_TIMEOUT_MIN, 20, 1, 120) * 60_000,
    ...(/^[A-Za-z0-9._[\]-]{1,80}$/.test(model) ? { model } : {}),
    post: !OFF.test((env.AGENT_OFFICE_OPORA_REVIEW_POST ?? '').trim()),
    backoffMs: 10 * 60_000,
  };
}

/** Slot starts in a rolling hour and slots running now, against the two limits. */
export class ReviewBudget {
  private starts: number[] = [];
  constructor(private config: Pick<ReviewConfig, 'maxParallel' | 'maxPerHour'>, private now: () => number = Date.now) {}
  /** Why no slot can start now, or undefined when one can. */
  blocked(running: number): string | undefined {
    const cutoff = this.now() - 3_600_000;
    this.starts = this.starts.filter((at) => at > cutoff);
    if (running >= this.config.maxParallel) return 'parallel';
    if (this.starts.length >= this.config.maxPerHour) return 'hourly';
    return undefined;
  }
  started() {
    this.starts.push(this.now());
  }
}

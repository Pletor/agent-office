import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { gh as runGh } from '../github.js';
import { childEnv } from '../workers/env.js';
import { resolveCommand } from '../workers/process.js';
import { claudeReviewAgent, type ReviewAgent } from './review-agent.js';
import { prepareCheckout, type Checkout, type Git } from './review-checkout.js';
import { ReviewJobClient, ReviewJobError, type ReviewAssignment, type ReviewScope } from './review-client.js';
import { ReviewBudget, reviewConfig, type ReviewConfig } from './review-config.js';
import { ReviewPoster, type Gh } from './review-github.js';
import { runSlot, type SlotOutcome } from './review-slot.js';

/**
 * Review workers (OporaHub phase 3a, the office's side): on each bridge poll, while there's room
 * under the parallel and hourly limits, claim review slots of the floor's Opora project from Canvas
 * and run each in a fresh model context (review-slot.ts); then post every completed job's findings
 * to its pull request (review-github.ts). Off unless `AGENT_OFFICE_OPORA_REVIEWS` is on; while
 * Canvas has review jobs off (409 review_jobs_disabled) or doesn't have them (404) it backs off
 * quietly and tries again later.
 */

type Level = 'info' | 'warn';
export interface ReviewRunnerDeps {
  client: ReviewJobClient;
  agent: ReviewAgent;
  git: Git;
  gh: Gh;
  now(): number;
}

export class ReviewJobRunner {
  private running = new Map<string, Promise<SlotOutcome>>();
  private budget: ReviewBudget;
  private poster: ReviewPoster;
  private quietUntil = 0;
  private ticking?: Promise<void>;
  private said = new Set<string>();
  private stopped = false;

  constructor(private config: ReviewConfig, private repoDir: string, private dataDir: string,
    private deps: ReviewRunnerDeps, private log: (message: string, level: Level) => void) {
    this.budget = new ReviewBudget(config, deps.now);
    this.poster = new ReviewPoster(deps.gh, path.join(dataDir, 'opora-reviews', 'posted.json'));
  }

  /** Slots running now, by task id. */
  get active(): number { return this.running.size; }

  /** One pass: claim what there's room for, then post completed jobs. A pass under way is joined, not doubled. */
  tick(scope: ReviewScope): Promise<void> {
    if (!this.config.enabled || this.stopped) return Promise.resolve();
    this.ticking ??= this.pass(scope).finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  /** Waits for the slots under way (for tests and shutdown). */
  async idle(): Promise<void> {
    await this.ticking;
    await Promise.allSettled([...this.running.values()]);
  }

  shutdown() { this.stopped = true; }

  private once(key: string, message: string, level: Level) {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.log(message, level);
  }

  /** Canvas says review jobs are off: quiet until the backoff passes, then ask again. */
  private off(error: ReviewJobError): boolean {
    if (!error.disabled) return false;
    this.quietUntil = this.deps.now() + this.config.backoffMs;
    this.once('disabled', `🔎 Canvas has automated code review off (${error.status}); review workers wait and ask again in ${Math.round(this.config.backoffMs / 60_000)} min`, 'info');
    return true;
  }

  private async pass(scope: ReviewScope) {
    if (this.deps.now() < this.quietUntil) return;
    await this.claim(scope);
    if (this.config.post && this.deps.now() >= this.quietUntil) await this.publish(scope);
  }

  private async claim(scope: ReviewScope) {
    while (!this.stopped && !this.budget.blocked(this.running.size)) {
      const requestId = `rc-${randomBytes(16).toString('hex')}`;
      let task: ReviewAssignment | null = null;
      try {
        // A lost answer is retried once with the same request id, which Canvas replays as the same slot.
        try { task = await this.deps.client.claim(scope, requestId, this.config.ttlSeconds); }
        catch (error) { if (!(error instanceof ReviewJobError && error.transient)) throw error; task = await this.deps.client.claim(scope, requestId, this.config.ttlSeconds); }
      } catch (error) {
        if (error instanceof ReviewJobError && this.off(error)) return;
        this.once(`claim:${(error as Error).message}`, `🔎 Claiming a review slot failed: ${(error as Error).message}`, 'warn');
        return;
      }
      this.said.delete('disabled');
      if (!task) return;
      this.budget.started();
      const a = task;
      const slot = runSlot(scope, a, {
        client: this.deps.client,
        agent: this.deps.agent,
        checkout: (x) => this.checkout(x),
        ttlSeconds: this.config.ttlSeconds,
        log: this.log,
      }).catch((): SlotOutcome => 'released').finally(() => this.running.delete(a.taskId));
      this.running.set(a.taskId, slot);
    }
  }

  private checkout(a: ReviewAssignment): Promise<Checkout> {
    return prepareCheckout(this.deps.git, this.repoDir, path.join(this.dataDir, 'opora-reviews', 'checkouts'), a.job, `${a.taskId}-${a.epoch}`);
  }

  private async publish(scope: ReviewScope) {
    let listing;
    try { listing = await this.deps.client.list(scope); } catch (error) {
      if (error instanceof ReviewJobError) this.off(error);
      return;
    }
    for (const job of listing.jobs) {
      if (job.phase !== 'completed' || this.stopped) continue;
      try {
        const done = await this.poster.post(job, listing.findings);
        if (done !== 'unchanged') this.log(`🔎 ${done === 'posted' ? 'Posted' : 'Updated'} the review of ${job.repository}#${job.number} round ${job.round} on GitHub`, 'info');
      } catch (error) {
        this.once(`post:${job.reviewJobId}`, `🔎 Couldn't post review ${job.reviewJobId} to ${job.repository}#${job.number}: ${(error as Error).message}`, 'warn');
      }
    }
  }
}

/** The runner for a floor's bridge, or undefined while it's off or Claude Code isn't installed. */
export function createReviewRunner(base: string, agent: string, repoDir: string, dataDir: string,
  log: (message: string, level: Level) => void, env: NodeJS.ProcessEnv = process.env): ReviewJobRunner | undefined {
  const config = reviewConfig(env);
  if (!config.enabled) return undefined;
  const claude = resolveCommand('claude');
  if (!claude) {
    log('🔎 AGENT_OFFICE_OPORA_REVIEWS is on but the claude CLI is not installed: review workers stay off', 'warn');
    return undefined;
  }
  return new ReviewJobRunner(config, repoDir, dataDir, {
    client: new ReviewJobClient(base, `${agent}-review`),
    agent: claudeReviewAgent(claude, childEnv(), config.timeoutMs, config.model),
    // A large pull request's diff can be well over the usual 4 MB; the prompt takes only its start.
    git: (args, cwd) => new Promise((resolve, reject) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n').slice(-2).join(' ') || 'git failed')) : resolve(stdout)))),
    gh: (args) => runGh(args, repoDir, 60_000),
    now: Date.now,
  }, log);
}

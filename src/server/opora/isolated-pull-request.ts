import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeRepo } from '../../shared/floors.js';
import type { ExecutionIntent } from './executors/types.js';
import type { IsolatedRun } from './isolated-storage.js';
import { autoPrDisabled, defaultHandoffTools, PullRequestHandoff, type HandoffOutcome, type HandoffTools } from './pull-request-handoff.js';
import type { SelfCheckReporter } from './self-checks.js';
import { throwaway } from './upkeep-tools.js';

/**
 * The isolated broker's pull request (isolated-service.ts). A Managed Agents run works in a provider
 * container on the pinned published commit, so nothing of it is in a local worktree. When its
 * reported result carries a patch (`result.patch`: `git format-patch --stdout <pinned>..HEAD`, or a
 * plain `git diff`), the office applies it in a throwaway worktree at that exact pinned commit and
 * hands it off through the same PullRequestHandoff as a card worker: the same `opora/<card>/<execution>`
 * branch, trailers, Canvas link and per-head idempotency. The commits are made with fixed identity
 * and dates (`git am --committer-date-is-author-date`), so the same patch is the same head commit and
 * a retry reuses the pull request instead of pushing a second one. Nothing here merges or approves.
 */

type Notify = (message: string, level: 'info' | 'warn' | 'error') => void;
export type IsolatedPrOutcome = HandoffOutcome | { state: 'skipped'; reason: string };

const IDENTITY = ['-c', 'user.name=Agent Office', '-c', 'user.email=agent-office@users.noreply.github.com', '-c', 'commit.gpgsign=false'];
const MAX_PATCH = 60_000;

/** What the remote agent is asked for, besides its result envelope (isolated-reports.ts). */
export function patchInstructions(intent: Pick<ExecutionIntent, 'repository'>): string {
  return `If you changed files: commit them in /workspace/repo, then put the output of \`git format-patch --stdout ${intent.repository.commitSha}..HEAD\` `
    + 'into result.patch as one JSON string (the office applies it to the same pinned commit and opens the pull request itself; never push). '
    + `Leave result.patch out when nothing changed or the patch is over ${MAX_PATCH} characters, and say so in result.summary.`;
}

/** A plain diff as a one-commit mbox, so `git am` makes a commit with a fixed author, date and message. */
export function asMailbox(patch: string, subject: string, date: string): string {
  if (patch.startsWith('From ')) return patch.endsWith('\n') ? patch : `${patch}\n`;
  const when = Number.isFinite(Date.parse(date)) ? new Date(date).toUTCString().replace('GMT', '+0000') : 'Thu, 1 Jan 1970 00:00:00 +0000';
  return [
    'From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001',
    'From: Agent Office <agent-office@users.noreply.github.com>',
    `Date: ${when}`,
    `Subject: [PATCH] ${subject.replace(/[\r\n]+/g, ' ').slice(0, 200)}`,
    '', '---', patch.endsWith('\n') ? patch : `${patch}\n`, '',
  ].join('\n');
}

export class IsolatedPullRequests {
  private running = new Map<string, Promise<IsolatedPrOutcome>>();
  private handoff: PullRequestHandoff;
  /**
   * `repo` is the floor's checkout (its `origin` must be the intent's repository); `directory` is
   * private to the broker and holds the handoff's files, the patches and the throwaway worktrees.
   */
  constructor(private repo: string, private directory: string, base: string, agent: string,
    private tools: HandoffTools = defaultHandoffTools(), private selfChecks?: SelfCheckReporter) {
    this.handoff = new PullRequestHandoff(directory, base, agent, tools);
  }

  private file(executionId: string, kind: string) { return path.join(this.directory, 'opora-executions', `${executionId}-${kind}`); }

  /** Opens (or reuses) the run's pull request once its result is confirmed; a second call while one runs waits for it. */
  handOff(run: IsolatedRun, notify: Notify): Promise<IsolatedPrOutcome> {
    const id = run.lease?.executionId ?? run.key;
    const busy = this.running.get(id);
    if (busy) return busy;
    const job = this.attempt(run, notify).catch((error): IsolatedPrOutcome => ({ state: 'failed', reason: (error as Error).message }))
      .finally(() => this.running.delete(id));
    this.running.set(id, job);
    return job;
  }

  private ledger(id: string): { digest: string; outcome: IsolatedPrOutcome } | undefined {
    try { return JSON.parse(readFileSync(this.file(id, 'isolated.json'), 'utf8')); } catch { return undefined; }
  }
  private remember(id: string, digest: string, outcome: IsolatedPrOutcome) {
    try {
      mkdirSync(path.dirname(this.file(id, 'isolated.json')), { recursive: true, mode: 0o700 });
      writeFileSync(this.file(id, 'isolated.json'), JSON.stringify({ digest, outcome, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
    } catch { /* the handoff's own per-head record still stops a second push */ }
  }

  private async attempt(run: IsolatedRun, notify: Notify): Promise<IsolatedPrOutcome> {
    const { lease, intent, pendingResult, resultReceipt } = run;
    if (!lease || !intent || !pendingResult || !resultReceipt) return { state: 'skipped', reason: 'the result is not confirmed by Canvas yet' };
    const id = lease.executionId;
    const { patch, ...result } = pendingResult.report.result;
    if (typeof patch !== 'string' || !patch.trim()) return { state: 'skipped', reason: 'the remote run returned no patch' };
    if (autoPrDisabled(this.tools.env)) return { state: 'skipped', reason: 'AGENT_OFFICE_OPORA_AUTO_PR is off' };
    const digest = createHash('sha256').update(patch).digest('hex');
    const prior = this.ledger(id);
    if (prior?.digest === digest && prior.outcome.state !== 'failed') return prior.outcome;
    const say = (reason: string, level: 'info' | 'warn' = 'warn'): IsolatedPrOutcome => {
      notify(`🛰️ No pull request for isolated Opora execution ${id}: ${reason}`, level);
      const outcome: IsolatedPrOutcome = { state: 'skipped', reason };
      this.remember(id, digest, outcome);
      return outcome;
    };
    if (patch.length > MAX_PATCH || patch.includes('\0')) return say('its patch is too large or not text');
    const { git } = this.tools;
    const origin = normalizeRepo((await git(['remote', 'get-url', 'origin'], this.repo).catch(() => '')).trim());
    if (!origin || origin.toLowerCase() !== (normalizeRepo(intent.repository.url) ?? '').toLowerCase()) return say("the floor's origin isn't the run's repository");
    const pinned = intent.repository.commitSha;
    try { await git(['cat-file', '-e', `${pinned}^{commit}`], this.repo); } catch {
      await git(['fetch', '--no-tags', '--quiet', 'origin', pinned], this.repo).catch(() => '');
    }

    const mbox = this.file(id, 'isolated.patch');
    mkdirSync(path.dirname(mbox), { recursive: true, mode: 0o700 });
    writeFileSync(mbox, asMailbox(patch, `Opora card ${lease.nodeId}: ${String(result.summary).split('\n')[0]}`, pendingResult.report.processedAt), { mode: 0o600 });
    // The handoff opens the PR from a stored result, as for a card worker; the patch itself stays out of the body.
    writeFileSync(this.file(id, 'reported.json'), JSON.stringify({ receiptId: resultReceipt.receiptId ?? null, result }, null, 2), { mode: 0o600 });

    let tree: Awaited<ReturnType<typeof throwaway>> | undefined;
    let keep = false;
    try {
      tree = await throwaway(git, this.repo, path.join(this.directory, 'trees'), id, pinned);
      try { await git([...IDENTITY, 'am', '--committer-date-is-author-date', '--keep-cr', mbox], tree.dir); } catch (error) {
        await git(['am', '--abort'], tree.dir).catch(() => '');
        return say(`its patch doesn't apply to the pinned commit ${pinned.slice(0, 12)} (${(error as Error).message.slice(0, 200)})`);
      }
      const outcome = await this.handoff.handOff({ lease, dir: tree.dir, baseCommit: pinned }, notify) ?? { state: 'skipped' as const, reason: 'no stored result' };
      this.remember(id, digest, outcome);
      if ((outcome.state === 'opened' || outcome.state === 'reused') && this.selfChecks) {
        // The evidence runs in the same throwaway tree, after the lease is let go; the tree goes when it's done.
        keep = true;
        const dir = tree.dir, cleanup = tree.cleanup;
        void this.selfChecks.report({ project: lease.project, workspace: lease.workspace, executionId: id, headSha: outcome.headSha, dir })
          .catch(() => undefined).finally(() => void cleanup());
      }
      return outcome;
    } finally {
      if (!keep) await tree?.cleanup();
      rmSync(mbox, { force: true });
    }
  }
}

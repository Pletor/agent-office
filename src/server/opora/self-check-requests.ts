import { existsSync } from 'node:fs';
import path from 'node:path';
import { throwaway, type UpkeepTools } from './upkeep-tools.js';
import { executionScope, type HeadCheckout, type SelfCheckReporter, type SelfCheckScope } from './self-checks.js';

/**
 * Self-checks Canvas asks for (agent-state `review.self_checks` ready, Canvas's docs/oporahub-review-jobs.md):
 * a pull request of this floor's execution waits on `self_checks_missing` for a head the office has no
 * evidence on record for, e.g. because Canvas had automated review off when the office posted it. The
 * office runs the checks again, for real, in a throwaway worktree at that head, and posts what came out.
 * Only for executions this floor claimed (their bundle in `opora-executions/`); never someone else's.
 */

type Git = UpkeepTools['git'];

/** A detached worktree at `headSha` under `root`, fetching the commit from origin when the repository lacks it. */
export function headCheckout(git: Git, repo: string, root: string, executionId: string, headSha: string): HeadCheckout {
  return async () => {
    const has = () => git(['cat-file', '-e', `${headSha}^{commit}`], repo).then(() => true, () => false);
    if (!(await has())) await git(['fetch', '--no-tags', '--quiet', 'origin', headSha], repo).catch(() => '');
    if (!(await has())) throw new Error(`commit ${headSha.slice(0, 12)} isn't reachable from origin`);
    return throwaway(git, repo, root, `sc-${executionId.slice(0, 12)}`, headSha);
  };
}

/** Runs the requested heads' checks one after another (the reporter queues them); a failure costs only that head. */
export function runRequestedSelfChecks(reporter: SelfCheckReporter, git: Git, repo: string, dataDir: string, scope: SelfCheckScope,
  requests: { executionId: string; headSha: string }[]) {
  const root = path.join(dataDir, 'opora-self-checks');
  for (const { executionId, headSha } of requests) {
    const ours = executionScope(dataDir, executionId);
    if (!ours || ours.project !== scope.project || ours.workspace !== scope.workspace) continue;
    if (!existsSync(repo)) return;
    void reporter.requested({ ...scope, executionId, headSha }, headCheckout(git, repo, root, executionId, headSha)).catch(() => undefined);
  }
}

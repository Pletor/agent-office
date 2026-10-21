import type { UpkeepConfig } from './upkeep-config.js';
import { executionOf, isAncestor, throwaway, type Say, type UpkeepLedger, type UpkeepTools } from './upkeep-tools.js';

/**
 * The post-merge guard: post-merge testing as the safety net, instead of a merge lock. It watches the
 * check runs on the base branch's head through `gh api`. When the head goes red it bisects the
 * first-parent commits since the last green one, deterministically: each probe uses the check runs
 * GitHub already has for that commit and, only where there are none, runs the configured check
 * command locally in a throwaway worktree (a few per bisect). When the first bad commit is an Opora
 * merge it opens one revert pull request for it (`git revert`, `-m 1` for a merge commit) carrying
 * `Opora-Revert-Of` and `Opora-Execution` trailers and the evidence. It never merges, and each bad
 * commit gets one revert PR however often the guard passes.
 */

export type CiState = 'green' | 'red' | 'pending' | 'none';
export interface Probe { sha: string; state: CiState; source: 'ci' | 'local' | 'none'; failing: string[] }
export type GuardOutcome =
  | { state: 'green' | 'pending' | 'none' | 'handled'; head: string }
  | { state: 'inconclusive' | 'not-opora'; head: string; reason: string; culprit?: string }
  | { state: 'reverted' | 'reused' | 'revert-failed'; head: string; culprit: string; url?: string; reason?: string };
interface CheckRun { name?: string; status?: string; conclusion?: string | null }
interface OporaMerge { execution?: string; pr?: { number: number; url: string } }

const BAD = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const NEUTRAL = new Set(['success', 'neutral', 'skipped', 'cancelled', 'stale']);

/** One state for a commit's check runs: red if any failed, green if all finished well, else pending. */
export function ciState(runs: CheckRun[]): { state: CiState; failing: string[] } {
  if (!runs.length) return { state: 'none', failing: [] };
  const failing = runs.filter((r) => r.status === 'completed' && BAD.has(String(r.conclusion))).map((r) => String(r.name ?? 'check'));
  if (failing.length) return { state: 'red', failing };
  if (runs.every((r) => r.status === 'completed' && NEUTRAL.has(String(r.conclusion)))) return { state: 'green', failing: [] };
  return { state: 'pending', failing: [] };
}

/** First bad index in `commits`, which come after a good one and end in a bad one, by binary search. */
export async function bisect(commits: string[], probe: (sha: string) => Promise<CiState | undefined>): Promise<{ index: number } | { unknown: string }> {
  let good = -1, bad = commits.length - 1;
  while (bad - good > 1) {
    const mid = (good + bad) >> 1;
    const state = await probe(commits[mid]!);
    if (state === 'red') bad = mid;
    else if (state === 'green') good = mid;
    else return { unknown: commits[mid]! };
  }
  return { index: bad };
}

export class MergeGuard {
  constructor(private config: UpkeepConfig, private tools: UpkeepTools, private ledger: UpkeepLedger, private say: Say) {}

  async pass(repository: string, repo: string, treeRoot: string): Promise<GuardOutcome> {
    const { git } = this.tools;
    const branch = this.config.guardBranch;
    const ref = 'refs/opora-upkeep/guard/base';
    await git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${branch}:${ref}`], repo);
    const head = (await git(['rev-parse', ref], repo)).trim();
    const now = await this.ci(repository, repo, head);
    if (now.state === 'green') {
      if (this.ledger.lastGreen !== head || this.ledger.handledRed) { this.ledger.lastGreen = head; this.ledger.handledRed = undefined; }
      return { state: 'green', head };
    }
    if (now.state !== 'red') return { state: now.state, head };
    if (this.ledger.handledRed === head) return { state: 'handled', head };

    const probes = new Map<string, Probe>([[head, now]]);
    const outcome = await this.investigate(repository, repo, treeRoot, head, probes);
    this.ledger.handledRed = head;
    return outcome;
  }

  private async investigate(repository: string, repo: string, treeRoot: string, head: string, probes: Map<string, Probe>): Promise<GuardOutcome> {
    const { git } = this.tools;
    const branch = this.config.guardBranch;
    let lastGreen = this.ledger.lastGreen && this.ledger.lastGreen !== head && await isAncestor(git, repo, this.ledger.lastGreen, head) ? this.ledger.lastGreen : undefined;
    if (!lastGreen) {
      const back = (await git(['rev-list', '--first-parent', `--max-count=${this.config.depth}`, head], repo)).split('\n').map((s) => s.trim()).filter(Boolean).slice(1);
      for (const sha of back) {
        const p = await this.ci(repository, repo, sha);
        probes.set(sha, p);
        if (p.state === 'green') { lastGreen = sha; break; }
      }
    }
    if (!lastGreen) return this.give(head, 'inconclusive', `${branch} is red and no green commit is within ${this.config.depth} first-parent commits`);
    const commits = (await git(['rev-list', '--first-parent', '--reverse', `${lastGreen}..${head}`], repo)).split('\n').map((s) => s.trim()).filter(Boolean);
    if (!commits.length || commits.length > this.config.depth) return this.give(head, 'inconclusive', `${commits.length} commits since the last green one is outside what the guard bisects`);

    let localRuns = 0;
    const found = await bisect(commits, async (sha) => {
      let p = probes.get(sha) ?? await this.ci(repository, repo, sha);
      if ((p.state === 'pending' || p.state === 'none') && this.config.checkCommand && localRuns < this.config.localRunsPerBisect) {
        localRuns++;
        p = await this.local(repo, treeRoot, sha);
      }
      probes.set(sha, p);
      return p.state === 'green' || p.state === 'red' ? p.state : undefined;
    });
    if ('unknown' in found) return this.give(head, 'inconclusive', `no check result for ${found.unknown.slice(0, 12)} and no local check run left to get one`);
    const culprit = commits[found.index]!;
    const opora = await this.oporaMerge(repository, repo, culprit);
    if (!opora) return this.give(head, 'not-opora', `the first bad commit ${culprit.slice(0, 12)} isn't an Opora merge: no revert`, culprit);
    const evidence = { head, lastGreen, commits, probes, culprit };
    return this.revert(repository, repo, treeRoot, opora, evidence);
  }

  private give(head: string, state: 'inconclusive' | 'not-opora', reason: string, culprit?: string): GuardOutcome {
    this.say(`🛡️ Post-merge guard: ${reason}`, 'warn');
    return { state, head, reason, ...(culprit ? { culprit } : {}) };
  }

  private async ci(repository: string, repo: string, sha: string): Promise<Probe> {
    try {
      const out = await this.tools.gh(['api', `repos/${repository}/commits/${sha}/check-runs?per_page=100`], repo);
      const { state, failing } = ciState((JSON.parse(out || '{}') as { check_runs?: CheckRun[] }).check_runs ?? []);
      return { sha, state, source: state === 'none' ? 'none' : 'ci', failing };
    } catch { return { sha, state: 'none', source: 'none', failing: [] }; }
  }

  private async local(repo: string, treeRoot: string, sha: string): Promise<Probe> {
    const tree = await throwaway(this.tools.git, repo, treeRoot, `bisect-${sha.slice(0, 12)}`, sha);
    try {
      const result = await this.tools.check(this.config.checkCommand!, tree.dir);
      return { sha, state: result.ok ? 'green' : 'red', source: 'local', failing: result.ok ? [] : [this.config.checkCommand!] };
    } finally { await tree.cleanup(); }
  }

  /** Whether `sha` is an Opora merge: an `Opora-Execution` trailer in its message, or a PR from an `opora/` branch or with the trailer. */
  private async oporaMerge(repository: string, repo: string, sha: string): Promise<OporaMerge | undefined> {
    const message = await this.tools.git(['log', '-1', '--format=%B', sha], repo).catch(() => '');
    let execution = executionOf(message);
    let pr: OporaMerge['pr'];
    try {
      const pulls = JSON.parse((await this.tools.gh(['api', `repos/${repository}/commits/${sha}/pulls`], repo)) || '[]') as { number: number; html_url: string; body?: string; head?: { ref?: string } }[];
      const hit = pulls.find((p) => p.head?.ref?.startsWith('opora/') || executionOf(p.body));
      if (hit) {
        pr = { number: hit.number, url: hit.html_url };
        execution ??= executionOf(hit.body) ?? hit.head?.ref?.split('/').pop();
      }
    } catch { /* no PR lookup: the trailer alone decides */ }
    return execution || pr ? { execution, pr } : undefined;
  }

  private async revert(repository: string, repo: string, treeRoot: string, opora: OporaMerge,
    ev: { head: string; lastGreen: string; commits: string[]; probes: Map<string, Probe>; culprit: string }): Promise<GuardOutcome> {
    const { git, gh } = this.tools;
    const { culprit, head } = ev;
    const done = this.ledger.revert(culprit);
    if (done && done.state !== 'failed') return { state: 'reused', head, culprit, url: done.url };
    const branch = `opora-revert/${culprit.slice(0, 12)}`;
    const listed = JSON.parse((await gh(['pr', 'list', '--repo', repository, '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,url'], repo)) || '[]') as { url: string }[];
    if (listed[0]) {
      this.ledger.setRevert(culprit, { state: 'reused', url: listed[0].url });
      return { state: 'reused', head, culprit, url: listed[0].url };
    }
    const execution = opora.execution ?? 'unknown';
    const tree = await throwaway(git, repo, treeRoot, `revert-${culprit.slice(0, 12)}`, head);
    try {
      const parents = (await git(['rev-list', '--parents', '-n', '1', culprit], repo)).trim().split(/\s+/).length - 1;
      const subject = (await git(['log', '-1', '--format=%s', culprit], repo)).trim();
      try {
        await git(['revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), culprit], tree.dir);
      } catch (error) {
        await git(['revert', '--abort'], tree.dir).catch(() => '');
        const reason = `git revert of ${culprit.slice(0, 12)} conflicts with later commits: ${(error as Error).message}`;
        this.ledger.setRevert(culprit, { state: 'failed', reason });
        this.say(`🛡️ Post-merge guard found ${culprit.slice(0, 12)} broke ${this.config.guardBranch} but couldn't revert it: ${reason}`, 'warn');
        return { state: 'revert-failed', head, culprit, reason };
      }
      const trailers = `Opora-Revert-Of: ${culprit}\nOpora-Execution: ${execution}`;
      await git(['commit', '--amend', '-m', `Revert "${subject}"\n\nThis reverts commit ${culprit}, the first bad commit on ${this.config.guardBranch} found by the Opora post-merge guard.\n\n${trailers}`], tree.dir);
      await git(['push', '--force', 'origin', `HEAD:refs/heads/${branch}`], tree.dir);
      const out = await gh(['pr', 'create', '--repo', repository, '--base', this.config.guardBranch, '--head', branch,
        '--title', `Revert "${subject}"`.slice(0, 240), '--body', this.body(opora, ev, trailers)], repo);
      const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(out)?.[0];
      this.ledger.setRevert(culprit, { state: 'opened', url });
      this.say(`🛡️ ${this.config.guardBranch} went red: the first bad merge is ${culprit.slice(0, 12)}${opora.pr ? ` (#${opora.pr.number})` : ''}; opened revert ${url ?? branch} (not merged)`, 'warn');
      return { state: 'reverted', head, culprit, url };
    } finally { await tree.cleanup(); }
  }

  private body(opora: OporaMerge, ev: { head: string; lastGreen: string; commits: string[]; probes: Map<string, Probe>; culprit: string }, trailers: string): string {
    const row = (sha: string) => {
      const p = ev.probes.get(sha);
      const mark = sha === ev.culprit ? ' ← first bad' : '';
      return `| \`${sha.slice(0, 12)}\` | ${p ? `${p.state}${p.failing.length ? ` (${p.failing.slice(0, 4).join(', ')})` : ''}` : 'not probed'} | ${p?.source ?? '–'} |${mark ? ` ${mark}` : ''}`;
    };
    return [
      '## Why',
      '',
      `\`${this.config.guardBranch}\` went red at \`${ev.head.slice(0, 12)}\`. The Opora post-merge guard bisected the ${ev.commits.length} first-parent commit${ev.commits.length === 1 ? '' : 's'} since the last green one (\`${ev.lastGreen.slice(0, 12)}\`) and the first bad one is \`${ev.culprit}\`${opora.pr ? `, merged from ${opora.pr.url}` : ''}.`,
      '',
      '## Evidence',
      '',
      '| Commit | Checks | Source |',
      '| --- | --- | --- |',
      row(ev.lastGreen),
      ...ev.commits.map(row),
      '',
      '`ci` is GitHub\'s check runs on that commit; `local` is the configured check command run in a throwaway worktree.',
      '',
      '## What to do',
      '',
      'Review and merge this revert to turn the branch green again, or close it if the failure is a flake or fixed otherwise. Agent Office never merges it.',
      '',
      trailers,
    ].join('\n');
  }
}

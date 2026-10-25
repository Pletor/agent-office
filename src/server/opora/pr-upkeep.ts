import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolvePrompt } from './conflict-resolver.js';
import { HourlyBudget, type UpkeepConfig } from './upkeep-config.js';
import { executionOf, isAncestor, throwaway, type Say, type UpkeepLedger, type UpkeepTools } from './upkeep-tools.js';
import { NEEDS_HUMAN, NOTICE_START, withdrawNotice } from './upkeep-notice.js';

export { NEEDS_HUMAN };

/**
 * PR upkeep: keeps the office's own open pull requests (branch `opora/…` or an `Opora-Execution`
 * trailer in the body) on top of their base, with no global merge lock. For each one behind its base
 * or conflicting it rebases deterministically in a throwaway worktree; a textual conflict goes to a
 * fresh headless Claude (conflict-resolver.ts) restricted to that worktree. Either way the configured
 * check command has to pass before anything is pushed (`--force-with-lease` against the head it
 * read). What can't be fixed gets a comment with the conflict summary and the `opora-needs-human`
 * label, only once the check failed twice and the head is still the one it read (another pass or
 * office may have moved it meanwhile); a later pass that finds the PR up to date, or brings it there,
 * takes that notice back (upkeep-notice.ts). It never merges, and it tries a head commit at most
 * `attemptsPerHead` times.
 */

export interface OporaPr {
  number: number; url: string; title?: string; body?: string;
  headRefName: string; baseRefName: string; headRefOid: string;
  isCrossRepository?: boolean; mergeable?: string; mergeStateStatus?: string; labels?: { name?: string }[];
}
/** `cleared`: this pass took back an earlier "needs a human" notice on the PR (upkeep-notice.ts). */
export type UpkeepOutcome = { number: number; state: 'current' | 'rebased' | 'resolved' | 'human' | 'skipped' | 'failed'; reason?: string; cleared?: true };
type Rebased = { ok: true; resolved: string[] } | { ok: false; reason: string; conflicts: string[]; later?: boolean };

const PR_FIELDS = 'number,url,title,body,headRefName,baseRefName,headRefOid,isCrossRepository,mergeable,mergeStateStatus,labels';
/** Conflicted commits one rebase may hand to the resolver before it gives up. */
const MAX_ROUNDS = 6;
const MARKER = /^(?:<{7}|>{7})(?: |$)/m;

export function isOporaPr(pr: Pick<OporaPr, 'headRefName' | 'body'>): boolean {
  return pr.headRefName.startsWith('opora/') || !!executionOf(pr.body);
}

export class PrUpkeep {
  private budget: HourlyBudget;
  constructor(private config: UpkeepConfig, private tools: UpkeepTools, private ledger: UpkeepLedger,
    private say: Say, now: () => number = Date.now) {
    this.budget = new HourlyBudget(config.resolvesPerHour, now);
  }

  /** One pass over the repository's open Opora pull requests. */
  async pass(repository: string, repo: string, treeRoot: string): Promise<UpkeepOutcome[]> {
    const listed = JSON.parse((await this.tools.gh(['pr', 'list', '--repo', repository, '--state', 'open', '--limit', '100', '--json', PR_FIELDS], repo)) || '[]') as OporaPr[];
    const outcomes: UpkeepOutcome[] = [];
    let worked = 0;
    for (const pr of listed) {
      if (!isOporaPr(pr) || pr.isCrossRepository) continue;
      if (worked >= this.config.perPass) break;
      const outcome = await this.maintain(repository, repo, treeRoot, pr);
      if (outcome.state !== 'current' && outcome.state !== 'skipped') worked++;
      outcomes.push(outcome);
    }
    this.ledger.save();
    return outcomes;
  }

  async maintain(repository: string, repo: string, treeRoot: string, pr: OporaPr): Promise<UpkeepOutcome> {
    const { git } = this.tools;
    const n = pr.number;
    const refs = { base: `refs/opora-upkeep/pr-${n}/base`, head: `refs/opora-upkeep/pr-${n}/head` };
    await git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${pr.baseRefName}:${refs.base}`, `+refs/heads/${pr.headRefName}:${refs.head}`], repo);
    const baseSha = (await git(['rev-parse', refs.base], repo)).trim();
    const headSha = (await git(['rev-parse', refs.head], repo)).trim();
    if (headSha !== pr.headRefOid) return { number: n, state: 'skipped', reason: 'its head moved while reading it' };
    // A notice raised on an earlier head (here, or by another office: the label says so) is moot once the PR is current.
    const noticed = !!pr.labels?.some((l) => l.name === NEEDS_HUMAN) || (!!this.ledger.peek(n)?.human && this.ledger.peek(n)?.head !== headSha);
    if (await isAncestor(git, repo, baseSha, headSha)) return this.cleared(repository, repo, n, headSha, noticed, { number: n, state: 'current' });
    const entry = this.ledger.pr(n, headSha);
    if (entry.human) return { number: n, state: 'skipped', reason: 'waiting for a human' };
    if (entry.attempts >= this.config.attemptsPerHead) return { number: n, state: 'skipped', reason: 'out of attempts for this head' };
    if (!this.config.checkCommand) return { number: n, state: 'skipped', reason: 'no check command is configured' };
    entry.attempts++;
    this.ledger.save();

    let tree: Awaited<ReturnType<typeof throwaway>> | undefined;
    try {
      tree = await throwaway(git, repo, treeRoot, `pr-${n}`, headSha);
      const rebased = await this.rebase(tree.dir, baseSha, pr);
      if (!rebased.ok) {
        if (rebased.later) { entry.attempts--; this.ledger.save(); return { number: n, state: 'skipped', reason: rebased.reason }; }
        return await this.human(repository, repo, pr, headSha, rebased.reason, rebased.conflicts);
      }
      let check = await this.tools.check(this.config.checkCommand, tree.dir);
      // A red check runs once more before anyone is called: one that fails for the machine's reasons passes then.
      if (!check.ok) check = await this.tools.check(this.config.checkCommand, tree.dir);
      if (!check.ok) {
        if (await this.moved(repo, pr, headSha)) return { number: n, state: 'skipped', reason: 'its head moved while upkeep checked it' };
        return await this.human(repository, repo, pr, headSha, `\`${this.config.checkCommand}\` failed twice after the rebase`, rebased.resolved, check.output);
      }
      await git(['push', `--force-with-lease=refs/heads/${pr.headRefName}:${headSha}`, 'origin', `HEAD:refs/heads/${pr.headRefName}`], tree.dir);
      const newHead = (await git(['rev-parse', 'HEAD'], tree.dir)).trim();
      this.ledger.pr(n, newHead);
      this.ledger.save();
      await this.tools.pushed?.(pr, newHead, tree.dir).catch(() => undefined);
      if (rebased.resolved.length) {
        await this.comment(repository, repo, n, [
          `🛰️ Agent Office rebased this pull request onto \`${pr.baseRefName}\` (${baseSha.slice(0, 12)}). Claude resolved textual conflicts in:`,
          '', ...rebased.resolved.map((f) => `- \`${f}\``), '', `\`${this.config.checkCommand}\` passed before the push. Please review the resolution.`,
        ].join('\n'));
        this.say(`🛰️ Rebased ${repository}#${n} onto ${pr.baseRefName}; Claude resolved ${rebased.resolved.length} conflicted file${rebased.resolved.length === 1 ? '' : 's'} and the checks passed`, 'info');
        return this.cleared(repository, repo, n, newHead, noticed, { number: n, state: 'resolved' });
      }
      this.say(`🛰️ Rebased ${repository}#${n} onto ${pr.baseRefName}; the checks passed`, 'info');
      return this.cleared(repository, repo, n, newHead, noticed, { number: n, state: 'rebased' });
    } catch (error) {
      const reason = (error as Error).message;
      // Someone else pushed meanwhile (another pass, another office keeping this repository): theirs stands, nothing for a human.
      if (await this.moved(repo, pr, headSha)) return { number: n, state: 'skipped', reason: 'its head moved while upkeep worked on it' };
      if (entry.attempts >= this.config.attemptsPerHead) return await this.human(repository, repo, pr, headSha, `upkeep failed: ${reason}`, []);
      this.say(`🛰️ Upkeep of ${repository}#${n} failed (attempt ${entry.attempts}/${this.config.attemptsPerHead}): ${reason}`, 'warn');
      return { number: n, state: 'failed', reason };
    } finally {
      await tree?.cleanup();
    }
  }

  /** Rebases the worktree's HEAD onto `baseSha`, handing each conflicted step to the resolver. */
  private async rebase(dir: string, baseSha: string, pr: OporaPr): Promise<Rebased> {
    const { git } = this.tools;
    const abort = () => git(['rebase', '--abort'], dir).catch(() => '');
    try {
      await git(['rebase', baseSha], dir);
      return { ok: true, resolved: [] };
    } catch (error) {
      let conflicts = await this.unmerged(dir);
      if (!conflicts.length) { await abort(); return { ok: false, reason: `git rebase failed: ${(error as Error).message}`, conflicts: [] }; }
      const all = new Set<string>();
      for (let round = 0; conflicts.length; round++) {
        conflicts.forEach((f) => all.add(f));
        const stop = async (reason: string, later = false): Promise<Rebased> => { await abort(); return { ok: false, reason, conflicts: [...all], later }; };
        if (round >= MAX_ROUNDS) return stop(`more than ${MAX_ROUNDS} commits conflicted`);
        if (!this.config.resolve) return stop('textual conflict and the LLM fallback is off (AGENT_OFFICE_OPORA_RESOLVE)');
        if (!this.budget.available()) return stop('textual conflict; no resolver run left this hour, trying again later', true);
        this.budget.started();
        try {
          await this.tools.resolve({ cwd: dir, prompt: resolvePrompt(pr, baseSha, conflicts) });
        } catch (e) { return stop(`textual conflict the resolver couldn't fix: ${(e as Error).message}`); }
        const left = conflicts.filter((f) => this.hasMarkers(dir, f));
        if (left.length) return stop(`conflict markers left in ${left.join(', ')}`);
        await git(['add', '--', ...conflicts], dir);
        try {
          await git(['-c', 'core.editor=true', 'rebase', '--continue'], dir);
          conflicts = [];
        } catch (e) {
          conflicts = await this.unmerged(dir);
          if (!conflicts.length) return stop(`git rebase --continue failed: ${(e as Error).message}`);
        }
      }
      return { ok: true, resolved: [...all] };
    }
  }

  private async unmerged(dir: string): Promise<string[]> {
    const out = await this.tools.git(['diff', '--name-only', '--diff-filter=U'], dir).catch(() => '');
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  private hasMarkers(dir: string, file: string): boolean {
    try { return MARKER.test(readFileSync(path.join(dir, file), 'utf8')); } catch { return false; }
  }

  /** Whether the PR's branch on GitHub is no longer at `headSha` (unknown counts as not moved). */
  private async moved(repo: string, pr: OporaPr, headSha: string): Promise<boolean> {
    const out = await this.tools.git(['ls-remote', 'origin', `refs/heads/${pr.headRefName}`], repo).catch(() => '');
    const sha = out.trim().split(/\s+/)[0];
    return /^[0-9a-f]{40}$/.test(sha ?? '') && sha !== headSha;
  }

  /** `outcome`, after taking back an earlier "needs a human" notice when there was one (upkeep-notice.ts). */
  private async cleared(repository: string, repo: string, n: number, head: string, noticed: boolean, outcome: UpkeepOutcome): Promise<UpkeepOutcome> {
    if (!noticed) return outcome;
    const prior = this.ledger.peek(n);
    if (prior?.human) { prior.human = false; this.ledger.save(); }
    await withdrawNotice(this.tools.gh, repository, repo, n, head);
    this.say(`🛰️ ${repository}#${n} no longer needs a human: it's up to date with its base, so upkeep took its notice back`, 'info');
    return { ...outcome, cleared: true };
  }

  /** Leaves the PR to a person: a comment with what went wrong, the label, and no more tries on this head. */
  private async human(repository: string, repo: string, pr: OporaPr, headSha: string, reason: string, files: string[], output?: string): Promise<UpkeepOutcome> {
    const entry = this.ledger.pr(pr.number, headSha);
    entry.human = true;
    this.ledger.save();
    await this.comment(repository, repo, pr.number, [
      `${NOTICE_START} with \`${pr.baseRefName}\`: ${reason}.`,
      ...(files.length ? ['', 'Conflicted files:', ...files.map((f) => `- \`${f}\``)] : []),
      ...(output ? ['', '<details><summary>Check output (tail)</summary>', '', '```', output.slice(-2000), '```', '</details>'] : []),
      '', `It needs a human: rebase it by hand. Upkeep tries again once its head changes. Head: ${headSha.slice(0, 12)}.`,
    ].join('\n'));
    await this.tools.gh(['pr', 'edit', String(pr.number), '--repo', repository, '--add-label', NEEDS_HUMAN], repo).catch(() => '');
    this.say(`🛰️ ${repository}#${pr.number} needs a human: ${reason}`, 'warn');
    return { number: pr.number, state: 'human', reason };
  }

  private async comment(repository: string, repo: string, number: number, body: string) {
    await this.tools.gh(['pr', 'comment', String(number), '--repo', repository, '--body', body], repo).catch((e) => this.say(`🛰️ Couldn't comment on ${repository}#${number}: ${(e as Error).message}`, 'warn'));
  }
}

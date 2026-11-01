import { fixCommitMessage, fixPrompt } from './finding-fixer.js';
import type { OporaPr, UpkeepOutcome } from './pr-upkeep.js';
import type { KnownFinding, ReviewListing } from './review-client.js';
import type { HourlyBudget, UpkeepConfig } from './upkeep-config.js';
import { NEEDS_HUMAN } from './upkeep-notice.js';
import { throwaway, type Say, type UpkeepLedger, type UpkeepTools } from './upkeep-tools.js';

/**
 * PR upkeep's second step: a pull request that is up to date with its base, but carries confirmed
 * `important` review findings still `open` (they block Canvas's merge gate, `open_important_findings`),
 * gets one fix attempt per head. Only once Canvas finished reviewing that very head: a head still
 * under review may already have them fixed. A fresh headless Claude (finding-fixer.ts) edits a
 * throwaway worktree at the head, the office commits (`fix(review): …`, an `Opora-Finding:` trailer
 * per finding), the check command has to pass, and the push is a fast-forward leased on the head it
 * read. The new head then gets Canvas's next review round, which says whether the findings are fixed.
 * One set of findings gets `attemptsPerHead` attempts in all (a push whose next round still finds
 * them open counts as one); after that the PR is left to a person: a comment and `opora-needs-human`,
 * kept while those findings stay open. It shares the conflict resolver's hourly budget and never merges.
 */

type PrFinding = KnownFinding & { repository?: string; number?: number };
/** Whether Canvas finished reviewing the head, and its open important findings when it did. */
export type HeadReview = { ready: false } | { ready: true; findings: KnownFinding[] };

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DONE = new Set(['completed', 'not_required']);
const WAITING = 'waiting for a human: open review findings';

/** The PR's open important findings, once every review job of `headSha` is done and its code review completed. */
export function reviewAtHead(listing: ReviewListing, repository: string, number: number, headSha: string): HeadReview {
  const same = (r: string | undefined, n: number | undefined) => (r ?? '').toLowerCase() === repository.toLowerCase() && n === number;
  const jobs = listing.jobs.filter((j) => same(j.repository, j.number) && j.headSha === headSha);
  const code = jobs.some((j) => (j.kind ?? 'code') === 'code' && j.phase === 'completed');
  if (!listing.enabled || !code || !jobs.every((j) => DONE.has(j.phase))) return { ready: false };
  const findings = (listing.findings as PrFinding[])
    .filter((f) => same(f.repository, f.number) && f.severity === 'important' && f.status === 'open' && ID.test(f.findingId))
    .sort((a, b) => a.findingId.localeCompare(b.findingId));
  return { ready: true, findings };
}

/** What the fix borrows from PR upkeep (pr-upkeep.ts). */
export interface FixHost {
  cleared(repository: string, repo: string, n: number, head: string, noticed: boolean, outcome: UpkeepOutcome): Promise<UpkeepOutcome>;
  moved(repo: string, pr: OporaPr, headSha: string): Promise<boolean>;
  comment(repository: string, repo: string, n: number, body: string): Promise<void>;
}

export class FindingFixes {
  constructor(private config: UpkeepConfig, private tools: UpkeepTools, private ledger: UpkeepLedger,
    private say: Say, private budget: HourlyBudget, private host: FixHost) {}

  /** The outcome for a current PR when its findings are this step's business; undefined: it's simply current. */
  async maintain(repository: string, repo: string, treeRoot: string, pr: OporaPr, headSha: string, noticed: boolean): Promise<UpkeepOutcome | undefined> {
    const { fix, reviews, git } = this.tools;
    if (!this.config.fixFindings || !fix || !reviews) return undefined;
    const n = pr.number;
    const review = await reviews(pr).then((l) => reviewAtHead(l, repository, n, headSha), () => ({ ready: false }) as HeadReview);
    // A person was called for the findings: their notice stays until those findings are gone.
    if (!review.ready) return this.ledger.peekFix(n)?.human ? { number: n, state: 'skipped', reason: WAITING } : undefined;
    if (!review.findings.length) return undefined;
    const findings = review.findings;
    const entry = this.ledger.fix(n, findings.map((f) => f.findingId).join(','));
    if (entry.human) return { number: n, state: 'skipped', reason: WAITING };
    if (entry.heads.includes(headSha)) return undefined;
    const done = (outcome: UpkeepOutcome) => this.host.cleared(repository, repo, n, headSha, noticed, outcome);
    if (entry.attempts >= this.config.attemptsPerHead) return this.human(repository, repo, pr, headSha, findings, `${entry.attempts} fix attempts didn't clear them`);
    if (!this.config.checkCommand) return undefined;
    if (!this.budget.available()) return done({ number: n, state: 'skipped', reason: 'open review findings; no fixer run left this hour, trying again later' });
    this.budget.started();
    entry.attempts++;
    this.ledger.save();
    const later = (reason: string) => { entry.attempts--; this.ledger.save(); return { number: n, state: 'skipped', reason } as UpkeepOutcome; };
    const failed = async (reason: string, output?: string) => {
      if (entry.attempts >= this.config.attemptsPerHead) return this.human(repository, repo, pr, headSha, findings, reason, output);
      this.say(`🛰️ Fixing review findings on ${repository}#${n} failed (attempt ${entry.attempts}/${this.config.attemptsPerHead}): ${reason}`, 'warn');
      return done({ number: n, state: 'failed', reason });
    };

    let tree: Awaited<ReturnType<typeof throwaway>> | undefined;
    try {
      tree = await throwaway(git, repo, treeRoot, `pr-${n}-fix`, headSha);
      try {
        await fix({ cwd: tree.dir, prompt: fixPrompt(pr, headSha, findings) });
      } catch (e) { return await failed(`the fixer couldn't fix them: ${(e as Error).message}`); }
      if (!(await git(['status', '--porcelain'], tree.dir)).trim()) return await failed('the fixer changed nothing');
      await git(['add', '-A'], tree.dir);
      await git(['commit', '-q', '-m', fixCommitMessage(findings)], tree.dir);
      let check = await this.tools.check(this.config.checkCommand, tree.dir);
      if (!check.ok) check = await this.tools.check(this.config.checkCommand, tree.dir);
      if (!check.ok) {
        if (await this.host.moved(repo, pr, headSha)) return later('its head moved while upkeep checked the fix');
        return await failed(`\`${this.config.checkCommand}\` failed twice after the fix`, check.output);
      }
      await git(['push', `--force-with-lease=refs/heads/${pr.headRefName}:${headSha}`, 'origin', `HEAD:refs/heads/${pr.headRefName}`], tree.dir);
      const newHead = (await git(['rev-parse', 'HEAD'], tree.dir)).trim();
      entry.heads.push(headSha);
      this.ledger.save();
      await this.tools.pushed?.(pr, newHead, tree.dir).catch(() => undefined);
      await this.host.comment(repository, repo, n, [
        `🛰️ Agent Office pushed a fix (${newHead.slice(0, 12)}) for ${findings.length === 1 ? 'this open review finding' : `these ${findings.length} open review findings`}:`,
        '', ...findings.map(line), '',
        `\`${this.config.checkCommand}\` passed before the push. Opora's next review round on the new head says whether ${findings.length === 1 ? 'it is' : 'they are'} fixed.`,
      ].join('\n'));
      this.say(`🛰️ Pushed a fix for ${findings.length} open review finding${findings.length === 1 ? '' : 's'} on ${repository}#${n}; the checks passed`, 'info');
      return await done({ number: n, state: 'fixed' });
    } catch (error) {
      if (await this.host.moved(repo, pr, headSha)) return later('its head moved while upkeep fixed it');
      return await failed(`upkeep failed: ${(error as Error).message}`);
    } finally {
      await tree?.cleanup();
    }
  }

  /** Leaves the findings to a person: a comment, the label, and no more fix attempts while they stay open. */
  private async human(repository: string, repo: string, pr: OporaPr, headSha: string, findings: KnownFinding[], reason: string, output?: string): Promise<UpkeepOutcome> {
    const entry = this.ledger.fix(pr.number, findings.map((f) => f.findingId).join(','));
    entry.human = true;
    this.ledger.save();
    await this.host.comment(repository, repo, pr.number, [
      `🛰️ Agent Office couldn't fix the open review findings on this pull request: ${reason}.`,
      '', ...findings.map(line),
      ...(output ? ['', '<details><summary>Check output (tail)</summary>', '', '```', output.slice(-2000), '```', '</details>'] : []),
      '', `It needs a human: fix them by hand, or settle them in Opora. Head: ${headSha.slice(0, 12)}.`,
    ].join('\n'));
    await this.tools.gh(['pr', 'edit', String(pr.number), '--repo', repository, '--add-label', NEEDS_HUMAN], repo).catch(() => '');
    this.say(`🛰️ ${repository}#${pr.number} needs a human: its open review findings: ${reason}`, 'warn');
    return { number: pr.number, state: 'human', reason };
  }
}

function line(f: KnownFinding): string {
  const where = `${f.path ?? '?'}${typeof f.line === 'number' ? `:${f.line}` : ''}`;
  return `- \`${where}\` ${(f.title ?? '').replace(/\s+/g, ' ').slice(0, 200)} (${f.findingId})`;
}

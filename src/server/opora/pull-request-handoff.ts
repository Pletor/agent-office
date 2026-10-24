import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeRepo } from '../../shared/floors.js';
import { gh } from '../github.js';
import { run } from '../workers/process.js';
import type { ExecutionLease } from './execution-client.js';
import { draftPullRequest, handoffBranch, linkRequestId } from './pull-request-body.js';
import { commitsFromLog, pinnedSteps } from './plan-steps.js';
import { PrLensAttachment, withLensSection } from './pr-lens.js';
import { DesignPreviewAttachment } from './design-preview-upload.js';

/**
 * Opora execution → pull request, without an LLM. Once a worker's result helper has stored its Canvas
 * receipt (`<executionId>-reported.json`, see execution-worker.ts), the office pushes the worktree's
 * commits to `opora/<card>/<execution>`, opens (or reuses) a pull request whose body ends with the
 * Opora trailers, and links it to the execution on Canvas with the execution's own credentials.
 * Nothing here merges or approves, and no failure here touches the stored result.
 */

/** What the handoff runs, narrow so a test can fake git, gh and Canvas. */
export interface HandoffTools {
  git(args: string[], cwd: string): Promise<string>;
  gh(args: string[], cwd: string): Promise<string>;
  transport: typeof fetch;
  env: NodeJS.ProcessEnv;
  /** Schedules the PR Lens's one retry after a 409 (pr-lens.ts); a minute later when left out. */
  later?: (run: () => void) => void;
}
export const defaultHandoffTools = (): HandoffTools => ({
  git: (args, cwd) => run('git', args, cwd, 90_000),
  gh: async (args, cwd) => (await gh(args, cwd, 60_000)).trim(),
  transport: fetch,
  env: process.env,
});

/** The execution and the worker's worktree the handoff works from. */
export interface HandoffSubject {
  lease: ExecutionLease;
  cardName?: string;
  /** The worktree folder, the commit it was cut from, and the branch its PR should target. */
  dir: string; baseCommit: string; baseBranch?: string;
}
export type LinkOutcome = 'linked' | 'not-deployed' | 'conflict' | 'failed';
export type HandoffOutcome =
  | { state: 'skipped'; reason: string }
  | { state: 'opened' | 'reused'; branch: string; headSha: string; repository: string; number: number; url: string; link: LinkOutcome }
  | { state: 'failed'; headSha?: string; reason: string };
type Notify = (message: string, level: 'info' | 'warn' | 'error') => void;

/** `AGENT_OFFICE_OPORA_AUTO_PR=off` turns the handoff off; anything else leaves it on wherever GitHub and gh are set up. */
export function autoPrDisabled(env: NodeJS.ProcessEnv): boolean {
  return /^(?:0|off|false|no)$/i.test((env.AGENT_OFFICE_OPORA_AUTO_PR ?? '').trim());
}

const HEX40 = /^[a-f0-9]{40}$/;
const PR_URL = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/;

export class PullRequestHandoff {
  private running = new Map<string, Promise<HandoffOutcome>>();
  /** Reasons already said once per execution, so a poll every 20 s doesn't repeat them. */
  private said = new Set<string>();
  constructor(private directory: string, private base: string, private agent: string,
    private tools: HandoffTools = defaultHandoffTools()) {
    this.lens = new PrLensAttachment(base, agent, tools);
    this.preview = new DesignPreviewAttachment(directory, base, agent, tools);
  }
  /** A design card's screenshots, sent to Opora as `evidence.preview` once the PR is linked (design-preview-upload.ts). */
  private preview: DesignPreviewAttachment;
  /** The worker's PR Lens diagram, summarised in the pull request as text and sent to Canvas as optional evidence (pr-lens.ts). */
  private lens: PrLensAttachment;

  private file(executionId: string, kind: 'reported' | 'pull-request') {
    return path.join(this.directory, 'opora-executions', `${executionId}-${kind}.json`);
  }

  /** The result the worker reported, once its receipt is stored; undefined before that. */
  reported(executionId: string): Record<string, unknown> | undefined {
    try {
      const saved = JSON.parse(readFileSync(this.file(executionId, 'reported'), 'utf8')) as { result?: unknown };
      return saved.result && typeof saved.result === 'object' && !Array.isArray(saved.result) ? saved.result as Record<string, unknown> : undefined;
    } catch { return undefined; }
  }

  /** Whether the worker's result helper stored Canvas's receipt for this execution (its result is in). */
  hasReceipt(executionId: string): boolean {
    try {
      const saved = JSON.parse(readFileSync(this.file(executionId, 'reported'), 'utf8')) as { receiptId?: unknown };
      return typeof saved.receiptId === 'string' && saved.receiptId.length > 0;
    } catch { return false; }
  }

  /** Hands the execution's work off once (per head commit); a second call while one runs waits for it. */
  handOff(subject: HandoffSubject, notify: Notify): Promise<HandoffOutcome> | undefined {
    const id = subject.lease.executionId;
    if (!existsSync(this.file(id, 'reported'))) return undefined;
    const busy = this.running.get(id);
    if (busy) return busy;
    const job = this.attempt(subject, notify).catch((error): HandoffOutcome => ({ state: 'failed', reason: (error as Error).message }))
      .finally(() => this.running.delete(id));
    this.running.set(id, job);
    return job;
  }

  /** Waits for a handoff under way for this execution, before its lease is let go. */
  async settled(executionId: string | undefined): Promise<void> {
    if (executionId) await this.running.get(executionId)?.catch(() => undefined);
  }

  private once(id: string, reason: string, notify: Notify, level: 'info' | 'warn' | 'error' = 'info') {
    const key = `${id}\n${reason}`;
    if (this.said.has(key)) return;
    this.said.add(key);
    notify(reason, level);
  }

  private async attempt(subject: HandoffSubject, notify: Notify): Promise<HandoffOutcome> {
    const { lease, dir } = subject;
    const id = lease.executionId;
    const skip = (reason: string): HandoffOutcome => { this.once(id, `🛰️ No pull request for Opora execution ${id}: ${reason}`, notify); return { state: 'skipped', reason }; };
    const result = this.reported(id);
    if (!result) return skip('its stored result is unreadable');
    if (autoPrDisabled(this.tools.env)) return skip('AGENT_OFFICE_OPORA_AUTO_PR is off');
    if (!existsSync(dir)) return skip(`its worktree is gone (${dir})`);
    const { git } = this.tools;
    let headSha: string, ahead: number;
    try {
      headSha = (await git(['rev-parse', 'HEAD'], dir)).trim();
      ahead = Number((await git(['rev-list', '--count', `${subject.baseCommit}..HEAD`], dir)).trim());
    } catch (error) { return skip(`git couldn't read the worktree (${(error as Error).message})`); }
    if (!HEX40.test(headSha)) return skip('git returned no head commit');
    if (!(ahead > 0)) return skip('the worker committed nothing ahead of its base');
    const done = this.done(id);
    if (done?.headSha === headSha) return done.outcome;
    let repository: string | undefined;
    try { repository = normalizeRepo((await git(['remote', 'get-url', 'origin'], dir)).trim()); } catch { /* no origin */ }
    if (!repository) return skip('the project has no GitHub remote (origin)');
    try { await this.tools.gh(['auth', 'status'], dir); } catch { return skip("gh isn't signed in to GitHub on the office's machine"); }

    const branch = handoffBranch(lease.nodeId, id);
    const outcome = await this.publish(subject, result, { repository, branch, headSha }, notify);
    this.remember(id, headSha, outcome);
    return outcome;
  }

  private async publish(subject: HandoffSubject, result: Record<string, unknown>,
    at: { repository: string; branch: string; headSha: string }, notify: Notify): Promise<HandoffOutcome> {
    const { lease, dir } = subject;
    const { repository, branch, headSha } = at;
    const id = lease.executionId;
    let pr: { number: number; url: string }, existed: boolean, open = true;
    let lens: Awaited<ReturnType<PrLensAttachment['prepare']>>;
    try {
      await this.tools.git(['push', 'origin', `HEAD:refs/heads/${branch}`], dir);
      lens = this.lens.prepare(dir, { headSha });
      const listed = JSON.parse((await this.tools.gh(['pr', 'list', '--repo', repository, '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,url,state'], dir)) || '[]') as { number: number; url: string; state?: string }[];
      existed = !!listed[0];
      if (listed[0]) { pr = { number: Number(listed[0].number), url: String(listed[0].url) }; open = String(listed[0].state ?? 'OPEN').toUpperCase() === 'OPEN'; }
      else {
        const target = subject.baseBranch && await this.onOrigin(subject.baseBranch, dir) ? subject.baseBranch : undefined;
        const steps = pinnedSteps(lease.assignment);
        // The PR's own commits per step, from their `step <id>:` messages (a legacy card has no steps and no section).
        const stepCommits = steps.length ? commitsFromLog(await this.tools.git(['log', '--reverse', '--format=%H%x1f%s', `${subject.baseCommit}..HEAD`], dir).catch(() => ''), steps) : undefined;
        const { title, body } = draftPullRequest({ executionId: id, acceptedRevision: lease.acceptedRevision, cardId: lease.nodeId, cardName: subject.cardName, result, base: target, steps, stepCommits });
        const out = await this.tools.gh(['pr', 'create', '--repo', repository, '--head', branch, ...(target ? ['--base', target] : []), '--title', title, '--body', lens ? withLensSection(body, lens.markdown) : body], dir);
        const match = PR_URL.exec(out);
        if (!match) throw new Error('gh did not return a pull request URL');
        pr = { number: Number(match[1]), url: match[0] };
      }
    } catch (error) {
      const reason = `pushing ${branch} or opening its pull request failed: ${(error as Error).message}`;
      notify(`🛰️ Opora execution ${id}: ${reason}. Its Canvas result stands; open the PR by hand.`, 'warn');
      return { state: 'failed', headSha, reason };
    }
    if (lens && existed && open) await this.lens.comment(repository, pr.number, lens, dir).catch(() => undefined);
    const link = await this.link(lease, { repository, number: pr.number, headRef: branch, headSha });
    // After the link: Canvas takes a PR lens only for the execution's open linked PR at this head (Opora #61, N1).
    if (lens) await this.lens.report(lease, { number: pr.number, headSha }, lens, notify)
      .catch((error) => notify(`🛰️ PR Lens for ${id} failed: ${(error as Error).message}`, 'warn'));
    await this.preview.report(lease, { number: pr.number, headSha }, dir, notify)
      .catch((error) => notify(`🛰️ Design preview for ${id} failed: ${(error as Error).message}`, 'warn'));
    const linked = { linked: 'linked to its Canvas execution', 'not-deployed': "Canvas can't link pull requests yet (404); its trailers let Canvas find it later", conflict: 'Canvas refused the link as a conflict (409)', failed: "Canvas didn't confirm the link" }[link];
    notify(`🛰️ ${existed ? 'Reused' : 'Opened'} ${repository}#${pr.number} for Opora execution ${id}: ${linked}`, link === 'linked' || link === 'not-deployed' ? 'info' : 'warn');
    return { state: existed ? 'reused' : 'opened', branch, headSha, repository, number: pr.number, url: pr.url, link };
  }

  private async onOrigin(branch: string, dir: string): Promise<boolean> {
    try { await this.tools.git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], dir); return true; } catch { return false; }
  }

  /** POST …/executions/{id}/pull-request with the execution's credentials. 404: not deployed yet; 409: a conflict, not retried. */
  async link(lease: ExecutionLease, pr: { repository: string; number: number; headRef: string; headSha: string }): Promise<LinkOutcome> {
    try {
      const response = await this.tools.transport(new URL(`/api/oporahub/executions/${encodeURIComponent(lease.executionId)}/pull-request`, this.base), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: new URL(this.base).origin, 'X-Opora-Actor': `agent; name=${this.agent}` },
        body: JSON.stringify({ project: lease.project, workspace: lease.workspace, token: lease.token, epoch: lease.epoch,
          requestId: linkRequestId(lease.executionId, pr.headSha), ...pr }),
      });
      if (response.ok) return 'linked';
      return response.status === 404 ? 'not-deployed' : response.status === 409 ? 'conflict' : 'failed';
    } catch { return 'failed'; }
  }

  private done(executionId: string): { headSha: string; outcome: HandoffOutcome } | undefined {
    try {
      const saved = JSON.parse(readFileSync(this.file(executionId, 'pull-request'), 'utf8')) as { headSha?: unknown; outcome?: HandoffOutcome };
      return typeof saved.headSha === 'string' && saved.outcome ? { headSha: saved.headSha, outcome: saved.outcome } : undefined;
    } catch { return undefined; }
  }

  /** What became of this head commit, so the next poll doesn't push or link it again (a new commit does). */
  private remember(executionId: string, headSha: string, outcome: HandoffOutcome) {
    try {
      mkdirSync(path.dirname(this.file(executionId, 'pull-request')), { recursive: true, mode: 0o700 });
      writeFileSync(this.file(executionId, 'pull-request'), JSON.stringify({ headSha, outcome, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
    } catch { /* a full disk only means the next poll tries again */ }
  }
}

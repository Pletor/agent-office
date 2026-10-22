// 🧹 The merge queue: open PRs to main in the order they should be squash-merged. Green ones first,
// oldest first; then the rest, those nearest to green first. Only the head of the queue, green at the
// moment it's asked, may be merged (see docs/cista-linie.md, 2.4).
import type { ChecksState, QueueFlag, QueueItem } from '../../shared/cleanline.js';
import type { Runner } from '../status/git.js';

/** One open PR as `gh pr list --json` gives it (the fields OPEN_FIELDS asks for). */
export interface OpenPr {
  number: number;
  title?: string;
  url?: string;
  author?: { login?: string } | null;
  headRefName?: string;
  baseRefName?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  mergeable?: string;
  mergeStateStatus?: string;
  createdAt?: string;
  statusCheckRollup?: { conclusion?: string | null; state?: string | null; status?: string | null }[] | null;
}

export const OPEN_FIELDS = 'number,title,url,author,headRefName,headRefOid,baseRefName,isDraft,reviewDecision,mergeable,mergeStateStatus,createdAt,statusCheckRollup';

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];

/** The PR's checks taken together: any failure fails, anything unfinished is pending. */
export function checksOf(rollup: OpenPr['statusCheckRollup']): ChecksState {
  if (!rollup?.length) return 'none';
  let pending = false;
  for (const c of rollup) {
    const concl = String(c.conclusion ?? c.state ?? '').toUpperCase();
    const status = String(c.status ?? '').toUpperCase();
    if (FAILED.includes(concl)) return 'fail';
    if ((status && status !== 'COMPLETED') || concl === 'PENDING' || concl === 'EXPECTED' || (!concl && !status)) pending = true;
  }
  return pending ? 'pending' : 'pass';
}

/**
 * Green, as agreed with the orchestrator: based on main, not a draft, its checks passed (or it has
 * none and GitHub still calls it clean), GitHub's merge state CLEAN, and no changes requested.
 */
export function queueItem(p: OpenPr, mainName = 'main'): QueueItem {
  const checks = checksOf(p.statusCheckRollup);
  const review = p.reviewDecision ?? '';
  const mergeState = (p.mergeStateStatus ?? 'UNKNOWN').toUpperCase();
  const base = p.baseRefName ?? '';
  const flags: QueueFlag[] = [];
  const reasons: string[] = [];
  if (base !== mainName) {
    flags.push('stacked');
    reasons.push(`řetěz: míří do ${base || '?'}, ne do ${mainName} — nejdřív slouč tu, nebo přeskládej na ${mainName}`);
  }
  if (p.isDraft) {
    flags.push('draft');
    reasons.push('draft (odložený)');
  }
  if (checks === 'fail') {
    flags.push('checks-fail');
    reasons.push('kontroly selhaly');
  } else if (checks === 'pending') {
    flags.push('checks-pending');
    reasons.push('kontroly ještě běží');
  }
  if (review === 'CHANGES_REQUESTED') {
    flags.push('changes-requested');
    reasons.push('review požaduje změny');
  }
  if (p.mergeable === 'CONFLICTING' || mergeState === 'DIRTY') {
    flags.push('conflict');
    reasons.push(`konflikt s ${mainName} — rebase na čerstvý ${mainName}`);
  } else if (mergeState === 'BEHIND') {
    flags.push('behind');
    reasons.push(`pozadu za ${mainName} — git rebase na ${mainName}`);
  } else if (mergeState === 'BLOCKED') {
    flags.push('blocked');
    reasons.push('GitHub sloučení blokuje (povinné kontroly nebo review)');
  } else if (mergeState !== 'CLEAN' && !p.isDraft) {
    flags.push('unknown');
    reasons.push(`stav sloučení ${mergeState} — GitHub ho ještě počítá, nebo není čistý`);
  }
  const green = flags.length === 0 && mergeState === 'CLEAN';
  if (green) reasons.push(`zelený: kontroly ${checks === 'none' ? 'bez povinných běhů' : 'prošly'}, čistě sloučitelný, bez požadavku na změny`);
  return {
    number: p.number,
    title: p.title ?? '',
    ...(p.url ? { url: p.url } : {}),
    author: p.author?.login ?? '',
    head: p.headRefName ?? '',
    base,
    draft: !!p.isDraft,
    checks,
    review,
    mergeState,
    createdAt: p.createdAt ?? '',
    green,
    flags,
    reasons,
  };
}

/** How far from green: fewer and lighter flags first. */
const distance = (q: QueueItem) =>
  q.flags.reduce((n, f) => n + (f === 'behind' || f === 'checks-pending' || f === 'unknown' ? 1 : f === 'draft' || f === 'stacked' ? 10 : 4), 0);

/** The queue: green PRs to main first, oldest first; then the rest, nearest to green first, then oldest. */
export function buildQueue(prs: readonly OpenPr[], mainName = 'main'): QueueItem[] {
  const items = prs.map((p) => queueItem(p, mainName));
  const age = (q: QueueItem) => Date.parse(q.createdAt) || 0;
  return items.sort((a, b) => Number(b.green) - Number(a.green) || (a.green ? 0 : distance(a) - distance(b)) || age(a) - age(b) || a.number - b.number);
}

/** Whether PR `n` may be merged now: it's the head of the queue and green. Returns the refusal, or undefined. */
export function mergeRefusal(queue: readonly QueueItem[], n: number): string | undefined {
  const head = queue[0];
  if (!head) return 'Fronta je prázdná.';
  if (head.number !== n) return `PR #${n} není na řadě: první ve frontě je #${head.number}.`;
  if (!head.green) return `PR #${n} není zelený: ${head.reasons.join('; ')}.`;
  return undefined;
}

/** The open PRs of `repo` (owner/name), or undefined when gh can't say. */
export async function listOpenPrs(run: Runner, dir: string, repo: string): Promise<OpenPr[] | undefined> {
  try {
    const rows = JSON.parse(await run('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', OPEN_FIELDS], dir)) as unknown;
    return Array.isArray(rows) ? (rows.filter((r) => r && typeof r.number === 'number') as OpenPr[]) : undefined;
  } catch {
    return undefined;
  }
}

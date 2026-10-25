// PR upkeep's "needs a human" notice, taken back once it no longer holds. Upkeep (pr-upkeep.ts) leaves a
// pull request it can't bring up to date to a person: a comment and the `opora-needs-human` label. But a
// later pass, or another office keeping the same repository, can fix it a minute later (a check that
// failed for the machine's reasons, a push race), and then the notice only sends someone to do nothing.
// So a pass that finds the pull request up to date, or brings it there, takes the label off and marks
// each such comment as withdrawn, keeping the original under it.
import type { UpkeepTools } from './upkeep-tools.js';

export const NEEDS_HUMAN = 'opora-needs-human';
/** How upkeep's notice starts (pr-upkeep.ts writes it). */
export const NOTICE_START = "🛰️ Agent Office couldn't bring this pull request up to date";
/** What a withdrawn notice starts with, so it's withdrawn once. */
export const WITHDRAWN = '> ✅ **No longer needs a human.**';

/** The comment body a withdrawn notice gets: the withdrawal, then the original folded away. */
export function withdrawnBody(original: string, head: string): string {
  return [
    `${WITHDRAWN} A later upkeep pass brought this pull request up to date (head ${head.slice(0, 12)}); this notice is withdrawn.`,
    '', '<details><summary>The original notice</summary>', '', original, '', '</details>',
  ].join('\n');
}

/**
 * Takes upkeep's notice back on `number`: the label off, and each notice comment not yet withdrawn
 * rewritten as withdrawn. Resolves to how many comments it withdrew (or -1 when it couldn't read them);
 * never rejects.
 */
export async function withdrawNotice(gh: UpkeepTools['gh'], repository: string, repo: string, number: number, head: string): Promise<number> {
  await gh(['pr', 'edit', String(number), '--repo', repository, '--remove-label', NEEDS_HUMAN], repo).catch(() => '');
  let listed: string;
  try {
    listed = await gh(['api', '--paginate', `repos/${repository}/issues/${number}/comments`,
      '--jq', '.[] | select(.body | startswith("🛰️ Agent Office couldn")) | {id, body} | @json'], repo);
  } catch { return -1; }
  let withdrawn = 0;
  for (const line of listed.split('\n').map((l) => l.trim()).filter(Boolean)) {
    let c: { id?: unknown; body?: unknown };
    try { c = JSON.parse(line) as typeof c; } catch { continue; }
    if (typeof c.id !== 'number' || typeof c.body !== 'string' || !c.body.startsWith(NOTICE_START)) continue;
    try {
      await gh(['api', '-X', 'PATCH', `repos/${repository}/issues/comments/${c.id}`, '-f', `body=${withdrawnBody(c.body, head)}`], repo);
      withdrawn++;
    } catch { /* the label is off; the comment says what it said */ }
  }
  return withdrawn;
}

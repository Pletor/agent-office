import { createHash } from 'node:crypto';

/** What the pull request is drafted from: the execution's identity and the worker's reported result. */
export interface PullRequestDraftInput {
  executionId: string; acceptedRevision: string; cardId: string; cardName?: string;
  result: Record<string, unknown>; base?: string;
}

const TITLE_MAX = 72;
const SUMMARY_MAX = 6000;
const LINE_MAX = 300;
const LINES_MAX = 30;

/** A git ref component made from an id: only safe characters, no `..`, no leading dot or dash, no `.lock`. */
function refPart(value: string, max = 128): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '-').slice(0, max)
    .replace(/^[.-]+/, '').replace(/[.]+$/, '').replace(/\.lock$/i, '-lock');
  return safe || 'x';
}

/** The card's short id in a branch name: its first 12 safe characters. */
export function cardShortId(cardId: string): string {
  return refPart(cardId, 12);
}

/** The branch an execution's work is pushed to, the same every time for the same execution. */
export function handoffBranch(cardId: string, executionId: string): string {
  return `opora/${cardShortId(cardId)}/${refPart(executionId)}`;
}

/** The link's request id: a UUID-shaped SHA-256 of the execution and the commit, so a retry is the same request. */
export function linkRequestId(executionId: string, headSha: string): string {
  const h = createHash('sha256').update(`${executionId}\n${headSha}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string) => clip(text.replace(/\s+/g, ' ').trim(), LINE_MAX);
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** One evidence entry as a line: a string as it is, an object by its name/command and its status/outcome. */
function evidenceLine(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? oneLine(value) : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const name = text(v.name) ?? text(v.command) ?? text(v.check) ?? text(v.test) ?? text(v.title);
  const outcome = text(v.status) ?? text(v.outcome) ?? text(v.result) ?? (typeof v.passed === 'boolean' ? (v.passed ? 'passed' : 'failed') : undefined);
  const detail = text(v.detail) ?? text(v.summary) ?? text(v.output);
  if (!name && !detail) return undefined;
  return oneLine([name ? `\`${name.replaceAll('`', "'")}\`` : undefined, outcome ? `: ${outcome}` : undefined, detail ? ` (${detail})` : undefined].filter(Boolean).join(''));
}

/** The tests and checks the worker says it ran, from `evidence`, `checks` or `tests` (lists, or an object of lists). */
export function evidenceLines(result: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const take = (value: unknown) => {
    if (Array.isArray(value)) for (const item of value) { const line = evidenceLine(item); if (line) lines.push(line); }
    else if (value && typeof value === 'object') for (const inner of Object.values(value)) take(inner);
    else { const line = evidenceLine(value); if (line) lines.push(line); }
  };
  for (const key of ['evidence', 'checks', 'tests']) take(result[key]);
  return [...new Set(lines)].slice(0, LINES_MAX);
}

/** The PR's title and body: summary, checks, risk and revert plan, and the Opora trailers as its last paragraph. */
export function draftPullRequest(input: PullRequestDraftInput): { title: string; body: string } {
  const { result } = input;
  const title = clip(`Opora: ${oneLine(input.cardName || input.cardId)}`, TITLE_MAX);
  const checks = evidenceLines(result);
  const risk = text(result.risk) ?? 'Not assessed by the worker. This is agent-reported work, not independently verified: review the diff and run the checks before merging.';
  const revert = text(result.revert) ?? text(result.revertPlan)
    ?? `Close this pull request unmerged, or revert its merge commit on ${input.base ? `\`${input.base}\`` : 'the base branch'}; the Canvas card keeps its accepted revision.`;
  const body = [
    '## Summary', clip(text(result.summary) ?? '(no summary)', SUMMARY_MAX),
    // Canvas's merge gate wants the PR template's `Testing`, `Risk` and `Revert plan` sections by name.
    '## Testing', checks.length ? checks.map(line => `- ${line}`).join('\n') : 'None reported by the worker.',
    '## Risk', clip(risk, LINE_MAX * 4),
    '## Revert plan', clip(revert, LINE_MAX * 4),
    '---',
    `Opened by Agent Office when Opora execution \`${input.executionId}\` reported its result. Agent Office never merges or approves it.`,
    [`Opora-Execution: ${input.executionId}`, `Opora-Revision: ${input.acceptedRevision}`, `Opora-Card: ${input.cardId}`].join('\n'),
  ].join('\n\n');
  return { title, body };
}

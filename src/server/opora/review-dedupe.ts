import type { KnownFinding } from './review-client.js';
import { normalizeTitle } from './review-output.js';

/**
 * Several finder slots often report the same bug, each worded its own way, so Canvas confirms it
 * as several findings (their fingerprints differ because the titles do). What goes to GitHub shows
 * such a cluster once: the worst-severity finding leads and lists the others it absorbed. This is
 * display only; Canvas keeps every finding and its own status.
 *
 * Two findings of a round are the same bug when they have the same status and path, their lines are
 * close (or one has none), and their titles share enough words: a third of the shorter title's words
 * on the same few lines, half of them within 40 lines.
 */

export interface FindingGroup { lead: KnownFinding; also: KnownFinding[] }

const NEAR_LINES = 3, CLOSE_LINES = 40, NEAR_OVERLAP = 0.34, CLOSE_OVERLAP = 0.5;
const STOP = new Set(['the', 'and', 'are', 'but', 'for', 'from', 'into', 'its', 'not', 'now', 'that', 'then', 'this', 'with', 'when',
  'which', 'was', 'were', 'can', 'has', 'have', 'had', 'been', 'being', 'they', 'them', 'their', 'than', 'only', 'still', 'also', 'any',
  'all', 'via', 'per', 'after', 'before', 'because', 'while', 'does', 'doesn', 'don', 'isn', 'will', 'would', 'should', 'could', 'may']);

/** The title's meaningful words, lower case, a plural `s` dropped ("saves" and "save" are one word). */
export function titleWords(title: string | undefined): Set<string> {
  return new Set(normalizeTitle(title ?? '').split(' ')
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)));
}

/** Shared words over the shorter title's words. */
export function titleOverlap(a: string | undefined, b: string | undefined): number {
  const x = titleWords(a), y = titleWords(b);
  const least = Math.min(x.size, y.size);
  if (!least) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / least;
}

export function sameBug(a: KnownFinding, b: KnownFinding): boolean {
  if (a.status !== b.status || (a.path ?? '') !== (b.path ?? '')) return false;
  const distance = typeof a.line === 'number' && typeof b.line === 'number' ? Math.abs(a.line - b.line) : 0;
  if (distance > CLOSE_LINES) return false;
  return titleOverlap(a.title, b.title) >= (distance <= NEAR_LINES ? NEAR_OVERLAP : CLOSE_OVERLAP);
}

/** The findings (already in display order, worst first) in clusters of the same bug, each led by its first. */
export function groupFindings(findings: KnownFinding[]): FindingGroup[] {
  const parent = findings.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      if (sameBug(findings[i], findings[j])) { const a = root(i), b = root(j); parent[Math.max(a, b)] = Math.min(a, b); }
    }
  }
  const groups = new Map<number, FindingGroup>();
  findings.forEach((f, i) => {
    const r = root(i);
    const g = groups.get(r);
    if (g) g.also.push(f); else groups.set(r, { lead: f, also: [] });
  });
  return [...groups.values()];
}

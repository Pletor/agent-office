import type { ReviewJob } from './review-client.js';

/**
 * Which lines of a pull request GitHub takes an inline review comment on: the new side's added and
 * context lines inside the diff's hunks. A review whose inline comments include any other line is
 * refused as a whole (422 "line must be part of the diff"), so a finding outside them stays in the
 * review body only.
 */

/** Runs `gh` with these arguments and resolves to its stdout. */
export type Gh = (args: string[]) => Promise<string>;
/** Commentable new-side line numbers, by file path. */
export type Commentable = Map<string, Set<number>>;

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The new-side lines of one file's unified-diff patch (as GitHub's files API gives it). */
export function patchLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let next = 0;
  for (const row of patch.split('\n')) {
    const hunk = HUNK.exec(row);
    if (hunk) { next = Number(hunk[1]); continue; }
    if (!next) continue;
    if (row.startsWith('+') || row.startsWith(' ')) lines.add(next++);
  }
  return lines;
}

export function commentableLines(files: { filename?: unknown; patch?: unknown }[]): Commentable {
  const out: Commentable = new Map();
  for (const f of files) {
    if (typeof f.filename !== 'string' || typeof f.patch !== 'string') continue;
    out.set(f.filename, patchLines(f.patch));
  }
  return out;
}

/** The pull request's commentable lines, read from GitHub (one `{filename, patch}` JSON object per line). */
export async function fetchCommentable(gh: Gh, job: ReviewJob): Promise<Commentable> {
  const out = await gh(['api', `repos/${job.repository}/pulls/${job.number}/files`, '--paginate', '--jq', '.[] | {filename, patch}']);
  const files = out.split('\n').flatMap((row) => { try { return row.trim() ? [JSON.parse(row)] : []; } catch { return []; } });
  return commentableLines(files);
}

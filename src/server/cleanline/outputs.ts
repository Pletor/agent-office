// 🗂️ Výstupy · Čistá linie: the PRs merged into main in the last days, each with the outputs its body's
// `## Výstup` section names (docs/vystupy-board.md). Read-only: the repository and its main line come
// from Čistá linie's own data, the PRs from one `gh api graphql` search (fixed arguments, no shell). Cached per
// repository and range (7, 30 or 90 days) for 15 s, like Čistá linie.
import path from 'node:path';
import type { CleanLine } from '../../shared/cleanline.js';
import { countOutputs, OUTPUT_DAYS, parseOutputs, type MergedPr, type OutputsBoard } from '../../shared/outputs.js';
import { githubRepo, type Runner } from '../status/git.js';
import { execRunner } from '../status/index.js';
import { cleanLine, type LineDeps, type Target } from './index.js';

const CACHE_MS = 15_000;
const DAY_MS = 86_400_000;
/** The merged PRs and their own commits, without the commits' authors (`gh pr list --json commits` asks for too many nodes). */
export const MERGED_QUERY = `query($q: String!) { search(query: $q, type: ISSUE, first: 100) { nodes { ... on PullRequest {
  number title url body mergedAt author { login } mergeCommit { oid } commits(first: 50) { nodes { commit { oid messageHeadline } } } } } } }`;

/** One merged PR as MERGED_QUERY gives it. */
interface GqlPr {
  number?: number;
  title?: string;
  url?: string;
  body?: string | null;
  mergedAt?: string | null;
  author?: { login?: string } | null;
  mergeCommit?: { oid?: string } | null;
  commits?: { nodes?: ({ commit?: { oid?: string; messageHeadline?: string } } | null)[] } | null;
}

/** One merged PR, as the board takes it. */
export interface GhMergedPr {
  number: number;
  title?: string;
  url?: string;
  body?: string | null;
  mergedAt?: string | null;
  author?: { login?: string } | null;
  commits?: { oid?: string; messageHeadline?: string }[] | null;
  mergeCommit?: { oid?: string } | null;
}

type Line = Pick<CleanLine, 'repo' | 'graph' | 'error'>;

/** The PRs of `repo` merged into `main` since `since` (GitHub's search, one GraphQL call), or undefined when gh can't say. */
export async function listMerged(run: Runner, dir: string, repo: string, main: string, since: Date): Promise<GhMergedPr[] | undefined> {
  const q = `repo:${repo} is:pr is:merged base:${main} merged:>=${since.toISOString().slice(0, 10)}`;
  try {
    const out = JSON.parse(await run('gh', ['api', 'graphql', '-f', `query=${MERGED_QUERY}`, '-f', `q=${q}`], dir)) as { data?: { search?: { nodes?: (GqlPr | null)[] } } };
    const nodes = out.data?.search?.nodes;
    if (!Array.isArray(nodes)) return undefined;
    return nodes
      .filter((n): n is GqlPr & { number: number } => !!n && typeof n.number === 'number')
      .map((n) => ({ ...n, commits: (n.commits?.nodes ?? []).map((c) => ({ oid: c?.commit?.oid, messageHeadline: c?.commit?.messageHeadline })) }));
  } catch {
    return undefined;
  }
}

/** The board from Čistá linie's data and gh's merged PRs (undefined: gh couldn't be read). Pure. */
export function buildOutputs(line: Line, merged: readonly GhMergedPr[] | undefined, now: number, days = OUTPUT_DAYS): OutputsBoard {
  const since = now - days * DAY_MS;
  const main = line.repo.remote.split('/').slice(1).join('/') || 'main';
  const prs: MergedPr[] = [];
  const seen = new Set<number>();
  for (const p of merged ?? []) {
    const at = Date.parse(p.mergedAt ?? '');
    if (!Number.isFinite(at) || at < since || seen.has(p.number)) continue;
    seen.add(p.number);
    const outputs = parseOutputs(p.body);
    const mainSha = p.mergeCommit?.oid ?? line.graph.find((r) => r.main && r.pr === p.number)?.sha;
    prs.push({
      number: p.number,
      title: p.title ?? '',
      ...(p.url ? { url: p.url } : {}),
      author: p.author?.login ?? '',
      mergedAt: new Date(at).toISOString(),
      commits: (p.commits ?? []).filter((c) => typeof c.oid === 'string').map((c) => ({ sha: c.oid!, subject: c.messageHeadline ?? '' })),
      ...(mainSha ? { mainSha } : {}),
      ...(outputs ? { outputs } : {}),
    });
  }
  // Nothing slips: a squash on main gh didn't name still shows, as "bez výstupu".
  for (const r of line.graph) {
    if (!r.main || !r.pr || seen.has(r.pr) || r.time * 1000 < since) continue;
    seen.add(r.pr);
    prs.push({
      number: r.pr,
      title: r.subject.replace(/\s*\(#\d+\)\s*$/, ''),
      ...(line.repo.url ? { url: `${line.repo.url}/pull/${r.pr}` } : {}),
      author: r.author,
      mergedAt: new Date(r.time * 1000).toISOString(),
      commits: [{ sha: r.sha, subject: r.subject }],
      mainSha: r.sha,
      note: 'tělo PR nešlo z GitHubu přečíst',
    });
  }
  prs.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt) || b.number - a.number);
  return {
    repo: { label: line.repo.label, ...(line.repo.url ? { url: line.repo.url } : {}), main },
    checkedAt: now,
    days,
    prs,
    counts: countOutputs(prs),
    ...(!line.repo.url ? { note: 'Remote není na GitHubu: těla PR nejsou k dispozici.' } : !merged ? { note: 'gh nevrátil sloučené PR (není přihlášený nebo nainstalovaný): výstupy chybí.' } : {}),
    ...(line.error ? { error: line.error } : {}),
  };
}

export interface OutputsDeps extends LineDeps {
  /** Čistá linie's data for the target (its cached read by default). */
  line?: (t: Target) => Promise<Line>;
  now?: () => number;
}

const cache = new Map<string, { at: number; data: Promise<OutputsBoard> }>();

async function compute(t: Target, deps: OutputsDeps, days: number): Promise<OutputsBoard> {
  const run = deps.run ?? execRunner;
  const now = (deps.now ?? Date.now)();
  const line = await (deps.line ?? ((x) => cleanLine(x, deps)))(t);
  const repo = line.repo.url ? githubRepo(line.repo.url) : undefined;
  const main = line.repo.remote.split('/').slice(1).join('/') || 'main';
  const merged = repo ? await listMerged(run, t.dir, repo, main, new Date(now - days * DAY_MS)) : undefined;
  return buildOutputs(line, merged, now, days);
}

/** The outputs board for `t` over the last `days`, shared by every browser asking within 15 s. */
export function outputsBoard(t: Target, deps: OutputsDeps, force = false, days = OUTPUT_DAYS): Promise<OutputsBoard> {
  const key = `${path.resolve(t.dir)}|${days}`;
  const hit = cache.get(key);
  if (hit && !force && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = compute(t, deps, days);
  cache.set(key, { at: Date.now(), data });
  data.catch(() => cache.delete(key));
  return data;
}

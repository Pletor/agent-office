// 🧹 Čistá linie: the Boss Office board's data for a repository (the floor's, or the office's own
// source), and its two human-only actions: Sloučit (squash-merge the head of the queue) and Uklidit
// (delete the confirmed list). Reads are cached per repository for 15 s and fetch at most every 5 min.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CleanLine, CleanupPlan, CleanupResult, RepoChoice } from '../../shared/cleanline.js';
import { githubRepo, listPrs, remoteMain, samePath, type LiveWork, type Runner } from '../status/git.js';
import { execRunner, statusWall } from '../status/index.js';
import { readClientStamp, readStamp } from '../status/instance.js';
import { APP_DIR } from '../upgrade.js';
import { cleanupPlan, runCleanup, type Disk } from './cleanup.js';
import { readGraph } from './graph.js';
import { healthFlags, isMerged, type DriftFacts, type LineState } from './health.js';
import { buildQueue, listOpenPrs, mergeRefusal } from './queue.js';
import { readLine } from './state.js';

const CACHE_MS = 15_000;
const FETCH_MS = 5 * 60_000;

export interface Target {
  id: RepoChoice;
  dir: string;
  label: string;
}

export interface LineDeps {
  run?: Runner;
  live: readonly LiveWork[];
  env?: NodeJS.ProcessEnv;
}

const START_SHA = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: APP_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || undefined;
  } catch {
    return undefined;
  }
})();
const DEV = !fileURLToPath(import.meta.url).includes(`${path.sep}dist${path.sep}`);

/** The repositories a floor's board can show: its own, and the office's source when that's another one. */
export function targets(floorDir: string, floorName: string): Target[] {
  const list: Target[] = [{ id: 'floor', dir: floorDir, label: floorName }];
  if (!samePath(floorDir, APP_DIR)) list.push({ id: 'office', dir: APP_DIR, label: 'agent-office' });
  return list;
}

const remoteOf = (env: NodeJS.ProcessEnv, dir: string) => (samePath(dir, APP_DIR) ? env.AGENT_OFFICE_STATUS_REMOTE?.trim() || undefined : undefined);

/** owner/name on GitHub of the remote main's remote, if it's on GitHub. */
async function ghRepoOf(run: Runner, dir: string, remote: string): Promise<string | undefined> {
  const url = await run('git', ['remote', 'get-url', remote.split('/')[0]], dir).catch(() => '');
  return githubRepo(url);
}

const fetchedAt = new Map<string, number>();
const cache = new Map<string, { at: number; data: Promise<Omit<CleanLine, 'canAct' | 'repos'>> }>();

const protectOf = (dir: string) => [dir, APP_DIR, process.cwd()];

/** Fresh state of `dir`, with its PRs, for an action (never cached). */
async function freshState(run: Runner, t: Target, deps: LineDeps, fetch: boolean): Promise<{ state: LineState; repo?: string }> {
  const env = deps.env ?? process.env;
  const remote = await remoteMain(run, t.dir, remoteOf(env, t.dir));
  const repo = await ghRepoOf(run, t.dir, remote);
  const prs = repo ? await listPrs(run, t.dir, repo) : undefined;
  const state = await readLine(run, t.dir, { remote, fetch, prs, live: deps.live, protect: protectOf(t.dir) });
  return { state, ...(repo ? { repo } : {}) };
}

async function compute(t: Target, deps: LineDeps): Promise<Omit<CleanLine, 'canAct' | 'repos'>> {
  const run = deps.run ?? execRunner;
  const env = deps.env ?? process.env;
  const fetchOn = !['0', 'off', 'false', 'no'].includes((env.AGENT_OFFICE_STATUS_FETCH ?? '').trim().toLowerCase());
  const key = path.resolve(t.dir);
  const fetch = fetchOn && Date.now() - (fetchedAt.get(key) ?? 0) > FETCH_MS;
  if (fetch) fetchedAt.set(key, Date.now());
  const remote = await remoteMain(run, t.dir, remoteOf(env, t.dir));
  const repo = await ghRepoOf(run, t.dir, remote);
  const [prs, open] = repo ? await Promise.all([listPrs(run, t.dir, repo), listOpenPrs(run, t.dir, repo)]) : [undefined, undefined];
  const state = await readLine(run, t.dir, { remote, fetch, prs, live: deps.live, protect: protectOf(t.dir) });
  const queue = buildQueue(open ?? [], state.mainName);
  const remoteName = remote.split('/')[0];
  const refOf = (name: string) => {
    const r = state.refs.find((x) => x.name === name);
    return r?.local ? `refs/heads/${name}` : r?.remote ? `refs/remotes/${remoteName}/${name}` : undefined;
  };
  const heads = [...new Set([...queue.map((q) => refOf(q.head)), ...state.refs.filter((r) => r.ahead > 0 && !isMerged(r)).sort((a, b) => a.idleH - b.idleH).map((r) => refOf(r.name))].filter((x): x is string => !!x))];
  const graph = state.mainSha ? await readGraph(run, t.dir, `refs/remotes/${remote}`, heads) : { rows: [], lanes: 1 };
  let drift: DriftFacts | undefined;
  if (samePath(t.dir, APP_DIR)) {
    const running = statusWall()?.state.office.repo?.runningSha ?? START_SHA;
    drift = { mainSha: state.mainSha, serverSha: running, serverBuilt: readStamp(APP_DIR)?.sha, clientSha: readClientStamp(APP_DIR)?.sha, dev: DEV };
  }
  const health = healthFlags(state, queue, drift);
  const plan = cleanupPlan(state);
  return {
    repo: { id: t.id, dir: t.dir, label: t.label, remote, ...(state.mainSha ? { mainSha: state.mainSha } : {}), ...(repo ? { url: `https://github.com/${repo}` } : {}) },
    checkedAt: Date.now(),
    ...(state.remoteError ? { error: state.remoteError } : {}),
    graph: graph.rows,
    lanes: graph.lanes,
    queue,
    ...(!repo ? { queueNote: 'Remote není na GitHubu: fronta PR není k dispozici.' } : !open ? { queueNote: 'gh nevrátil seznam PR (není přihlášený nebo nainstalovaný): fronta může chybět.' } : {}),
    health,
    counts: {
      next: queue[0]?.green ? queue[0].number : null,
      red: health.filter((f) => f.level === 'bad').length + queue.filter((q) => q.flags.includes('checks-fail') || q.flags.includes('conflict')).length,
      cleanup: plan.items.length,
      drift: health.filter((f) => f.kind === 'drift-server' || f.kind === 'drift-client').length,
    },
  };
}

/** The board's data for `t`, shared by every browser asking within 15 s. */
export function cleanLine(t: Target, deps: LineDeps, force = false): Promise<Omit<CleanLine, 'canAct' | 'repos'>> {
  const key = path.resolve(t.dir);
  const hit = cache.get(key);
  if (hit && !force && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = compute(t, deps);
  cache.set(key, { at: Date.now(), data });
  data.catch(() => cache.delete(key));
  return data;
}

const forget = (t: Target) => cache.delete(path.resolve(t.dir));

/** One line in <data dir>/cleanline-audit.log (and the server's log): who did what, where. */
export function audit(dataDir: string, who: string, action: string, t: Target, detail: string) {
  const line = `${new Date().toISOString()}\t${who}\t${action}\t${t.dir}\t${detail}`;
  console.log(`agent-office: čistá linie: ${line}`);
  try {
    appendFileSync(path.join(dataDir, 'cleanline-audit.log'), `${line}\n`);
  } catch (err) {
    console.error(`agent-office: čistá linie: audit log: ${(err as Error).message}`);
  }
}

/**
 * Squash-merges PR `n`, only if it's at the head of the queue and green right now (read again from
 * GitHub, never from the cache). Never approves anything. Returns the refusal or gh's error.
 */
export async function mergeHead(t: Target, n: number, deps: LineDeps): Promise<{ error?: string; status: number }> {
  const run = deps.run ?? execRunner;
  const remote = await remoteMain(run, t.dir, remoteOf(deps.env ?? process.env, t.dir));
  const repo = await ghRepoOf(run, t.dir, remote);
  if (!repo) return { status: 409, error: 'Remote není na GitHubu.' };
  const open = await listOpenPrs(run, t.dir, repo);
  if (!open) return { status: 503, error: 'Seznam PR z GitHubu nelze přečíst; nic se neslučuje.' };
  const refusal = mergeRefusal(buildQueue(open, remote.split('/').slice(1).join('/') || 'main'), n);
  if (refusal) return { status: 409, error: refusal };
  try {
    // --repo keeps gh out of the checkout: no local branch switching in a shared folder.
    await run('gh', ['pr', 'merge', String(n), '--squash', '--delete-branch', '--repo', repo], t.dir);
  } catch (err) {
    return { status: 502, error: (err as Error).message.split('\n')[0].slice(0, 300) };
  } finally {
    forget(t);
  }
  return { status: 200 };
}

/** What Uklidit would delete in `t` now. */
export async function planFor(t: Target, deps: LineDeps): Promise<CleanupPlan> {
  const { state } = await freshState(deps.run ?? execRunner, t, deps, false);
  return cleanupPlan(state);
}

/** Deletes the confirmed items still safe to delete. */
export async function cleanupFor(t: Target, keys: readonly string[], deps: LineDeps & { disk?: Disk }): Promise<CleanupResult> {
  const run = deps.run ?? execRunner;
  const { state } = await freshState(run, t, deps, false);
  try {
    return await runCleanup(state, keys, { run, ...(deps.disk ? { disk: deps.disk } : {}) });
  } finally {
    forget(t);
  }
}

// 🚦 What runs: the office's own server (the commit it started from and the dist it serves) and the
// live Opora (its /api/build-identity, or failing that, the clock). Read-only throughout.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { OporaClient, OporaError } from '../opora/client.js';
import type { Runner } from './git.js';
import type { OporaRunFacts, RunningFacts } from './rules.js';

/** dist/build-info.json, which the client build stamps (see vite.config.ts): the commit it was built from. */
export interface BuildStamp {
  sha?: string;
  dirty?: boolean;
  at?: number;
}

export function readStamp(appDir: string): BuildStamp | undefined {
  try {
    const s = JSON.parse(readFileSync(path.join(appDir, 'dist', 'build-info.json'), 'utf8')) as Record<string, unknown>;
    return { ...(typeof s.sha === 'string' && /^[0-9a-f]{40}$/.test(s.sha) ? { sha: s.sha } : {}), dirty: s.dirty === true, ...(typeof s.at === 'number' ? { at: s.at } : {}) };
  } catch {
    return undefined;
  }
}

const mtime = (file: string) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
};

const tryRun = (run: Runner, cmd: string, args: string[], cwd: string) => run(cmd, args, cwd).catch(() => undefined);

/** Whether `a` is an ancestor of `b` (git merge-base --is-ancestor answers with its exit code). */
export async function isAncestor(run: Runner, dir: string, a: string, b: string): Promise<boolean> {
  try {
    await run('git', ['merge-base', '--is-ancestor', a, b], dir);
    return true;
  } catch {
    return false;
  }
}

/** What the office was when it started: taken once, as the server starts. */
export interface OfficeStart {
  appDir: string;
  sha?: string;
  dev: boolean;
  built?: BuildStamp;
}

/** The office's running version against the remote main. */
export async function officeRunning(run: Runner, start: OfficeStart, remoteSha: string | undefined): Promise<RunningFacts> {
  const { appDir } = start;
  const facts: RunningFacts = { sha: start.sha, dev: start.dev, built: start.built, disk: readStamp(appDir) };
  facts.headNow = await tryRun(run, 'git', ['rev-parse', 'HEAD'], appDir);
  if (start.sha && remoteSha && start.sha !== remoteSha) facts.behind = await isAncestor(run, appDir, start.sha, remoteSha);
  if (!start.built?.sha && start.sha) {
    facts.indexMtime = mtime(path.join(appDir, 'dist', 'public', 'index.html'));
    const t = Number(await tryRun(run, 'git', ['log', '-1', '--format=%ct', start.sha], appDir));
    if (t) facts.commitTime = t * 1000;
  }
  return facts;
}

/** Opora's /api/build-identity: the commit it started from; null when it has no such endpoint. */
export async function oporaIdentity(client: OporaClient): Promise<{ commit?: string } | null> {
  try {
    const id = await client.buildIdentity();
    return typeof id.commit === 'string' && /^[0-9a-f]{7,40}$/.test(id.commit) ? { commit: id.commit } : {};
  } catch (err) {
    if (err instanceof OporaError && err.status === 404) return null;
    throw err;
  }
}

/** The port a URL is on. */
const portOf = (url: string) => {
  const u = new URL(url);
  return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
};

/**
 * When the process listening on `port` started (ms), best effort: netstat and Get-Process on Windows,
 * lsof and ps elsewhere. Only the PID and its start time are read, never its command line.
 */
export async function listenerStart(run: Runner, port: number, cwd: string, platform = process.platform): Promise<number | undefined> {
  if (platform === 'win32') {
    const out = await tryRun(run, 'netstat', ['-ano', '-p', 'TCP'], cwd);
    const row = (out ?? '').split('\n').find((l) => new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+\\d+`, 'i').test(l));
    const pid = Number(row?.trim().split(/\s+/).pop());
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    const at = await tryRun(run, 'powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], cwd);
    const t = at ? Date.parse(at) : NaN;
    return Number.isFinite(t) ? t : undefined;
  }
  const pid = Number((await tryRun(run, 'lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], cwd))?.split('\n')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const at = await tryRun(run, 'ps', ['-o', 'lstart=', '-p', String(pid)], cwd);
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

/** The live Opora against its repository's remote main. `dir` is the repository, when the office knows it. */
export async function oporaRunning(run: Runner, client: OporaClient, dir: string | undefined, remoteRef: string | undefined, remoteSha: string | undefined): Promise<OporaRunFacts> {
  const facts: OporaRunFacts = { url: client.base, up: false };
  try {
    const h = await client.health();
    facts.up = h.status === 'ok';
    if (!facts.up) facts.error = 'odpověď není „ok“';
  } catch (err) {
    facts.error = err instanceof OporaError && err.status === 0 ? 'neodpovídá' : (err as Error).message.slice(0, 120);
    return facts;
  }
  try {
    facts.identity = await oporaIdentity(client);
  } catch {
    facts.identity = null;
  }
  if (!dir) return facts;
  const index = path.join(dir, 'dist', 'index.html');
  if (existsSync(index)) facts.distMtime = mtime(index);
  if (remoteRef) {
    const t = Number(await tryRun(run, 'git', ['log', '-1', '--format=%ct', remoteRef, '--', 'frontend'], dir));
    if (t) facts.frontendChangedAt = t * 1000;
  }
  const commit = facts.identity?.commit;
  if (commit && remoteSha && commit !== remoteSha) facts.behind = await isAncestor(run, dir, commit, remoteSha);
  if (!commit) {
    const head = await tryRun(run, 'git', ['log', '-1', '--format=%H %ct', 'HEAD'], dir);
    const [sha, ct] = (head ?? '').split(' ');
    if (sha) facts.headSha = sha;
    if (Number(ct)) facts.headTime = Number(ct) * 1000;
    facts.processStart = await listenerStart(run, portOf(client.base), dir);
  }
  return facts;
}

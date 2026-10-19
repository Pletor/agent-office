// 🚦 The status wall ("Stav"): whether the office and Opora are healthy, for the screen by the
// elevator on every floor. Everything here is read with git, gh and HTTP GETs: cheap local checks
// every 30 s, a fetch of the remotes (and their pull requests) every 5 minutes, and both at once
// when someone opens the wall's window. Each result goes to everyone in the office.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPORA_DEFAULT_URL } from '../../shared/opora.js';
import type { StatusPanel, StatusReason, StatusState } from '../../shared/protocol.js';
import { OporaClient } from '../opora/client.js';
import { oporaProcess } from '../opora/process.js';
import { APP_DIR } from '../upgrade.js';
import { githubRepo, listPrs, remoteMain, repoFacts, type LiveWork, type Runner } from './git.js';
import { officeRunning, oporaRunning, readStamp, type OfficeStart } from './instance.js';
import { SUMMARY, panel, repoReasons, runningReasons, oporaRunReasons, type PrFact } from './rules.js';

const LOCAL_MS = 30_000;
const FETCH_MS = 5 * 60_000;
/** A refresh from the window fetches again only this long after the last fetch. */
const REFETCH_MS = 60_000;

/** execFile with fixed arguments and no shell; git never stops to ask for a password. */
export const execRunner: Runner = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } }, (err, out) => {
      if (err) reject(err);
      else resolve(out.trim());
    });
  });

/**
 * Opora's repository: AGENT_OFFICE_OPORA_DIR (the folder the office starts Opora from), else the
 * sibling folder Opora-control-center-canvas next to the office's install, when either has opora.toml.
 */
export function oporaRepoDir(appDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env === process.env ? oporaProcess.dir() : env.AGENT_OFFICE_OPORA_DIR?.trim();
  if (fromEnv && existsSync(path.join(fromEnv, 'opora.toml'))) return fromEnv;
  const sibling = path.join(path.dirname(appDir), 'Opora-control-center-canvas');
  return existsSync(path.join(sibling, 'opora.toml')) ? sibling : undefined;
}

const unknownPanel = (id: StatusPanel['id'], title: string): StatusPanel => ({ id, title, light: 'unknown', summary: SUMMARY.unknown, reasons: [] });

export interface StatusWallDeps {
  emit(state: StatusState): void;
  /** Every seated worker on every floor, with its worktree. */
  live(): LiveWork[];
  run?: Runner;
  appDir?: string;
  env?: NodeJS.ProcessEnv;
}

export class StatusWall {
  readonly state: StatusState = { office: unknownPanel('office', 'Kancelář'), opora: unknownPanel('opora', 'Opora'), checking: false };
  private readonly run: Runner;
  private readonly start: OfficeStart;
  private readonly env: NodeJS.ProcessEnv;
  private readonly opora: OporaClient;
  private prs = new Map<string, PrFact[] | undefined>();
  private fetchedAt?: number;
  private running?: Promise<void>;
  private again?: boolean;
  private timers: NodeJS.Timeout[] = [];

  constructor(private deps: StatusWallDeps) {
    this.run = deps.run ?? execRunner;
    this.env = deps.env ?? process.env;
    const appDir = deps.appDir ?? APP_DIR;
    let sha: string | undefined;
    try {
      sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || undefined;
    } catch {
      sha = undefined;
    }
    // Under tsx (npm run dev) this file is src/server/status/index.ts; built, it's dist/server/server/status/index.js.
    const dev = !fileURLToPath(import.meta.url).includes(`${path.sep}dist${path.sep}`);
    this.start = { appDir, sha, dev, built: readStamp(appDir) };
    this.opora = new OporaClient(this.env.AGENT_OFFICE_OPORA_URL || OPORA_DEFAULT_URL, 'office-status');
  }

  /** Starts the checks: the first in a few seconds, once the office is up. */
  begin() {
    const t1 = setTimeout(() => void this.refresh(true), 4000);
    const t2 = setInterval(() => void this.refresh(false), LOCAL_MS);
    const t3 = setInterval(() => void this.refresh(true), FETCH_MS);
    for (const t of [t1, t2, t3]) t.unref?.();
    this.timers.push(t1, t2, t3);
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private get fetching(): boolean {
    return !['0', 'off', 'false', 'no'].includes((this.env.AGENT_OFFICE_STATUS_FETCH ?? '').trim().toLowerCase());
  }

  /** Checks now; `fetch` fetches the remotes and their pull requests first. One at a time: a call meanwhile runs once more after. */
  refresh(fetch: boolean): Promise<void> {
    if (this.running) {
      this.again ||= fetch;
      return this.running;
    }
    // The quick checks every 30 s just land; a fetch takes a while, so the wall says it's checking.
    if (fetch) {
      this.state.checking = true;
      this.deps.emit(this.state);
    }
    this.running = this.check(fetch)
      .catch((err) => console.error(`agent-office: status wall: ${(err as Error).message}`))
      .finally(() => {
        this.running = undefined;
        this.state.checking = false;
        this.deps.emit(this.state);
        if (this.again !== undefined) {
          const f = this.again;
          this.again = undefined;
          void this.refresh(f);
        }
      });
    return this.running;
  }

  /** The window opened, or ↻: check now, fetching unless that was done a moment ago. */
  refreshSoon(): Promise<void> {
    return this.refresh(!this.fetchedAt || Date.now() - this.fetchedAt > REFETCH_MS);
  }

  private async check(fetch: boolean) {
    const doFetch = fetch && this.fetching;
    const live = this.deps.live();
    const [office, opora] = await Promise.all([this.checkOffice(doFetch, live), this.checkOpora(doFetch, live)]);
    if (doFetch) this.fetchedAt = Date.now();
    this.state.office = office;
    this.state.opora = opora;
  }

  /** The pull requests of the repository at `dir` on `remote`, read again with each fetch. */
  private async prsOf(dir: string, remote: string, fetch: boolean): Promise<{ prs?: PrFact[]; url?: string }> {
    const name = remote.split('/')[0];
    const url = await this.run('git', ['remote', 'get-url', name], dir).catch(() => '');
    const repo = githubRepo(url);
    if (!repo) return {};
    const key = `${dir}\0${repo}`;
    if (fetch || !this.prs.has(key)) this.prs.set(key, await listPrs(this.run, dir, repo));
    return { prs: this.prs.get(key), url: `https://github.com/${repo}` };
  }

  private async checkOffice(fetch: boolean, live: LiveWork[]): Promise<StatusPanel> {
    const dir = this.start.appDir;
    const wanted = this.env.AGENT_OFFICE_STATUS_REMOTE?.trim() || undefined;
    if (!existsSync(path.join(dir, '.git'))) return panel('office', 'Kancelář', [{ level: 'warn', text: 'Instalace kanceláře není git checkout: není s čím porovnat' }], { checkedAt: Date.now() });
    const remote = await remoteMain(this.run, dir, wanted);
    const { prs, url } = await this.prsOf(dir, remote, fetch);
    const facts = await repoFacts(this.run, dir, { remote, fetch, live, prs });
    const running = await officeRunning(this.run, this.start, facts.remoteSha);
    const reasons: StatusReason[] = [...runningReasons(running, facts.remote, facts.remoteSha), ...repoReasons(facts)];
    return panel('office', 'Kancelář', reasons, { repo: { dir, remote: facts.remote, mainSha: facts.remoteSha, runningSha: this.start.sha, ...(url ? { url } : {}) }, checkedAt: Date.now(), fetchedAt: fetch ? Date.now() : this.fetchedAt });
  }

  private async checkOpora(fetch: boolean, live: LiveWork[]): Promise<StatusPanel> {
    const dir = oporaRepoDir(this.start.appDir, this.env);
    const reasons: StatusReason[] = [];
    let repo: StatusPanel['repo'];
    let remoteSha: string | undefined;
    const remote = 'origin/main';
    if (dir) {
      const { prs, url } = await this.prsOf(dir, remote, fetch);
      const facts = await repoFacts(this.run, dir, { remote, fetch, live, prs });
      remoteSha = facts.remoteSha;
      reasons.push(...repoReasons(facts));
      repo = { dir, remote, mainSha: remoteSha, ...(url ? { url } : {}) };
    } else reasons.push({ level: 'warn', text: 'Repozitář Opory nenalezen', fix: 'nastav AGENT_OFFICE_OPORA_DIR na složku Opory' });
    const run = await oporaRunning(this.run, this.opora, dir, dir ? `refs/remotes/${remote}` : undefined, remoteSha);
    reasons.unshift(...oporaRunReasons(run, remote, remoteSha));
    if (repo && run.identity?.commit) repo.runningSha = run.identity.commit;
    return panel('opora', 'Opora', reasons, { ...(repo ? { repo } : {}), checkedAt: Date.now(), fetchedAt: fetch ? Date.now() : this.fetchedAt });
  }
}

let wall: StatusWall | undefined;

/** Makes the building's status wall and starts its checks (see office/services.ts). */
export function startStatusWall(deps: StatusWallDeps): StatusWall {
  wall?.stop();
  wall = new StatusWall(deps);
  wall.begin();
  return wall;
}

export function statusWall(): StatusWall | undefined {
  return wall;
}

export function stopStatusWall() {
  wall?.stop();
}

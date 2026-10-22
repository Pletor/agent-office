// 🧹 The clean line's health, as pure functions of what state.ts read: stacked PRs, branches far
// behind main, merged branches nobody deleted, orphaned worktrees, a dirty main checkout, and the
// deployed server and client against main (see docs/cista-linie.md, 2.5 and 2.6).
import type { HealthFlag, QueueItem } from '../../shared/cleanline.js';
import type { PrFact } from '../status/rules.js';

export const BEHIND_LIMIT = 20;
export const IDLE_HOURS = 24;

/** A branch name, with its local and remote-tracking copies. */
export interface RefInfo {
  name: string;
  /** The local branch's commit, and the remote one's. */
  local?: string;
  remote?: string;
  /** Hours since its newest copy's commit (or since it was created, for a local branch). */
  idleH: number;
  /** Commits it has that main doesn't, and main has that it doesn't (the larger copy's). */
  ahead: number;
  behind?: number;
  /** Each copy's content is already in main (by ancestry, a squash, or its merged PR). */
  localMerged?: boolean;
  remoteMerged?: boolean;
  pr?: PrFact;
  worker?: string;
}

export interface WtInfo {
  path: string;
  branch?: string;
  /** Changed files, tracked or untracked (ignored ones don't count). */
  dirty: number;
  primary: boolean;
  worker?: string;
  idleH: number;
}

/** The repository as the board reads it. */
export interface LineState {
  dir: string;
  /** fork/main, origin/main. */
  remote: string;
  mainName: string;
  mainSha?: string;
  remoteError?: string;
  refs: RefInfo[];
  worktrees: WtInfo[];
  /** The branch the repository's own folder has checked out. */
  current?: string;
  /** Folders never removed: the repository itself, the office's install, the server's cwd. */
  protect: string[];
}

/** The office's own server and client against main (only for the office's own repository). */
export interface DriftFacts {
  mainSha?: string;
  /** The commit the server started from, and the commit its dist (dist/build-info.json) was built from. */
  serverSha?: string;
  serverBuilt?: string;
  /** The commit the client bundle (dist/public/build-info.json) was built from. */
  clientSha?: string;
  /** Run from the sources: Vite may serve the client, so dist/public matters less. */
  dev: boolean;
}

const short = (s?: string) => (s ? s.slice(0, 7) : '?');

/** Every copy of the branch that exists is already in main. */
export const isMerged = (r: RefInfo) => (r.local !== undefined || r.remote !== undefined) && (r.local === undefined || !!r.localMerged) && (r.remote === undefined || !!r.remoteMerged);

/** The flags, worst first; one ok line when there's nothing to say. */
export function healthFlags(s: LineState, queue: readonly QueueItem[], drift?: DriftFacts): HealthFlag[] {
  const out: HealthFlag[] = [];
  if (!s.mainSha) out.push({ kind: 'info', level: 'bad', text: `Nelze přečíst ${s.remote}${s.remoteError ? `: ${s.remoteError}` : ''}`, fix: 'zkontroluj remote a přihlášení ke gitu' });
  for (const q of queue) if (q.flags.includes('stacked')) out.push({ kind: 'stacked', level: 'warn', text: `PR #${q.number} je řetěz: míří do ${q.base}, ne do ${s.mainName}`, where: q.head, fix: `nejdřív slouč ${q.base}, pak PR přeskládej na ${s.mainName} (git rebase --onto)` });
  for (const r of s.refs) {
    if (r.behind !== undefined && r.behind > BEHIND_LIMIT && !isMerged(r) && r.ahead > 0) out.push({ kind: 'behind', level: 'warn', text: `${r.name} je ${r.behind} commitů za ${s.mainName}`, where: r.name, fix: `git fetch && git rebase ${s.remote}` });
  }
  const merged = s.refs.filter((r) => isMerged(r) && (r.pr?.state === 'MERGED' || r.ahead > 0 || r.idleH > IDLE_HOURS));
  for (const r of merged) {
    const where = [r.local && r.localMerged ? 'lokálně' : '', r.remote && r.remoteMerged ? 'na remote' : ''].filter(Boolean).join(' i ');
    out.push({ kind: 'merged-not-deleted', level: 'warn', text: `${r.name}: sloučená, ale nesmazaná (${where})${r.pr?.state === 'MERGED' ? ` — PR #${r.pr.number}` : ''}`, where: r.name, fix: 'smaže ji vlastník, nebo Uklidit' });
  }
  for (const w of s.worktrees) {
    if (w.primary) {
      if (w.dirty) out.push({ kind: 'dirty-main', level: 'bad', text: `Hlavní checkout má neuložené změny (${w.dirty})`, where: w.path, fix: 'hlavní checkout je jen pro nasazení: přesuň práci do worktree a větve' });
      continue;
    }
    const why = orphanWhy(w, s);
    if (!why) continue;
    out.push({ kind: 'orphan-worktree', level: w.dirty ? 'bad' : 'warn', text: `Sirotčí worktree (${why})${w.dirty ? `, neuložené změny: ${w.dirty} — Uklidit ho nesmaže` : ''}`, where: w.path, fix: w.dirty ? 'vlastník změny uloží do PR, nebo je zahodí' : 'smaže ho vlastník, nebo Uklidit' });
  }
  if (drift) out.push(...driftFlags(drift));
  const order = { bad: 0, warn: 1, ok: 2 } as const;
  out.sort((a, b) => order[a.level] - order[b.level]);
  if (!out.length) out.push({ kind: 'info', level: 'ok', text: `Linie je čistá: nic nevisí, ${s.remote} ${short(s.mainSha)}` });
  return out;
}

/** Why a worktree is an orphan (nobody's, and done or abandoned), or undefined while it's someone's work. */
export function orphanWhy(w: WtInfo, s: LineState): string | undefined {
  if (w.primary || w.worker) return undefined;
  if (!w.branch) return w.idleH > IDLE_HOURS ? `odpojená HEAD, ${Math.round(w.idleH)} h bez pohybu` : undefined;
  const ref = s.refs.find((r) => r.name === w.branch);
  if (!ref || ref.local === undefined) return 'větev už neexistuje';
  if (ref.localMerged && (ref.pr?.state === 'MERGED' || ref.ahead > 0)) return `větev ${w.branch} je sloučená`;
  if (ref.ahead === 0 && w.idleH > IDLE_HOURS) return `0 commitů mimo main, ${Math.round(w.idleH)} h bez pohybu`;
  return undefined;
}

/** The deployed server and client against main: a stale client after a merge is exactly what this catches. */
export function driftFlags(d: DriftFacts): HealthFlag[] {
  const out: HealthFlag[] = [];
  if (!d.mainSha) return out;
  if (!d.serverSha) out.push({ kind: 'drift-server', level: 'warn', text: 'Nelze zjistit, z jakého commitu běží server' });
  else if (d.serverSha !== d.mainSha) out.push({ kind: 'drift-server', level: 'bad', text: `Server běží z ${short(d.serverSha)}, main je ${short(d.mainSha)}`, fix: 'nasaď: ff pull, build vedle, restart' });
  if (!d.dev && d.serverBuilt && d.serverSha && d.serverBuilt !== d.serverSha) out.push({ kind: 'drift-server', level: 'bad', text: `dist je sestavený z ${short(d.serverBuilt)}, server běží z ${short(d.serverSha)}`, fix: 'npm run build a restart' });
  if (!d.clientSha) out.push({ kind: 'drift-client', level: 'warn', text: 'Klient (dist/public) nemá razítko sestavení', fix: 'npm run build (zapíše dist/public/build-info.json)' });
  else if (d.clientSha !== d.mainSha) out.push({ kind: 'drift-client', level: d.dev ? 'warn' : 'bad', text: `Klient (dist/public) je sestavený z ${short(d.clientSha)}, main je ${short(d.mainSha)}`, fix: 'npm run build:client (nebo celé nasazení) a obnov stránku' });
  return out;
}

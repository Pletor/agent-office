// 🚦 The status wall's rules, as pure functions of what was found (see git.ts and instance.ts for the
// finding). Green: everything is in the remote main and that's what runs. Amber: work in progress
// (an open PR, a seated worker's branch or worktree), or a version behind main that a restart fixes.
// Red: work that isn't in main and nobody is on (orphaned), or a build that doesn't match.
import type { StatusLevel, StatusLight, StatusPanel, StatusReason } from '../../shared/protocol.js';

/** A pull request for a branch, as `gh pr list --json number,state,headRefName,url,isDraft` says. */
export interface PrFact {
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  headRefName: string;
  url?: string;
  /** A draft: work parked on purpose, not work waiting to be finished. */
  isDraft?: boolean;
}

/** A branch, local or on the remote, and how it stands against the remote main. */
export interface BranchFact {
  name: string;
  /** Commits on it that the remote main doesn't have (by ancestry). */
  ahead: number;
  remote?: boolean;
  pr?: PrFact;
  /** Merging it into main would change nothing: its changes are in main already (a squash merge, say). */
  inMain?: boolean;
  /** The seated worker it belongs to. */
  worker?: string;
}

export interface WorktreeFact {
  path: string;
  branch?: string;
  /** Tracked files with uncommitted changes (untracked ones don't count). */
  dirty: number;
  /** The checkout the others hang off (`git worktree list`'s first). */
  primary: boolean;
  worker?: string;
}

export interface RepoFacts {
  dir: string;
  /** The remote main it's held to: fork/main, origin/main. */
  remote: string;
  remoteSha?: string;
  /** Why the remote main couldn't be read or fetched. */
  remoteError?: string;
  /** The local main against the remote main; unset when there's no local main. */
  localMain?: { ahead: number; behind: number };
  branches: BranchFact[];
  worktrees: WorktreeFact[];
  /** Whether merged PRs could be looked up (gh), or only the branches' contents compared. */
  prLookup: boolean;
}

export const short = (sha: string | undefined) => (sha ? sha.slice(0, 7) : '?');
const plural = (n: number, one: string, few: string, many: string) => `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
const commits = (n: number) => plural(n, 'commit', 'commity', 'commitů');
const files = (n: number) => plural(n, 'soubor', 'soubory', 'souborů');

/** The repository's work against its remote main: unpushed main, orphaned branches and worktrees, open PRs. */
export function repoReasons(f: RepoFacts): StatusReason[] {
  const out: StatusReason[] = [];
  if (!f.remoteSha) out.push({ level: 'warn', text: `Nelze přečíst ${f.remote}${f.remoteError ? `: ${f.remoteError}` : ''}`, fix: 'zkontroluj remote a přihlášení ke gitu' });
  if (f.localMain && f.remoteSha) {
    if (f.localMain.ahead > 0) out.push({ level: 'bad', text: `Místní main má ${commits(f.localMain.ahead)} neodeslané na ${f.remote}`, where: 'main', fix: `pushni main (git push ${f.remote.split('/')[0]} main), nebo je dej do větve s PR` });
    if (f.localMain.behind > 0) out.push({ level: 'warn', text: `Místní main je ${commits(f.localMain.behind)} za ${f.remote}`, where: 'main', fix: 'stáhni main (git pull)' });
  }
  for (const w of f.worktrees) {
    if (!w.dirty) continue;
    if (w.primary) out.push({ level: 'bad', text: `Hlavní checkout má neuložené změny (${files(w.dirty)})`, where: w.path, fix: 'commitni je do větve a otevři PR, nebo je zahoď' });
    else if (w.worker) out.push({ level: 'warn', text: `${w.worker} má rozpracované změny (${files(w.dirty)})`, where: w.path });
    else out.push({ level: 'bad', text: `Worktree bez workera má neuložené změny (${files(w.dirty)})`, where: w.path, fix: 'commitni a otevři PR, nebo worktree smaž' });
  }
  let merged = 0;
  let parked = 0;
  for (const b of f.branches) {
    if (b.ahead <= 0) continue;
    const pr = b.pr;
    const where = b.remote ? `${f.remote.split('/')[0]}/${b.name}` : b.name;
    if (pr?.state === 'MERGED' || b.inMain) merged++;
    else if (pr?.state === 'OPEN' && pr.isDraft) {
      parked++;
      out.push({ level: 'ok', text: `PR #${pr.number} je odložený (draft)`, where, fix: 'vrať ho z draftu, až na něm budete pracovat', url: pr.url });
    } else if (pr?.state === 'OPEN') out.push({ level: 'warn', text: `PR #${pr.number} je otevřený`, where, fix: `dokonči a mergni PR #${pr.number}`, url: pr.url });
    else if (b.worker) out.push({ level: 'warn', text: `Rozpracováno: ${b.worker} (${commits(b.ahead)} mimo main)`, where, fix: 'nech workera dokončit a otevřít PR' });
    else if (pr?.state === 'CLOSED') out.push({ level: 'bad', text: `PR #${pr.number} je zavřený bez merge, ${commits(b.ahead)} mimo main`, where, fix: 'otevři PR znovu, nebo větev smaž', url: pr.url });
    else out.push({ level: 'bad', text: `Větev má ${commits(b.ahead)} mimo main a žádný PR`, where, fix: 'otevři PR' });
  }
  if (merged) out.push({ level: 'ok', text: `${plural(merged, 'větev je', 'větve jsou', 'větví je')} už v main (sloučené PR)`, fix: 'větve můžeš smazat' });
  if (!f.prLookup) out.push({ level: 'ok', text: 'gh není k dispozici: sloučení poznávám podle obsahu větví' });
  if (!out.some((r) => r.level !== 'ok') && f.remoteSha) out.unshift({ level: 'ok', text: `Všechna práce je v ${f.remote} (${short(f.remoteSha)})${parked ? ` (odloženo: ${parked} draft PR)` : ''}` });
  return out;
}

/** What the office's server runs, and what it was built from. */
export interface RunningFacts {
  /** HEAD of the install as the server started. */
  sha?: string;
  /** Run from the sources (npm run dev): Vite serves the client, there's no dist to match. */
  dev: boolean;
  /** dist's build stamp as the server started, and as it is on disk now. */
  built?: { sha?: string; dirty?: boolean };
  disk?: { sha?: string; dirty?: boolean };
  /** The client bundle's own stamp (dist/public/build-info.json): a stale client after a merge shows here. */
  client?: { sha?: string };
  /** No client source changed between dist's stamp and the running commit (and between the bundle's and main):
   *  a server-only merge, which the deploy script (aktualizovat-vse.ps1) rightly does not rebuild for. */
  builtSameClient?: boolean;
  clientSameCode?: boolean;
  /** HEAD of the install now. */
  headNow?: string;
  /** The running commit is an ancestor of the remote main (it's behind, not off on its own). */
  behind?: boolean;
  /** Without a stamp: when dist's page was written, and the running commit's time (ms). */
  indexMtime?: number;
  commitTime?: number;
}

/** Whether the office runs the remote main, built from it. */
export function runningReasons(r: RunningFacts, remote: string, remoteSha: string | undefined): StatusReason[] {
  const out: StatusReason[] = [];
  if (!r.sha) return [{ level: 'warn', text: 'Běžící verzi nelze zjistit (instalace není git checkout)' }];
  if (remoteSha) {
    if (r.sha === remoteSha) out.push({ level: 'ok', text: `Běží ${short(r.sha)} = ${remote}` });
    else if (r.behind) {
      const restartFixes = r.headNow === remoteSha && (r.dev || r.disk?.sha === remoteSha);
      out.push(
        restartFixes
          ? { level: 'warn', text: `Potřeba restart: běží ${short(r.sha)}, ${remote} je ${short(remoteSha)} a je už sestavený`, where: r.sha, fix: 'restartuj kancelář' }
          : { level: 'warn', text: `Běží starší verze ${short(r.sha)}, ${remote} je ${short(remoteSha)}`, where: r.sha, fix: 'stáhni main, sestav (npm run build) a restartuj kancelář' },
      );
    } else out.push({ level: 'bad', text: `Běží ${short(r.sha)}, který není v ${remote}`, where: r.sha, fix: 'dostaň změny do main přes PR, pak sestav z main a restartuj' });
  }
  if (r.client?.sha && remoteSha && r.client.sha !== remoteSha && !r.clientSameCode) out.push({ level: r.dev ? 'warn' : 'bad', text: `Klient (dist/public) je sestavený z ${short(r.client.sha)}, ${remote} je ${short(remoteSha)}`, fix: 'npm run build a obnov stránku' });
  if (r.dev) {
    out.push({ level: 'ok', text: 'Vývojový režim: klienta servíruje Vite přímo ze zdrojů' });
    return out;
  }
  if (r.built?.sha) {
    if (r.built.sha !== r.sha && r.builtSameClient && !r.built.dirty) out.push({ level: 'ok', text: `dist je sestavený z ${short(r.built.sha)}; klient se od té doby nezměnil` });
    else if (r.built.sha !== r.sha) out.push({ level: 'bad', text: `dist je sestavený z ${short(r.built.sha)}, server běží z ${short(r.sha)}`, fix: 'npm run build a restartuj kancelář' });
    else if (r.built.dirty) out.push({ level: 'bad', text: 'dist byl sestaven i s neuloženými změnami', fix: 'sestav čistě z main a restartuj kancelář' });
    else out.push({ level: 'ok', text: 'dist je sestavený z běžícího commitu' });
  } else if (r.indexMtime && r.commitTime && r.indexMtime >= r.commitTime) out.push({ level: 'ok', text: 'dist je novější než běžící commit (bez razítka sestavení)' });
  else out.push({ level: 'warn', text: 'Nelze ověřit, z čeho je dist sestavený', fix: 'npm run build a restartuj kancelář' });
  if (r.disk?.sha && r.built?.sha && (r.disk.sha !== r.built.sha || !!r.disk.dirty !== !!r.built.dirty)) {
    out.push(
      r.disk.sha === remoteSha && !r.disk.dirty
        ? { level: 'warn', text: `Potřeba restart: na disku je nové sestavení ${short(r.disk.sha)}`, fix: 'restartuj kancelář' }
        : { level: 'warn', text: `Na disku je jiné sestavení (${short(r.disk.sha)}) než to, které běží`, fix: 'sestav z main a restartuj kancelář' },
    );
  }
  return out;
}

/** What the running Opora says about itself, and its repository's frontend build. */
export interface OporaRunFacts {
  url: string;
  up: boolean;
  error?: string;
  /** /api/build-identity: the commit it started from. Null when Opora has no such endpoint. */
  identity?: { commit?: string } | null;
  /** The commit it runs is an ancestor of the remote main. */
  behind?: boolean;
  /** When dist/index.html was built, and the last commit on the remote main that changed frontend/ (ms). */
  distMtime?: number;
  frontendChangedAt?: number;
  /** Without an identity: when the process listening on Opora's port started, and the HEAD commit (ms, sha). */
  processStart?: number;
  headTime?: number;
  headSha?: string;
}

/** Whether Opora runs, and runs the remote main. */
export function oporaRunReasons(o: OporaRunFacts, remote: string, remoteSha: string | undefined): StatusReason[] {
  if (!o.up) return [{ level: 'bad', text: `Opora neběží na ${o.url}${o.error ? ` (${o.error})` : ''}`, fix: 'spusť Opora (okno 🛰️ Opora → ▶ Start, nebo uv run opora)' }];
  const out: StatusReason[] = [{ level: 'ok', text: `Opora odpovídá na ${o.url}` }];
  const frontendOk = o.distMtime !== undefined && o.frontendChangedAt !== undefined && o.distMtime >= o.frontendChangedAt;
  const commit = o.identity?.commit;
  if (commit) {
    if (!remoteSha) out.push({ level: 'warn', text: `Opora běží z ${short(commit)}, ${remote} nelze přečíst`, where: commit });
    else if (commit === remoteSha) out.push({ level: 'ok', text: `Opora běží z ${short(commit)} = ${remote}` });
    else if (o.behind) out.push({ level: 'warn', text: `Potřeba restart: Opora běží ze starší verze ${short(commit)}, ${remote} je ${short(remoteSha)}`, where: commit, fix: 'stáhni main a restartuj Opora' });
    else out.push({ level: 'bad', text: `Opora běží z ${short(commit)}, který není v ${remote}`, where: commit, fix: 'dostaň změny do main přes PR a restartuj Opora z main' });
    if (o.distMtime === undefined) out.push({ level: 'warn', text: 'Frontend Opory není sestavený (chybí dist/index.html)', fix: 'restartuj Opora (sestaví si ho), nebo npm run build' });
    else if (o.frontendChangedAt !== undefined && !frontendOk) out.push({ level: 'warn', text: 'Frontend Opory je starší než poslední změna frontendu v main', fix: 'restartuj Opora (sestaví si ho), nebo npm run build' });
    return out;
  }
  // No identity: by the clock, when it can be told at all.
  const byClock = o.processStart !== undefined && o.headTime !== undefined && o.processStart > o.headTime && !!remoteSha && o.headSha === remoteSha && frontendOk;
  out.push(byClock ? { level: 'ok', text: 'Verze ověřena podle času: Opora startovala po posledním commitu a frontend je novější než jeho poslední změna' } : { level: 'warn', text: 'Verze neověřena: Opora neříká, z jakého commitu běží', fix: 'restartuj Opora z main (nebo přidej /api/build-identity)' });
  return out;
}

const RANK: Record<StatusLevel, number> = { bad: 0, warn: 1, ok: 2 };

/** The worst level among the reasons. */
export function lightOf(reasons: readonly StatusReason[]): StatusLight {
  if (reasons.some((r) => r.level === 'bad')) return 'red';
  if (reasons.some((r) => r.level === 'warn')) return 'amber';
  return reasons.length ? 'green' : 'unknown';
}

export const SUMMARY: Record<StatusLight, string> = { green: 'V pořádku', amber: 'Rozpracováno', red: 'Pozor', unknown: 'Zjišťuji…' };

/** A panel out of its reasons, worst first. */
export function panel(id: StatusPanel['id'], title: string, reasons: StatusReason[], extra: Partial<StatusPanel> = {}): StatusPanel {
  const sorted = reasons.map((r, i) => ({ r, i })).sort((a, b) => RANK[a.r.level] - RANK[b.r.level] || a.i - b.i).map((x) => x.r);
  const light = lightOf(sorted);
  return { id, title, light, summary: SUMMARY[light], reasons: sorted, ...extra };
}

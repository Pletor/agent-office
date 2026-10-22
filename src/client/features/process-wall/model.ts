import type { GhPull, GhState, QueueTask, WorkerInfo } from '../../../shared/protocol';

export const PHASES = ['Fronta', 'Práce', 'Kontroly', 'Review / PR', 'Výstup', 'Sloučeno'] as const;
export type WallView = 'overview' | 'workers' | 'blockers';
export interface ProcessRow {
  id: string; title: string; owner: string; detail: string; branch: string; phase: number;
  blocked: boolean; moving: boolean; pr?: GhPull; workerId?: string;
}
export interface WallSnapshot {
  floor: string; connected: boolean; ready: boolean; at: number;
  rows: ProcessRow[]; workers: number; queued: number; running: number; blocked: number;
  githubAt: number; githubError?: string; githubLoading: boolean;
}
export interface WallInput {
  floor: string; workers: WorkerInfo[]; tasks: QueueTask[]; pulls: GhState<GhPull>;
  connected: boolean; ready: boolean; at: number;
}
const ACTION = { read: 'Čte zdroje', edit: 'Upravuje kód', test: 'Spustil kontrolu · výsledek nepotvrzen', web: 'Hledá zdroje', failing: 'Opakovaná selhání nástroje' };

/** Observed status only: a finished agent turn never implies passing CI or a merged PR. */
export function processRow(task?: QueueTask, worker?: WorkerInfo, pr?: GhPull): ProcessRow {
  const row: ProcessRow = {
    id: task ? `task:${task.id}` : worker ? `worker:${worker.id}` : `pr:${pr!.number}`,
    title: task?.title || worker?.task?.name || worker?.title || pr?.title || worker?.name || 'Práce',
    owner: worker?.name || task?.workerName || pr?.author || 'Nepřiděleno',
    branch: worker?.worktree?.branch || task?.branch || pr?.headRefName || 'Větev není doložena',
    phase: 0, blocked: false, moving: false, pr, workerId: worker?.id,
    detail: 'Čeká na přidělení pracovníka',
  };
  if (worker) {
    row.phase = 1;
    row.detail = worker.status === 'working' ? (worker.action ? ACTION[worker.action] : 'Pracovník hlásí práci')
      : worker.status === 'starting' ? 'Pracovník startuje' : worker.status === 'idle' ? 'Pracovník je připraven'
      : worker.status === 'done' ? 'Tah agenta skončil · správnost ani merge tím nejsou potvrzené'
      : worker.status === 'needs_input' ? 'Čeká na odpověď člověka' : 'Pracovník neběží';
    row.moving = worker.status === 'working';
    if (worker.action === 'test' && row.moving) row.phase = 2;
    if (worker.status === 'done') row.phase = 4;
    row.blocked = worker.status === 'needs_input' || !!worker.lost || (worker.status === 'working' && worker.action === 'failing');
    if (worker.lost) row.detail = 'Chybí pracovní adresář';
  } else if (task?.status === 'running') {
    row.phase = 1; row.detail = 'Fronta hlásí běh · pracovník není v aktuálním snapshotu';
  }
  if (task?.status === 'done' && !worker) {
    row.phase = 4; row.detail = 'Úloha ve frontě skončila · merge není doložen';
  }
  if (task?.outcome && task.outcome !== 'done') { row.blocked = true; row.detail = task.error || `Úloha skončila: ${task.outcome}`; }
  if (pr) {
    if (pr.state === 'MERGED') { row.phase = 5; row.blocked = false; row.moving = false; row.detail = `GitHub potvrzuje sloučení #${pr.number} · nasazení nesledujeme`; }
    else if (pr.state === 'CLOSED') { row.phase = 4; row.moving = false; row.detail = `PR #${pr.number} uzavřen bez sloučení`; }
    else if (pr.checks === 'fail' || pr.reviewDecision === 'CHANGES_REQUESTED') {
      row.blocked = true; row.phase = pr.checks === 'fail' ? 2 : 3;
      row.detail = pr.checks === 'fail' ? 'GitHub kontroly selhaly' : 'Review požaduje změny';
    } else if (!row.blocked) {
      row.phase = pr.checks === 'pending' ? 2 : 3;
      row.detail = pr.isDraft ? 'Rozpracovaný PR' : pr.checks === 'pending' ? 'Čeká na GitHub kontroly'
        : pr.checks === 'none' ? 'PR existuje · kontroly nejsou doložené'
        : pr.reviewDecision === 'APPROVED' ? 'Kontroly prošly a review schválilo · merge čeká' : 'Kontroly prošly · čeká na review / merge';
    }
  }
  return row;
}
export function projectWall(input: WallInput): WallSnapshot {
  const usedWorkers = new Set<string>(), usedPulls = new Set<number>();
  const rows: ProcessRow[] = [];
  const matchPull = (task?: QueueTask, worker?: WorkerInfo) => input.pulls.items.find(p =>
    p.number === task?.pr?.number || p.number === worker?.pr?.number ||
    (!!p.headRefName && p.headRefName === (worker?.worktree?.branch || task?.branch)));
  for (const task of input.tasks) {
    const worker = input.workers.find(w => w.id === task.workerId);
    const pr = matchPull(task, worker);
    if (worker) usedWorkers.add(worker.id);
    if (pr) usedPulls.add(pr.number);
    rows.push(processRow(task, worker, pr));
  }
  for (const worker of input.workers.filter(w => !usedWorkers.has(w.id))) {
    const pr = matchPull(undefined, worker);
    if (pr) usedPulls.add(pr.number);
    rows.push(processRow(undefined, worker, pr));
  }
  for (const pr of input.pulls.items.filter(p => !usedPulls.has(p.number))) rows.push(processRow(undefined, undefined, pr));
  rows.sort((a, b) => Number(b.blocked) - Number(a.blocked) || Number(b.moving) - Number(a.moving) || a.title.localeCompare(b.title));
  return { floor: input.floor, connected: input.connected, ready: input.ready, at: input.at, rows,
    workers: input.workers.length, queued: input.tasks.filter(t => t.status === 'queued').length,
    running: input.workers.filter(w => w.status === 'working').length, blocked: rows.filter(r => r.blocked).length,
    githubAt: input.pulls.fetchedAt, githubError: input.pulls.error, githubLoading: input.pulls.loading };
}
export function visibleRows(s: WallSnapshot, view: WallView) {
  return s.rows.filter(row => view === 'workers' ? !!row.workerId : view === 'blockers' ? row.blocked : true);
}
export function connectionLabel(s: WallSnapshot): string {
  return !s.connected ? 'ODPOJENO · poslední známý stav' : !s.ready ? 'SYNCHRONIZACE · čeká na snapshot' : 'ŽIVĚ · agent-office';
}
/** The local history stores observations, never terminal output or an invented backend event log. */
export class WallHistory {
  entries: { at: number; text: string }[] = [];
  private previous = new Map<string, string>();
  clear() { this.entries = []; this.previous.clear(); }
  observe(s: WallSnapshot) {
    const next = new Map<string, string>();
    for (const row of s.rows) {
      const signature = JSON.stringify([row.title, row.detail, row.branch, row.phase, row.pr?.headRefOid]); next.set(row.id, signature);
      if (this.previous.get(row.id) !== signature) this.entries.unshift({ at: s.at, text: `${row.title} · ${row.detail}` });
    }
    this.previous = next; this.entries.length = Math.min(this.entries.length, 80);
  }
}

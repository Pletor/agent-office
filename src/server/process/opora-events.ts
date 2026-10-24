// Opora's side of the work as process events: the canvas the bridge polls (cards, stages, the
// activity log, the office's runs), and what the office's Opora machinery did (execution claims and
// heartbeats, pull request hand-offs, self-checks, upkeep, the merge guard, reviews, isolated runs).
// Pure mappings; the taps that call them live next to each source (see sources.ts).

import type { OporaCard, OporaCardStatus, OporaState, ProcessPhase } from '../../shared/protocol.js';
import type { ProcessInput } from './journal.js';

const CARD: Record<OporaCardStatus, { phase: ProcessPhase; state: ProcessInput['state']; cz: string }> = {
  frontier: { phase: 'intake', state: 'wait', cz: 'připravena k převzetí' },
  claimed: { phase: 'work', state: 'progress', cz: 'převzata' },
  blocked: { phase: 'work', state: 'blocked', cz: 'blokována' },
  waiting: { phase: 'intake', state: 'wait', cz: 'čeká na člověka' },
  closed: { phase: 'memory', state: 'ok', cz: 'uzavřena v Opoře' },
  needsRouting: { phase: 'plan', state: 'wait', cz: 'čeká na pipeline' },
};

/** Which column an Opora pipeline stage belongs to. */
export function stagePhase(stage: string): ProcessPhase {
  const s = stage.toLowerCase();
  if (/plan|route|router|design/.test(s)) return 'plan';
  if (/test|check|verify|qa/.test(s)) return 'checks';
  if (/review|critic|security/.test(s)) return 'review';
  if (/merge|release|deploy/.test(s)) return 'merge';
  if (/memory|learn/.test(s)) return 'memory';
  return 'work';
}

export interface OporaSeen {
  cards: Map<string, OporaCard>;
  activity: number;
  runs: Map<string, string>;
  project?: string;
}

export function oporaSeen(state: OporaState): OporaSeen {
  return {
    cards: new Map(state.cards.map((c) => [c.id, c])),
    activity: state.activity.reduce((m, a) => Math.max(m, a.id), 0),
    runs: new Map(state.runs.map((r) => [r.cardId, r.state])),
    project: state.project ? `${state.project.id}/${state.workspace ?? ''}` : undefined,
  };
}

/** The canvas the bridge just read, against the last read: cards that moved, stages, new activity, runs reported. */
export function oporaEvents(prev: OporaSeen | undefined, state: OporaState): ProcessInput[] {
  const seen = oporaSeen(state);
  // A first read, or the floor now reads another project or workspace: a baseline, not news.
  if (!prev || prev.project !== seen.project || !state.connected) return [];
  const out: ProcessInput[] = [];
  for (const c of state.cards) {
    const was = prev.cards.get(c.id);
    if (!was) continue;
    const refs = { cardId: c.id };
    if (was.status !== c.status) {
      const m = CARD[c.status];
      out.push({ source: 'opora', kind: 'card.status', phase: m.phase, state: m.state, title: `${c.name}: ${m.cz}`, detail: `${CARD[was.status].cz} → ${m.cz}`, refs });
    }
    if (c.stage && was.stage !== c.stage)
      out.push({ source: 'opora', kind: 'stage', phase: stagePhase(c.stage), state: 'progress', title: `${c.name}: etapa ${c.stage}`, detail: was.stage ? `${was.stage} → ${c.stage}` : undefined, refs });
  }
  for (const a of [...state.activity].filter((x) => x.id > prev.activity).sort((x, y) => x.id - y.id))
    out.push({
      source: 'opora',
      kind: 'activity',
      phase: /plán|plan|rout/i.test(a.what) ? 'plan' : 'work',
      state: a.ok ? 'info' : 'fail',
      title: `${a.agent}: ${a.what}`,
      at: a.at || undefined,
      actor: { kind: 'agent', name: a.agent },
      refs: a.nodeIds[0] ? { cardId: a.nodeIds[0] } : {},
    });
  for (const r of state.runs) {
    const was = prev.runs.get(r.cardId);
    if (was === undefined || was === r.state) continue;
    const refs = { cardId: r.cardId, ...(r.workerId ? { workerId: r.workerId } : {}), ...(r.workspace ? { workspace: r.workspace } : {}) };
    if ((r.state as string) === 'reported') out.push({ source: 'opora', kind: 'run.result', phase: 'work', state: 'ok', title: `${r.cardName}: výsledek přijat Canvasem`, detail: 'Hlášeno agentem, nezávisle neověřeno', refs });
    else if (r.state === 'gone' && r.error) out.push({ source: 'office', kind: 'run.release', phase: 'work', state: 'fail', title: `${r.cardName}: běh ukončen`, detail: r.error, refs });
  }
  return out;
}

/** An execution claim, granted or refused. */
export function claimEvent(scope: { project: string; workspace: string; nodeId: string }, ok: { executionId: string; workerId: string; workerName?: string } | { error: string }): ProcessInput {
  const refs = { project: scope.project, workspace: scope.workspace, cardId: scope.nodeId };
  return 'error' in ok
    ? { kind: 'run.claim', phase: 'work', state: 'fail', title: 'Převzetí karty selhalo', detail: ok.error, refs }
    : { kind: 'run.claim', phase: 'work', state: 'start', title: `Běh ${ok.executionId} převzat${ok.workerName ? ` · ${ok.workerName}` : ''}`, refs: { ...refs, executionId: ok.executionId, workerId: ok.workerId } };
}

/** The lease's heartbeat changed state: it's failing (and retrying), it came back, authority ended, or the run finished (its result is in). */
export function heartbeatEvent(lease: { executionId: string; project: string; workspace: string; nodeId: string }, workerId: string, change: 'retrying' | 'recovered' | 'stopped' | 'finished', reason?: string): ProcessInput {
  const refs = { project: lease.project, workspace: lease.workspace, cardId: lease.nodeId, executionId: lease.executionId, workerId };
  // Canvas ended authority because the result is in: the run's normal end.
  if (change === 'finished') return { kind: 'run.release', phase: 'work', state: 'ok', title: `Běh ${lease.executionId} dokončen`, detail: 'Canvas ukončil běh po nahlášeném výsledku', refs };
  if (change === 'stopped') return { kind: 'run.release', phase: 'work', state: 'fail', title: `Běh ${lease.executionId} zastaven`, detail: reason, refs };
  return change === 'retrying'
    ? { kind: 'run.heartbeat', phase: 'work', state: 'wait', title: `Běh ${lease.executionId}: heartbeat neprošel, opakuji`, refs }
    : { kind: 'run.heartbeat', phase: 'work', state: 'ok', title: `Běh ${lease.executionId}: heartbeat obnoven`, refs };
}

export function releaseEvent(lease: { executionId: string; project: string; workspace: string; nodeId: string }, workerId?: string): ProcessInput {
  return { kind: 'run.release', phase: 'work', state: 'info', title: `Běh ${lease.executionId} uvolněn`, refs: { project: lease.project, workspace: lease.workspace, cardId: lease.nodeId, executionId: lease.executionId, ...(workerId ? { workerId } : {}) } };
}

export interface HandoffLike { state: string; reason?: string; branch?: string; headSha?: string; number?: number; url?: string; link?: string }

/** The office pushed an execution's work and opened (or reused) its pull request, or couldn't. */
export function handoffEvent(lease: { executionId: string; project: string; workspace: string; nodeId: string }, out: HandoffLike): ProcessInput {
  const refs = { project: lease.project, workspace: lease.workspace, cardId: lease.nodeId, executionId: lease.executionId, ...(out.branch ? { branch: out.branch } : {}), ...(out.headSha ? { sha: out.headSha } : {}), ...(out.number ? { pr: out.number } : {}), ...(out.url ? { url: out.url } : {}) };
  if (out.state === 'opened' || out.state === 'reused')
    return { kind: 'pr.opened', phase: 'review', state: 'start', title: `${out.state === 'opened' ? 'Otevřen' : 'Znovu použit'} PR #${out.number} pro běh ${lease.executionId}`, detail: out.link ? `propojení s Canvasem: ${out.link}` : undefined, refs };
  return { kind: 'pr.handoff', phase: 'review', state: out.state === 'failed' ? 'fail' : 'info', title: `Běh ${lease.executionId}: PR neotevřen`, detail: out.reason, refs };
}

export function selfCheckEvent(s: { project: string; workspace: string; executionId: string; headSha: string }, failed: string[], outcome: string): ProcessInput {
  return {
    kind: 'check.self',
    phase: 'checks',
    state: failed.length ? 'fail' : 'ok',
    title: failed.length ? `Self-checky selhaly: ${failed.join(', ')}` : 'Self-checky prošly',
    detail: `head ${s.headSha.slice(0, 12)} · Canvas: ${outcome}`,
    refs: { project: s.project, workspace: s.workspace, executionId: s.executionId, sha: s.headSha },
  };
}

const UPKEEP = { rebased: ['ok', 'přebázován'], resolved: ['ok', 'konflikty vyřešeny'], human: ['blocked', 'potřebuje člověka'], failed: ['fail', 'údržba selhala'] } as const;

/** One upkeep pass: only PRs it did something to (or couldn't), and the guard when its verdict changed. */
export function upkeepEvents(pass: { upkeep?: { number: number; state: string; reason?: string }[]; guard?: { state: string; head: string; culprit?: string; url?: string; reason?: string } }, lastGuard?: string): ProcessInput[] {
  const out: ProcessInput[] = [];
  for (const u of pass.upkeep ?? []) {
    const m = UPKEEP[u.state as keyof typeof UPKEEP];
    if (m) out.push({ kind: 'upkeep', phase: 'merge', state: m[0], title: `PR #${u.number}: ${m[1]}`, detail: u.reason, refs: { pr: u.number } });
  }
  const g = pass.guard;
  if (g && `${g.state}@${g.head}` !== lastGuard && g.state !== 'none' && g.state !== 'handled' && g.state !== 'not-opora') {
    const state = g.state === 'green' ? 'ok' : g.state === 'pending' ? 'wait' : g.state === 'reverted' || g.state === 'reused' ? 'blocked' : g.state === 'inconclusive' ? 'info' : 'fail';
    out.push({ kind: 'guard', phase: 'merge', state, title: `Hlídka po sloučení: ${g.state}`, detail: [g.culprit && `viník ${g.culprit.slice(0, 12)}`, g.reason].filter(Boolean).join(' · ') || undefined, refs: { sha: g.head, ...(g.url ? { url: g.url } : {}) } });
  }
  return out;
}

/** A review slot taken or finished, or a finished review posted on GitHub. */
export function reviewEvent(job: { repository: string; number: number; round: number; headSha: string; kind?: string; executionId?: string; cardId?: string }, what: 'claimed' | 'submitted' | 'released' | 'lost' | 'posted' | 'updated', role?: string): ProcessInput {
  const security = job.kind === 'security';
  const state = what === 'claimed' ? 'start' : what === 'submitted' ? 'progress' : what === 'posted' || what === 'updated' ? 'ok' : what === 'lost' ? 'fail' : 'info';
  const cz = { claimed: 'převzata', submitted: 'odevzdána', released: 'uvolněna', lost: 'ztracena', posted: 'zveřejněna na GitHubu', updated: 'aktualizována na GitHubu' }[what];
  return {
    kind: security ? 'security.review' : 'pr.review',
    phase: 'review',
    state,
    title: `${security ? 'Bezpečnostní review' : 'Review'} ${job.repository}#${job.number} (kolo ${job.round}) ${cz}`,
    detail: role ? `role ${role}` : undefined,
    actor: { kind: 'agent', name: 'review' },
    refs: { pr: job.number, sha: job.headSha, ...(job.executionId ? { executionId: job.executionId } : {}), ...(job.cardId ? { cardId: job.cardId } : {}) },
  };
}

const ISOLATED: Record<string, ProcessInput['state']> = { prepared: 'start', claiming: 'progress', claimed: 'progress', bound: 'progress', running: 'progress', unknown: 'wait', termination_pending: 'wait', terminated: 'info', failed: 'fail' };

/** An isolated (remote) run moved to another stage. */
export function isolatedEvent(run: { project: string; workspace: string; stage: string; input: { cardId: string }; lease: { executionId: string } | null }, prev?: string): ProcessInput {
  return {
    kind: 'isolated.stage',
    phase: 'work',
    state: ISOLATED[run.stage] ?? 'info',
    title: `Izolovaný běh: ${run.stage}`,
    detail: prev ? `${prev} → ${run.stage}` : undefined,
    actor: { kind: 'agent', name: 'isolated' },
    refs: { project: run.project, workspace: run.workspace, cardId: run.input.cardId, ...(run.lease ? { executionId: run.lease.executionId } : {}) },
  };
}

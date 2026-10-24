// The office's own state changes as process events: a worker's status and tool calls, the task
// queue, and the floor's pull requests on GitHub. Pure: each takes what was and what is, and says
// what happened in between (nothing on the first look, which is a baseline, not news).

import type { GhPull, ProcessToolAction, QueueTask, WorkerInfo, WorkerStatus } from '../../shared/protocol.js';
import type { ProcessInput } from './journal.js';
import { pauseCz } from '../../shared/usage-limit.js';

const actorOf = (w: Pick<WorkerInfo, 'id' | 'name'>): ProcessInput['actor'] => ({ kind: 'worker', id: w.id, name: w.name });
const workerRefs = (w: WorkerInfo): ProcessInput['refs'] => ({
  workerId: w.id,
  ...(w.worktree?.branch ? { branch: w.worktree.branch } : {}),
  ...(w.pr ? { pr: w.pr.number, url: w.pr.url } : {}),
});

const STATUS_CZ: Record<WorkerStatus, string> = {
  starting: 'startuje',
  idle: 'čeká na zadání',
  working: 'pracuje',
  needs_input: 'čeká na člověka',
  done: 'dokončil tah',
  exited: 'proces skončil',
  offline: 'offline',
};

/** A worker changed: its turn started or ended, it needs someone, its status otherwise moved, or its tests keep failing. */
export function workerEvents(prev: WorkerInfo | undefined, next: WorkerInfo): ProcessInput[] {
  const base = { actor: actorOf(next), refs: workerRefs(next) };
  const out: ProcessInput[] = [];
  if (!prev) {
    out.push({ ...base, kind: 'worker.status', phase: 'work', state: 'info', title: `${next.name} je u stolu · ${STATUS_CZ[next.status]}` });
    return out;
  }
  if (prev.status !== next.status) {
    const s = next.status;
    if (s === 'working') out.push({ ...base, kind: 'turn.start', phase: 'work', state: 'start', title: `${next.name} začal tah` });
    else if (s === 'needs_input') out.push({ ...base, kind: 'needs.input', phase: 'work', state: 'blocked', title: `${next.name} čeká na člověka`, detail: 'Otevřete jeho terminál' });
    // A finished turn, nothing more: not passing tests, not an approved review.
    else if (s === 'done' && prev.status === 'working') out.push({ ...base, kind: 'turn.end', phase: 'work', state: 'info', title: `${next.name} dokončil tah`, detail: 'Konec tahu neznamená prošlé testy ani review' });
    else out.push({ ...base, kind: 'worker.status', phase: 'work', state: s === 'exited' ? 'wait' : 'info', title: `${next.name} ${STATUS_CZ[s]}`, detail: `${STATUS_CZ[prev.status]} → ${STATUS_CZ[s]}` });
  }
  if (next.action === 'failing' && prev.action !== 'failing')
    out.push({ ...base, kind: 'tool.use', phase: 'checks', state: 'fail', title: `${next.name}: testy nebo build opakovaně selhávají`, tool: { name: 'tests', action: 'failing' } });
  // Stopped on its provider's usage limit while its status still says working (see shared/usage-limit.ts).
  if (next.paused && (!prev.paused || prev.paused.resetsAt !== next.paused.resetsAt || prev.paused.kind !== next.paused.kind))
    out.push({ ...base, kind: 'worker.status', phase: 'work', state: 'wait', title: `${next.name} ${pauseCz(next.paused)}`, detail: `Limit poskytovatele (${next.paused.kind}): ${next.paused.line}` });
  else if (prev.paused && !next.paused && next.status !== 'exited' && next.status !== 'offline')
    out.push({ ...base, kind: 'worker.status', phase: 'work', state: 'progress', title: `${next.name} pokračuje po limitu`, detail: `${STATUS_CZ[next.status]}` });
  if (next.lost && !prev.lost)
    out.push({ ...base, kind: 'worker.status', phase: 'work', state: 'blocked', title: `${next.name} přišel o worktree`, detail: 'Čeká, až ho někdo obnoví' });
  return out;
}

/** Sent home. */
export function workerGone(prev: WorkerInfo | undefined, workerId: string): ProcessInput {
  return { kind: 'worker.status', phase: 'work', state: 'info', title: `${prev?.name ?? 'Pracovník'} odešel domů`, actor: { kind: 'worker', id: workerId, ...(prev ? { name: prev.name } : {}) }, refs: { workerId } };
}

const TOOL_ACTIONS: Record<string, ProcessToolAction> = { read: 'read', edit: 'edit', test: 'test', web: 'web', failing: 'failing' };

/** One tool call, as its provider described it (`Bash: npm test`, already cut to 80 characters). */
export function toolEvent(worker: WorkerInfo, described: string): ProcessInput {
  const m = /^([^:]{1,40}):\s*(.*)$/s.exec(described);
  const name = (m ? m[1] : described).trim() || 'tool';
  const target = m ? m[2].trim() : '';
  const action = TOOL_ACTIONS[worker.action ?? ''] ?? (/^(bash|shell|exec|run|command|terminal)/i.test(name) ? 'command' : undefined);
  return {
    kind: 'tool.use',
    phase: action === 'test' || action === 'failing' ? 'checks' : 'work',
    state: 'progress',
    title: `${worker.name}: ${name}`,
    actor: actorOf(worker),
    refs: workerRefs(worker),
    tool: { name, ...(action ? { action } : {}), ...(target ? { target } : {}) },
  };
}

/** The queue changed: a task came in, was handed to a worker, ended or was taken off. */
export function queueEvents(prev: Map<string, QueueTask> | undefined, tasks: QueueTask[]): ProcessInput[] {
  if (!prev) return [];
  const out: ProcessInput[] = [];
  const refs = (t: QueueTask): ProcessInput['refs'] => ({ task: t.id, ...(t.workerId ? { workerId: t.workerId } : {}), ...(t.branch ? { branch: t.branch } : {}), ...(t.pr ? { pr: t.pr.number, url: t.pr.url } : {}) });
  const actor = (t: QueueTask): ProcessInput['actor'] => (t.workerId ? { kind: 'worker', id: t.workerId, ...(t.workerName ? { name: t.workerName } : {}) } : { kind: 'human', name: t.addedBy });
  for (const t of tasks) {
    const was = prev.get(t.id);
    if (!was) out.push({ kind: 'queue.task', phase: 'intake', state: t.status === 'queued' ? 'wait' : 'start', title: `Úkol ve frontě: ${t.title}`, detail: `Přidal ${t.addedBy}`, actor: actor(t), refs: refs(t) });
    else if (was.status !== t.status) {
      if (t.status === 'running') out.push({ kind: 'queue.task', phase: 'intake', state: 'start', title: `Úkol přidělen: ${t.title}`, detail: t.workerName ? `Pracuje ${t.workerName}` : undefined, actor: actor(t), refs: refs(t) });
      else if (t.status === 'done') {
        const failed = t.outcome === 'failed' || t.outcome === 'exited';
        out.push({ kind: 'queue.task', phase: 'work', state: failed ? 'fail' : 'info', title: `Úkol skončil: ${t.title}`, detail: failed ? (t.error ?? `výsledek: ${t.outcome}`) : `výsledek: ${t.outcome ?? 'hotovo'} · neznamená prošlé testy`, actor: actor(t), refs: refs(t) });
      } else out.push({ kind: 'queue.task', phase: 'intake', state: 'wait', title: `Úkol zpět ve frontě: ${t.title}`, actor: actor(t), refs: refs(t) });
    }
  }
  const now = new Set(tasks.map((t) => t.id));
  for (const [id, t] of prev) if (!now.has(id)) out.push({ kind: 'queue.task', phase: 'intake', state: 'info', title: `Úkol odebrán z fronty: ${t.title}`, actor: actor(t), refs: refs(t) });
  return out;
}

const CHECK_STATE = { pass: 'ok', fail: 'fail', pending: 'wait', none: 'info' } as const;
const CHECK_CZ = { pass: 'prošlo', fail: 'selhalo', pending: 'běží', none: 'žádné' } as const;
const REVIEW: Record<string, { state: ProcessInput['state']; cz: string }> = {
  APPROVED: { state: 'ok', cz: 'schváleno' },
  CHANGES_REQUESTED: { state: 'blocked', cz: 'požadovány změny' },
  REVIEW_REQUIRED: { state: 'wait', cz: 'čeká na review' },
};

/** The floor's pull requests on GitHub changed: opened, CI moved, a review decision, merged or closed. */
export function pullEvents(prev: Map<number, GhPull> | undefined, items: GhPull[], workerOf: (p: GhPull) => WorkerInfo | undefined = () => undefined): ProcessInput[] {
  if (!prev) return [];
  const out: ProcessInput[] = [];
  for (const p of items) {
    const was = prev.get(p.number);
    const w = workerOf(p);
    const base = {
      source: 'github' as const,
      refs: { pr: p.number, url: p.url, branch: p.headRefName, ...(p.headRefOid ? { sha: p.headRefOid } : {}), ...(w ? { workerId: w.id } : {}) },
      actor: w ? actorOf(w) : ({ kind: 'human', name: p.author } as const),
    };
    const label = `PR #${p.number}`;
    if (!was) {
      if (p.state === 'OPEN') out.push({ ...base, kind: 'pr.opened', phase: 'review', state: 'start', title: `${label} otevřen: ${p.title}`, detail: `${p.headRefName} → ${p.baseRefName}` });
      else if (p.state === 'MERGED') out.push({ ...base, kind: 'pr.merged', phase: 'merge', state: 'ok', title: `${label} sloučen: ${p.title}`, detail: 'Sloučeno neznamená nasazeno' });
      continue;
    }
    if (was.checks !== p.checks && p.state === 'OPEN')
      out.push({ ...base, kind: 'pr.checks', phase: 'checks', state: CHECK_STATE[p.checks], title: `${label} CI: ${CHECK_CZ[p.checks]}`, detail: `${CHECK_CZ[was.checks]} → ${CHECK_CZ[p.checks]}` });
    if (was.reviewDecision !== p.reviewDecision && p.reviewDecision) {
      const r = REVIEW[p.reviewDecision] ?? { state: 'info' as const, cz: p.reviewDecision.toLowerCase() };
      out.push({ ...base, kind: 'pr.review', phase: 'review', state: r.state, title: `${label} review: ${r.cz}` });
    }
    if (was.state !== p.state) {
      if (p.state === 'MERGED') out.push({ ...base, kind: 'pr.merged', phase: 'merge', state: 'ok', title: `${label} sloučen: ${p.title}`, detail: 'Sloučeno neznamená nasazeno' });
      else if (p.state === 'CLOSED') out.push({ ...base, kind: 'pr.closed', phase: 'review', state: 'info', title: `${label} zavřen bez sloučení` });
      else if (p.state === 'OPEN') out.push({ ...base, kind: 'pr.opened', phase: 'review', state: 'start', title: `${label} znovu otevřen` });
    } else if (was.headRefOid && p.headRefOid && was.headRefOid !== p.headRefOid && p.state === 'OPEN')
      out.push({ ...base, kind: 'pr.updated', phase: 'review', state: 'progress', title: `${label} má nové commity`, detail: `${was.headRefOid.slice(0, 10)} → ${p.headRefOid.slice(0, 10)}` });
  }
  return out;
}

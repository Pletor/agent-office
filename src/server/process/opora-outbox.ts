// An event of Opora's outbox (GET /api/oporahub/events/stream, see Canvas's docs/oporahub-events.md)
// as a process event of the floor. Pure: what the event says, nothing guessed. An event that already
// carries the live-process fields (phase/state/title, Canvas's opora.process-event/1 extension) keeps
// them; an older Canvas's bare event is mapped by its kind. Events the office itself pushed (source
// `office`, or `github` from the office's PR board) come back on the stream too and are skipped.

import { PROCESS_PHASES, type ProcessPhase, type ProcessRefs, type ProcessState } from '../../shared/protocol.js';
import type { ProcessInput } from './journal.js';

/** One outbox event as the stream sends it (only the fields read here). */
export interface OutboxEvent {
  id?: number;
  at?: string;
  kind?: string;
  projectId?: string | null;
  workspaceId?: string | null;
  nodeId?: string | null;
  executionId?: string | null;
  stepId?: string | null;
  prNumber?: number | null;
  stage?: string | null;
  health?: string | null;
  actor?: { kind?: string; name?: string } | null;
  data?: Record<string, unknown> | null;
  source?: string | null;
  phase?: string | null;
  state?: string | null;
  title?: string | null;
  detail?: string | null;
  refs?: Record<string, unknown> | null;
  tool?: { name?: string; action?: string; target?: string } | null;
}

type Row = [ProcessPhase, ProcessState, string];

/** kind → phase, state and title, for an event that carries no process fields of its own. */
const KINDS: Record<string, Row> = {
  'lease.claimed': ['work', 'start', 'Běh převzal kartu'],
  'lease.heartbeat': ['work', 'progress', 'Běh prodloužil pronájem'],
  'lease.expired': ['work', 'fail', 'Pronájem běhu vypršel'],
  'result.reported': ['work', 'ok', 'Výsledek běhu nahlášen (neověřeno)'],
  'step.started': ['work', 'start', 'Krok plánu začal'],
  'step.done': ['work', 'ok', 'Krok plánu hotov'],
  'step.failed': ['work', 'fail', 'Krok plánu selhal'],
  'pr.linked': ['review', 'info', 'PR propojen s během'],
  'review.round': ['review', 'progress', 'Kolo review'],
  'review.finding': ['review', 'info', 'Nález review'],
  'gate.changed': ['checks', 'info', 'Brána merge se změnila'],
  'formal.result': ['checks', 'info', 'Výsledek formálního ověření'],
  'decision.created': ['intake', 'blocked', 'Čeká na rozhodnutí člověka'],
  'decision.resolved': ['intake', 'ok', 'Rozhodnutí vyřízeno'],
  'changeset.proposed': ['plan', 'info', 'Návrh plánu zapsán'],
  'changeset.accepted': ['plan', 'ok', 'Plán přijat'],
  'stage.changed': ['plan', 'info', 'Etapa karty se změnila'],
  'autorebase.done': ['merge', 'ok', 'Auto-rebase návrhu hotov'],
  'autorebase.conflict': ['merge', 'blocked', 'Auto-rebase narazil na konflikt'],
  'merge.done': ['merge', 'ok', 'PR sloučen'],
  'writeback.done': ['merge', 'ok', 'Merge zapsán zpět do plánu'],
  'card.closed': ['memory', 'ok', 'Dokončení karty potvrzeno'],
  'memory.recall': ['memory', 'info', 'Vybavení z paměti role'],
  'memory.write': ['memory', 'ok', 'Zápis do paměti role'],
  'plan.commit': ['plan', 'info', 'Commit zadání'],
};
/** A card's stage (Canvas's agent-state rule) → the wall's column. */
const STAGE: Record<string, ProcessPhase> = { plan: 'plan', proposal: 'plan', acceptance: 'plan', claim: 'intake', work: 'work', evidence: 'checks', review: 'review', pull_request: 'review', merge: 'merge', plan_writeback: 'merge' };
const HEALTH: Record<string, ProcessState> = { ok: 'progress', waiting: 'wait', blocking: 'blocked' };
const GATE: Record<string, ProcessState> = { ready: 'ok', pending: 'wait', blocked: 'blocked' };
const DECISION: Record<string, ProcessPhase> = { accept: 'plan', close_card: 'merge', review_round_cap: 'review', verification_counterexample: 'checks', verification_failed: 'checks' };
/** A review round's job kind, so the code and the security round Canvas opens together for one head read as two. */
const REVIEW_KIND: Record<string, string> = { code: 'kód', security: 'bezpečnost' };
const FORMAL_OK = new Set(['proved', 'passed', 'verified', 'ok']);
const FORMAL_FAIL = new Set(['failed', 'counterexample', 'refuted', 'error']);
const STATES = new Set<string>(['start', 'progress', 'ok', 'fail', 'wait', 'blocked', 'info']);
const ACTORS = new Set(['worker', 'human', 'agent', 'system']);

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Whether a plan step is a check (tests, verification) rather than work, by what the event says of it. */
function stepPhase(e: OutboxEvent): ProcessPhase {
  const d = e.data ?? {};
  const words = [e.stepId, d.kind, d.type, d.title, d.name, d.step].filter((x) => typeof x === 'string').join(' ');
  return /test|check|verif|ověř|kontrol|qa\b|lint|typecheck/i.test(words) ? 'checks' : 'work';
}

/** Phase, state and title from the kind (and what it carries), for a bare outbox event. */
export function classify(e: OutboxEvent): Row {
  const kind = e.kind ?? '';
  const d = e.data ?? {};
  let [phase, state, title] = KINDS[kind] ?? (['work', 'info', kind || 'Událost Opory'] as Row);
  if (kind.startsWith('step.')) {
    phase = stepPhase(e);
    const name = text(d.title) ?? text(d.name) ?? text(e.stepId);
    if (name) title = `${title}: ${name}`;
  } else if (kind === 'stage.changed' && e.stage) {
    phase = STAGE[e.stage] ?? 'plan';
    state = HEALTH[e.health ?? ''] ?? 'info';
    title = `Karta v etapě ${e.stage}`;
  } else if (kind === 'gate.changed') {
    const gate = d.gate && typeof d.gate === 'object' ? (d.gate as { status?: unknown }) : {};
    state = GATE[String(gate.status)] ?? 'info';
  } else if (kind === 'formal.result') {
    const outcome = String(d.outcome ?? '');
    state = FORMAL_OK.has(outcome) ? 'ok' : FORMAL_FAIL.has(outcome) ? 'fail' : 'info';
  } else if (kind.startsWith('decision.')) {
    phase = DECISION[String(d.decision)] ?? phase;
  } else if (kind === 'review.finding') {
    if (d.status === 'open') state = 'wait';
  } else if (kind === 'review.round' && typeof d.round === 'number') {
    title = `Kolo review ${d.round}`;
  }
  return [phase, state, title];
}

function refsOf(e: OutboxEvent): ProcessRefs {
  const out: ProcessRefs = {};
  const r = e.refs && typeof e.refs === 'object' ? e.refs : {};
  for (const k of ['project', 'workspace', 'cardId', 'executionId', 'workerId', 'branch', 'sha', 'url'] as const) {
    const v = text(r[k]);
    if (v) out[k] = v;
  }
  if (typeof r.pr === 'number') out.pr = r.pr;
  const d = e.data ?? {};
  out.project ??= text(e.projectId);
  out.workspace ??= text(e.workspaceId);
  out.cardId ??= text(e.nodeId);
  out.executionId ??= text(e.executionId);
  if (out.pr === undefined && typeof e.prNumber === 'number') out.pr = e.prNumber;
  out.sha ??= text(d.mergeSha) ?? text(d.headSha);
  out.branch ??= text(d.headRef);
  for (const k of Object.keys(out) as (keyof ProcessRefs)[]) if (out[k] === undefined) delete out[k];
  return out;
}

function withJob(title: string, job: string | undefined): string {
  return job && !title.includes(job) ? `${title} (${job})` : title;
}

/**
 * The process event an outbox event makes, or undefined when it isn't Opora's (the office's own
 * events echoed back) or isn't an event at all.
 */
export function outboxToProcess(e: OutboxEvent): ProcessInput | undefined {
  if (!e || typeof e !== 'object' || !text(e.kind)) return undefined;
  if (e.source && e.source !== 'opora') return undefined;
  const [phase, state, title] = classify(e);
  const job = e.kind === 'review.round' ? REVIEW_KIND[String(e.data?.kind)] : undefined;
  const out: ProcessInput = {
    source: 'opora',
    kind: e.kind!,
    phase: e.phase && (PROCESS_PHASES as readonly string[]).includes(e.phase) ? (e.phase as ProcessPhase) : phase,
    state: e.state && STATES.has(e.state) ? (e.state as ProcessState) : state,
    title: withJob(text(e.title) ?? title, job),
    refs: refsOf(e),
  };
  if (text(e.at)) out.at = e.at!;
  const detail = text(e.detail) ?? (e.kind === 'result.reported' ? 'Hlášeno agentem, nezávisle neověřeno' : undefined);
  if (detail) out.detail = detail;
  const a = e.actor;
  if (a && typeof a === 'object' && ACTORS.has(String(a.kind))) out.actor = { kind: a.kind as 'agent', ...(text(a.name) ? { name: a.name } : {}) };
  if (e.tool && text(e.tool.name)) out.tool = { name: e.tool.name!, ...(e.tool.action ? { action: e.tool.action as never } : {}), ...(text(e.tool.target) ? { target: e.tool.target } : {}) };
  return out;
}

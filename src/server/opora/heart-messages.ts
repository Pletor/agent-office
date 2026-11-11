// OPORA's heart speaking to a running worker (Canvas docs/navrhy/2026-11-11-platno-3-folie.md, F2): the gate's
// `ticket.direct` puts a `heart.hint|course|stop` item into the ticket's feedback, which the office reads each poll
// (bridge.ts tendTickets). Each item is typed into the worker's session once; the ids delivered are kept next to
// the execution's bundle (opora-executions/<executionId>-heart.json), so a restart never types one again. A worker
// that isn't running keeps its items for a later poll. `heart.stop` is typed first, then the run is stopped.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { emitProcess } from '../process/hub.js';
import type { ProcessInput } from '../process/journal.js';
import type { TicketFeedback } from './ticket-gate.js';

const MAX_TEXT = 4000;
type Severity = string;

export interface HeartRun {
  ticketId?: string; workerId?: string; cardId: string; cardName: string;
  execution?: { executionId: string; project: string; workspace: string };
}
export interface HeartDeps {
  /** Types into the worker's session; a string says why it couldn't (not running, gone). */
  prompt?(workerId: string, text: string, by: string): string | undefined;
  /** Stops the run (execution-stop.ts), after its stop message went in. */
  stop(reason: string): void;
}

const fileOf = (directory: string, executionId: string) => path.join(directory, `${executionId}-heart.json`);

export function deliveredHeart(directory: string, executionId: string): Set<string> {
  try { const v = JSON.parse(readFileSync(fileOf(directory, executionId), 'utf8')) as { delivered?: unknown }; return new Set(Array.isArray(v.delivered) ? v.delivered.filter((x): x is string => typeof x === 'string') : []); }
  catch { return new Set(); }
}

/** The message as the worker reads it: the heart's words, with no control characters that could leave the bracketed paste. */
export function heartText(severity: Severity, text: string): string {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, MAX_TEXT);
  return `Zpráva od srdce OPORY (${severity}): ${clean}`;
}

/** The confirmation for OPORA: the card's journal (refs.cardId = machine.cardId) and the execution; `severity` is hint, course or stop. */
export function deliveredEvent(run: HeartRun, feedbackId: string, severity: Severity): ProcessInput {
  const e = run.execution!;
  return { kind: 'worker.message.delivered', phase: 'work', state: severity === 'stop' ? 'fail' : 'info',
    title: `Zpráva srdce doručena (${severity})`,
    // opora.process-event/1 has no data field: the ids go in the detail, machine-readable.
    detail: `ticket=${run.ticketId} feedback=${feedbackId} severity=${severity}`,
    actor: { kind: 'agent', name: 'heart' },
    refs: { project: e.project, workspace: e.workspace, cardId: run.cardId, executionId: e.executionId, ...(run.workerId ? { workerId: run.workerId } : {}) } };
}

/** Delivers the ticket's new heart items to the run's worker, in order; returns whether the run was stopped. */
export function deliverHeart(floorId: string, directory: string, run: HeartRun, feedback: TicketFeedback[], deps: HeartDeps): boolean {
  if (!run.ticketId || !run.execution || !run.workerId || !deps.prompt) return false;
  const executionId = run.execution.executionId;
  const done = deliveredHeart(directory, executionId);
  for (const item of feedback) {
    const severity = item.kind.startsWith('heart.') ? item.kind.slice(6) : undefined;
    if (!severity || !item.feedbackId || done.has(item.feedbackId)) continue;
    // Not running (or gone): nothing is marked, the next poll tries again.
    if (deps.prompt(run.workerId, heartText(severity, item.text), '🫀 OPORA')) return false;
    done.add(item.feedbackId);
    // shortcut: a failed write here means a restart could type the item again; the disk being full is rarer than that worth handling.
    try { writeFileSync(fileOf(directory, executionId), JSON.stringify({ delivered: [...done] }), { mode: 0o600 }); } catch { /* see above */ }
    emitProcess(floorId, deliveredEvent(run, item.feedbackId, severity));
    if (severity === 'stop') { deps.stop(`OPORA's heart stopped “${run.cardName}”: ${item.text.slice(0, 200)}`); return true; }
  }
  return false;
}

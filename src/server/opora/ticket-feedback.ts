// A ticket's feedback between the worker and OPORA's heart, through two files next to the execution's
// private bundle (opora-executions/<executionId>.json): the worker's helper appends what it has to say
// (`feedback KIND TEXT`) and the office relays each line to the gate as `ticket.feedback`; the office
// writes the ticket's feedback with the heart's answers back, which the helper prints (`feedback`).
// The gate token never leaves the office.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FEEDBACK_KINDS, type FeedbackKind, type TicketFeedback } from './ticket-gate.js';

const MAX_TEXT = 4000;
const queueOf = (directory: string, executionId: string) => path.join(directory, `${executionId}-feedback.jsonl`);
const notesOf = (directory: string, executionId: string) => path.join(directory, `${executionId}-ticket.json`);
const split = (bundlePath: string) => ({ directory: path.dirname(bundlePath), executionId: path.basename(bundlePath, '.json') });

/** The helper's side: one item for the heart, checked before it's queued. */
export function queueFeedback(bundlePath: string, kind: string, text: string) {
  if (!FEEDBACK_KINDS.includes(kind as FeedbackKind)) throw new Error(`The kind is one of ${FEEDBACK_KINDS.join(', ')}`);
  const clean = text.trim();
  if (!clean || clean.length > MAX_TEXT) throw new Error(`The text is 1 to ${MAX_TEXT} characters`);
  const { directory, executionId } = split(bundlePath);
  appendFileSync(queueOf(directory, executionId), JSON.stringify({ kind, text: clean }) + '\n', { mode: 0o600 });
  return { queued: true, kind, note: kind === 'question' ? 'The heart answers later: run the feedback command without arguments to read its answers.' : 'The office relays it to the heart.' };
}

/** The helper's side: the ticket's feedback with the heart's answers, as the office last read it. */
export function readNotes(bundlePath: string): { feedback: TicketFeedback[] } {
  const { directory, executionId } = split(bundlePath);
  try { return JSON.parse(readFileSync(notesOf(directory, executionId), 'utf8')) as { feedback: TicketFeedback[] }; } catch { return { feedback: [] }; }
}

/** The office's side: the queued items after the first `sent` (each line is one; a broken line is skipped). */
export function pendingFeedback(directory: string, executionId: string, sent: number): { kind: FeedbackKind; text: string }[] {
  const file = queueOf(directory, executionId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(sent).map(line => {
    try { const v = JSON.parse(line) as { kind?: unknown; text?: unknown }; return FEEDBACK_KINDS.includes(v.kind as FeedbackKind) && typeof v.text === 'string' ? { kind: v.kind as FeedbackKind, text: v.text } : { kind: 'bug' as const, text: '' }; }
    catch { return { kind: 'bug' as const, text: '' }; }
  });
}

/** The office's side: the ticket's feedback as the gate gave it, for the helper to print. */
export function writeNotes(directory: string, executionId: string, feedback: TicketFeedback[]) {
  try { writeFileSync(notesOf(directory, executionId), JSON.stringify({ feedback }, null, 2), { mode: 0o600 }); } catch { /* the worker asks again later */ }
}

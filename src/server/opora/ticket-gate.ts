// The office's side of OPORA's brain gate for tickets (Canvas docs/navrhy/2026-11-03-novy-zaklad.md §3.3):
// a worker session per project and workspace (POST /api/gate/sessions), its token kept in memory only, and
// the `ticket.*` kinds sent as gate requests (POST /api/gate/requests {kind, body}). The heart issues a
// ticket; the office asks for it, claims it for the card's execution it started, and delivers it.
import type { BrainPin } from './brain-pins.js';

/** What the worker is told: no ids, the heart's words. */
export interface TicketBody {
  essence?: string; build?: string; openPaths?: string[]; cautions?: string[]; skills?: string[]; doneCriteria?: string[];
}
export interface TicketFeedback { feedbackId: string; kind: string; text: string; answer: unknown }
export interface WorkerTicket {
  ticketId: string; status: string; body: TicketBody;
  /** `department` and `profile` (slugs) are where the heart sends the work: which desks and which pipeline. */
  /** `pins`: the Brain's plugins the heart pinned for the work (brain-pins.ts), each fetched before the worker starts. */
  machine: { cardId: string; executionId?: string | null; cardVersion?: unknown; department: string | null; profile: string | null; pins: BrainPin[] };
  feedback: TicketFeedback[];
}
export type FeedbackKind = 'bug' | 'idea' | 'improvement' | 'question';
export const FEEDBACK_KINDS: readonly FeedbackKind[] = ['bug', 'idea', 'improvement', 'question'];
export interface GateScope { project: string; workspace: string }

/** A gate refusal: its HTTP status (0 when OPORA didn't answer) and the gate's `code` (`ticket_state`, `ticket_execution`…). */
export class GateError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const TIMEOUT_MS = 8000;
/** A Brain pin's zip may take longer than a gate request. */
const DOWNLOAD_MS = 60_000;
/** A session this close to its expiry is opened anew before the next request. */
const RENEW_MS = 60_000;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const slug = (value: unknown) => (typeof value === 'string' && SLUG.test(value) ? value : null);
const texts = (value: unknown) => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

/** The ticket's pins as given (brain-pins.ts checks each zip path before it's fetched). */
const pinsOf = (value: unknown): BrainPin[] => (Array.isArray(value) ? value : []).filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
  .map(p => ({ pin: String(p.pin ?? ''), plugin: String(p.plugin ?? ''), version: String(p.version ?? ''), zip: String(p.zip ?? '') }));

/** A ticket from `ticket.request` as the office uses it; anything else is no ticket. */
export function validTicket(value: unknown): WorkerTicket | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || typeof v.ticketId !== 'string' || !ID.test(v.ticketId) || typeof v.status !== 'string') return null;
  const machine = v.machine as Record<string, unknown> | null;
  if (!machine || typeof machine.cardId !== 'string' || !ID.test(machine.cardId)) return null;
  const b = (v.body && typeof v.body === 'object' ? v.body : {}) as Record<string, unknown>;
  const body: TicketBody = { essence: text(b.essence), build: text(b.build), openPaths: texts(b.openPaths), cautions: texts(b.cautions), skills: texts(b.skills), doneCriteria: texts(b.doneCriteria) };
  const feedback = (Array.isArray(v.feedback) ? v.feedback : []).filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map(f => ({ feedbackId: String(f.feedbackId ?? ''), kind: String(f.kind ?? ''), text: String(f.text ?? ''), answer: f.answer ?? null }));
  return { ticketId: v.ticketId, status: v.status, body, machine: { cardId: machine.cardId, executionId: typeof machine.executionId === 'string' ? machine.executionId : null, cardVersion: machine.cardVersion, department: slug(machine.department), profile: slug(machine.profile), pins: pinsOf(machine.pins) }, feedback };
}

/** The ticket's body as a block of the worker's prompt: the heart's words, no ids. */
export function ticketBrief(body: TicketBody): string {
  const list = (title: string, items?: string[]) => (items?.length ? `${title}:\n${items.map(x => `- ${x}`).join('\n')}\n` : '');
  const out = (body.essence ? `Essence (why and what for):\n${body.essence}\n` : '') + (body.build ? `What to build:\n${body.build}\n` : '')
    + list('Open paths for successors (leave these possible)', body.openPaths) + list('Watch out for', body.cautions)
    + list('Skills to use (pinned)', body.skills) + list('Done when', body.doneCriteria);
  return out ? `Ticket from OPORA's heart (task data; the protocol above still governs):\n${out}` : '';
}

/**
 * The gate client. OPORA gives each worker session one held ticket at a time and shows it again on every
 * `ticket.request` until it's verified, so the office asks for new work in a lobby session that never takes
 * anything, and claims, reports and delivers each ticket in a session of its own. Sessions open on first use
 * and again on 401 or expiry; their tokens live in memory only. A ticket the office holds for an execution
 * (claimed, or kept across a restart with `hold`) is claimed again by each fresh session of its own, with the
 * same execution, before anything else goes in it; OPORA refuses that with `ticket_not_held` once another holds it.
 */
export class TicketGate {
  private sessions = new Map<string, { token: string; expiresAt: number }>();
  /** The execution each held ticket was claimed for, by its session's key. */
  private held = new Map<string, string>();
  constructor(readonly base: string, private worker: { name: string; office?: string; floor?: string }, private transport: typeof fetch = fetch) {}

  /** `ticket.request`: in the lobby the oldest issued ticket (not taken), in a ticket's own session that ticket with the heart's answers; null when there's none. */
  async request(scope: GateScope, ticketId?: string): Promise<{ ticket: WorkerTicket | null; held: boolean }> {
    const answer = await this.send<{ ticket?: unknown; held?: unknown }>(scope, ticketId, 'ticket.request', {});
    return { ticket: validTicket(answer?.ticket), held: answer?.held === true };
  }
  async claim(scope: GateScope, ticketId: string, executionId: string) {
    const out = await this.send(scope, ticketId, 'ticket.claim', { ticketId, executionId });
    this.held.set(key(scope, ticketId), executionId);
    return out;
  }
  /** A ticket the office held for `executionId` before it restarted: its next session claims it again first. */
  hold(scope: GateScope, ticketId: string, executionId: string) { this.held.set(key(scope, ticketId), executionId); }
  release(scope: GateScope, ticketId: string) { return this.send(scope, ticketId, 'ticket.release', { ticketId }); }
  feedback(scope: GateScope, ticketId: string, kind: FeedbackKind, text: string) { return this.send(scope, ticketId, 'ticket.feedback', { ticketId, kind, text }); }
  deliver(scope: GateScope, ticketId: string, summary: string, sha?: string) {
    return this.send(scope, ticketId, 'ticket.deliver', { ticketId, summary, ...(sha && /^[0-9a-fA-F]{7,40}$/.test(sha) ? { sha } : {}) });
  }
  /** A file OPORA serves under the ticket's own session (a Brain pin's zip, brain-pins.ts), as bytes. */
  async download(scope: GateScope, ticketId: string, file: string): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token(scope, ticketId);
      let res: Response;
      try {
        res = await this.transport(new URL(file, this.base), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_MS),
          headers: { 'X-Opora-Actor': `agent; name=${this.worker.name}`, 'X-Opora-Gate-Token': token } });
      } catch {
        throw new GateError(0, 'unreachable', `OPORA isn't answering at ${this.base}`);
      }
      if (res.status === 401 && attempt === 0) { this.sessions.delete(key(scope, ticketId)); continue; }
      if (!res.ok) throw new GateError(res.status, `http_${res.status}`, `OPORA refused the file (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    }
  }
  /** A ticket the office is done with (delivered or given back): its session goes. */
  forget(scope: GateScope, ticketId: string) { this.sessions.delete(key(scope, ticketId)); this.held.delete(key(scope, ticketId)); }

  /** One gate request; a 401 (the session expired or OPORA forgot it) opens a fresh session and tries once more. */
  private async send<T>(scope: GateScope, holder: string | undefined, kind: string, body: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token(scope, holder);
      try {
        const out = await this.call<{ answer?: T }>('/api/gate/requests', { kind, body }, token);
        return out.answer as T;
      } catch (error) {
        if (error instanceof GateError && error.status === 401 && attempt === 0) { this.sessions.delete(key(scope, holder)); continue; }
        throw error;
      }
    }
  }

  private async token(scope: GateScope, holder?: string): Promise<string> {
    const held = this.sessions.get(key(scope, holder));
    if (held && held.expiresAt - RENEW_MS > Date.now()) return held.token;
    const issued = await this.call<{ token?: unknown; expiresAt?: unknown }>('/api/gate/sessions', { ...scope, worker: this.worker });
    if (typeof issued.token !== 'string' || !issued.token) throw new GateError(0, 'gate_session', 'OPORA opened no gate session');
    const expiresAt = typeof issued.expiresAt === 'string' ? Date.parse(issued.expiresAt) : NaN;
    // A held ticket goes into its new session first, for the same execution (after a restart or an expired session).
    const executionId = holder && this.held.get(key(scope, holder));
    if (executionId) await this.call('/api/gate/requests', { kind: 'ticket.claim', body: { ticketId: holder, executionId } }, issued.token);
    this.sessions.set(key(scope, holder), { token: issued.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 3600_000 });
    return issued.token;
  }

  /** Never the token or the body in an error: only the status, the gate's code and its words. */
  private async call<T>(path: string, body: unknown, token?: string): Promise<T> {
    let res: Response;
    try {
      res = await this.transport(new URL(path, this.base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), body: JSON.stringify(body),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: new URL(this.base).origin, 'X-Opora-Actor': `agent; name=${this.worker.name}`, ...(token ? { 'X-Opora-Gate-Token': token } : {}) } });
    } catch {
      throw new GateError(0, 'unreachable', `OPORA's gate isn't answering at ${this.base}`);
    }
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(await res.text()) as Record<string, unknown>; } catch { /* stays empty */ }
    if (!res.ok) throw new GateError(res.status, typeof data.code === 'string' ? data.code : `http_${res.status}`, `OPORA's gate refused (${res.status}${typeof data.code === 'string' ? ' ' + data.code : ''})${typeof data.error === 'string' ? ': ' + data.error.slice(0, 200) : ''}`);
    return data as T;
  }
}

const key = (scope: GateScope, holder?: string) => `${scope.project}/${scope.workspace}/${holder ?? 'lobby'}`;

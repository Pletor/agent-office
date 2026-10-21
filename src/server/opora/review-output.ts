import { createHash } from 'node:crypto';
import type { Candidate, KnownFinding, Severity } from './review-client.js';

/**
 * What a review model answered, parsed and checked here in code (never by the model) against the
 * same bounds Canvas enforces (opora_review_job_validation.py), and turned into the exact submission
 * body. The fingerprint is computed here too, so it's the same for the same bug in every round.
 */

export interface FinderSubmission {
  findings: { path: string; line?: number; severity: Severity; fingerprint: string; title: string; rationale: string }[];
  fixed: { findingId: string; rationale: string }[];
}
export interface VoterSubmission { votes: { candidateId: string; verdict: 'confirm' | 'reject'; rationale?: string }[] }
export type Checked<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const SEVERITIES: readonly Severity[] = ['important', 'nit', 'pre_existing'];
const RANK: Record<Severity, number> = { important: 3, pre_existing: 2, nit: 1 };
const MAX_FINDINGS = 50, MAX_FIXED = 100, MAX_TEXT = 4000, MAX_TITLE = 200, MAX_ERRORS = 20;

/** The answer as one JSON object: raw, or inside exactly one complete ```json fence; prose around it is refused. */
export function parseAnswer(text: string): unknown {
  const t = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(t);
  const body = fenced ? fenced[1] : t;
  if (!body.startsWith('{')) throw new Error('the answer must be one JSON object, with no prose around it');
  return JSON.parse(body);
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function text(v: unknown, limit: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= limit && !v.includes('\0') ? v.trim() : undefined;
}

/** Lower case, words only, so "Null deref of `user`!" and "null deref of user" are the same title. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
}
export function normalizeBugClass(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
/** `rv:<bug class>:<sha256(path, normalized title, bug class)>`, inside Canvas's `[A-Za-z0-9_.:/#@-]{8,160}`. */
export function findingFingerprint(path: string, title: string, bugClass: string): string {
  const cls = normalizeBugClass(bugClass) || 'bug';
  const h = createHash('sha256').update(`${path}\n${normalizeTitle(title)}\n${cls}`).digest('hex').slice(0, 24);
  return `rv:${cls}:${h}`;
}

function repoPath(v: unknown): string | undefined {
  const p = text(v, 500)?.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) return undefined;
  return p;
}

export function checkFinder(raw: unknown, known: KnownFinding[]): Checked<FinderSubmission> {
  const errors: string[] = [];
  if (!isObject(raw) || !Array.isArray(raw.findings)) return { ok: false, errors: ['the answer must be {"findings": [...], "fixed": [...]}'] };
  const fixedRaw = raw.fixed ?? [];
  if (!Array.isArray(fixedRaw)) errors.push('"fixed" must be an array');
  if (raw.findings.length > MAX_FINDINGS) errors.push(`at most ${MAX_FINDINGS} findings`);
  if (Array.isArray(fixedRaw) && fixedRaw.length > MAX_FIXED) errors.push(`at most ${MAX_FIXED} fixed claims`);
  const knownPrints = new Set(known.map((f) => f.fingerprint));
  const open = new Set(known.filter((f) => f.status === 'open').map((f) => f.findingId));
  const byPrint = new Map<string, FinderSubmission['findings'][number]>();
  raw.findings.slice(0, MAX_FINDINGS).forEach((item, i) => {
    const at = `findings[${i}]`;
    if (!isObject(item)) return void errors.push(`${at} must be an object`);
    const path = repoPath(item.path);
    const title = text(item.title, MAX_TITLE);
    const rationale = text(item.rationale, MAX_TEXT);
    const bugClass = typeof item.bugClass === 'string' ? normalizeBugClass(item.bugClass) : '';
    const severity = item.severity as Severity;
    const line = item.line;
    if (!path) errors.push(`${at}.path must be a repository-relative path`);
    if (!title) errors.push(`${at}.title must be 1-${MAX_TITLE} characters`);
    if (!rationale) errors.push(`${at}.rationale must be 1-${MAX_TEXT} characters`);
    if (!bugClass) errors.push(`${at}.bugClass must name the kind of bug (e.g. "null-deref")`);
    if (!SEVERITIES.includes(severity)) errors.push(`${at}.severity must be important, nit or pre_existing`);
    if (line !== undefined && line !== null && !(Number.isSafeInteger(line) && (line as number) >= 1 && (line as number) <= 10_000_000)) errors.push(`${at}.line must be a positive integer or null`);
    if (!path || !title || !rationale || !bugClass || !SEVERITIES.includes(severity)) return;
    const fingerprint = findingFingerprint(path, title, bugClass);
    // A known fingerprint, in any state, is never proposed again; a repeat in one answer keeps the worst severity.
    if (knownPrints.has(fingerprint)) return;
    const prior = byPrint.get(fingerprint);
    if (prior && RANK[prior.severity] >= RANK[severity]) return;
    byPrint.set(fingerprint, { path, ...(typeof line === 'number' ? { line } : {}), severity, fingerprint, title, rationale });
  });
  const fixed: FinderSubmission['fixed'] = [];
  if (Array.isArray(fixedRaw)) fixedRaw.slice(0, MAX_FIXED).forEach((item, i) => {
    const at = `fixed[${i}]`;
    if (!isObject(item) || typeof item.findingId !== 'string') return void errors.push(`${at} must be {"findingId", "rationale"}`);
    if (!open.has(item.findingId)) return void errors.push(`${at}.findingId must be one of the open known findings`);
    const rationale = text(item.rationale, MAX_TEXT);
    if (!rationale) return void errors.push(`${at}.rationale must say why it is fixed`);
    if (fixed.some((f) => f.findingId === item.findingId)) return void errors.push(`${at} repeats ${item.findingId}`);
    fixed.push({ findingId: item.findingId, rationale });
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  return { ok: true, value: { findings: [...byPrint.values()], fixed } };
}

export function checkVoter(raw: unknown, candidates: Candidate[]): Checked<VoterSubmission> {
  if (!isObject(raw) || !Array.isArray(raw.votes)) return { ok: false, errors: ['the answer must be {"votes": [...]}'] };
  const errors: string[] = [];
  const ids = new Set(candidates.map((c) => c.candidateId));
  const votes: VoterSubmission['votes'] = [];
  raw.votes.forEach((item, i) => {
    const at = `votes[${i}]`;
    if (!isObject(item) || typeof item.candidateId !== 'string') return void errors.push(`${at} must be {"candidateId", "verdict", "rationale"}`);
    if (!ids.has(item.candidateId)) return void errors.push(`${at}.candidateId ${JSON.stringify(item.candidateId.slice(0, 80))} is not a candidate`);
    if (votes.some((v) => v.candidateId === item.candidateId)) return void errors.push(`${at} votes on ${item.candidateId} twice`);
    if (item.verdict !== 'confirm' && item.verdict !== 'reject') return void errors.push(`${at}.verdict must be confirm or reject`);
    const rationale = item.rationale === undefined || item.rationale === null || item.rationale === '' ? undefined : text(item.rationale, MAX_TEXT);
    if (item.rationale && !rationale) return void errors.push(`${at}.rationale must be at most ${MAX_TEXT} characters`);
    votes.push({ candidateId: item.candidateId, verdict: item.verdict, ...(rationale ? { rationale } : {}) });
  });
  for (const id of ids) if (!votes.some((v) => v.candidateId === id) && !errors.some((e) => e.includes(id))) errors.push(`no vote on candidate ${id}`);
  if (errors.length) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  // Canvas's order: the candidates', so the same votes are the same submission (and the same digest).
  return { ok: true, value: { votes: candidates.map((c) => votes.find((v) => v.candidateId === c.candidateId)!) } };
}

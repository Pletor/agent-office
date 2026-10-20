// The run snapshot (docs/harness.md "Run snapshot and lazy reads"): when the office takes an Opora card,
// the elements the card's profile binds are pinned for that run by ID, revision and digest, with the
// exact (redacted) text of each, and written once to `<dataDir>/harness-snapshots/<runId>.json`. The
// worker's prompt embeds only the essential elements; the rest it reads by ID from this snapshot, so a
// change to the library or to any profile level during the run never reaches it. Nothing here edits a
// written snapshot: a second write of the same run is refused, and a file that no longer matches its
// digest is refused rather than served.
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarnessError } from './profiles.js';
import { credentialLike, elementNamespace } from './catalog.js';
import { addCounts, hasSecrets, redactSecrets, type RedactionCounts } from './redact.js';
import type { ResolvedHandoff } from './handoff.js';
import type { HarnessCategory, HarnessText } from '../../shared/harness.js';
import type { HarnessEffective, HarnessLevel, HarnessPath, HarnessProfile } from '../../shared/harness-cascade.js';
import type { OporaPlace } from '../../shared/opora-identity.js';

export const SNAPSHOT_SCHEMA = 'harness.snapshot/1';
/** The bounds a snapshot is built and kept under. */
export const SNAPSHOT_LIMITS = {
  /** Distinct bound resources (the handoff's limit). */
  resources: 24,
  /** One element's text, as the library lists it. */
  elementBytes: 128 * 1024,
  /** The essential (eager) texts the prompt embeds together. */
  eagerBytes: 96 * 1024,
  /** Every text of the snapshot together. */
  snapshotBytes: 1024 * 1024,
  /** Snapshots kept on disk: past this, the oldest older than a day are removed. */
  keep: 512,
  /** A snapshot older than this many days is removed when a new one is written. */
  maxAgeDays: 30,
} as const;
/** Categories a worker gets in its prompt (the minimal mandatory context); every other element is read by ID. */
export const EAGER_CATEGORIES: readonly HarnessCategory[] = ['instructions', 'rules', 'permissions', 'memory'];
const RUN_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
const DAY = 24 * 60 * 60 * 1000;

/** Where an element came from: its source and path, and each slot that binds it (level, node) — none for a handbook guide offered by ID. */
export interface SnapshotOrigin { source: string; path: string; bound: { slot: string; scope: HarnessLevel; node?: string; nodeName?: string }[] }
export interface SnapshotElement {
  id: string; ns: string; category: HarnessCategory; title: string;
  /** The registry revision and SHA-256 of the bytes as read at dispatch. */
  version: number; digest: string;
  /** SHA-256 of the text the snapshot holds (after redaction), and its size in bytes. */
  textDigest: string; bytes: number;
  /** The level of the outermost slot binding it, or null for a handbook guide that is only offered. */
  scope: HarnessLevel | null;
  mode: 'eager' | 'lazy';
  origin: SnapshotOrigin;
  redacted: boolean;
}
export interface SnapshotRedaction { element: string; kind: string; count: number }
export interface RunSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  runId: string;
  createdAt: string;
  card: OporaPlace & { nodeId: string };
  /** The Opora project and workspace the floor was bound to at dispatch, or null for an unbound floor. */
  binding: OporaPlace | null;
  task: string; level: string; path: HarnessPath; revision: number;
  /** The effective slots with provenance; scalar values redacted like texts. */
  slots: HarnessProfile['effective'];
  elements: SnapshotElement[];
  eager: string[]; lazy: string[];
  redactions: SnapshotRedaction[];
  limits: typeof SNAPSHOT_LIMITS;
  /** SHA-256 of the canonical JSON of everything above except runId and createdAt (see snapshotDigest). */
  digest: string;
}
/** What is written to disk: the snapshot and the text of each element, keyed by ID. */
export interface StoredSnapshot extends RunSnapshot { content: Record<string, string> }

export interface SnapshotInput {
  card: OporaPlace & { nodeId: string };
  binding: OporaPlace | null;
  resolved: ResolvedHandoff;
  /** Handbook guides offered by ID besides the bound elements (a bound guide keeps its binding). */
  guides?: readonly HarnessText[];
  runId?: string;
  createdAt?: string;
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit (Array.prototype.sort's default), arrays kept
 * in their order, no whitespace, strings and numbers as JSON.stringify writes them, undefined members
 * dropped. The same value always gives the same text, whatever order its keys were set in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map((v) => v === undefined ? 'null' : canonicalJson(v)).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
}

/** The snapshot's digest: SHA-256 (hex) of the canonical JSON of the snapshot without `digest`, `runId`, `createdAt` and `content`. Element texts count through their textDigest. */
export function snapshotDigest(snapshot: Omit<RunSnapshot, 'digest'> & { digest?: string; content?: unknown }): string {
  const { digest: _d, runId: _r, createdAt: _c, content: _t, ...rest } = snapshot;
  return sha256(canonicalJson(rest));
}

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

/** Redacts a text, failing closed when the redacted text still matches a pattern or the scan itself breaks. */
function redacted(text: string, what: string): { text: string; found: RedactionCounts } {
  try {
    const result = redactSecrets(text);
    if (hasSecrets(result.text)) throw new Error('a secret pattern survived redaction');
    return result;
  } catch (err) {
    throw new HarnessError(`Secret redaction failed for ${what}: ${(err as Error).message}. Nothing was handed out.`);
  }
}

/** The slots with every scalar string value redacted, counting what was found. */
function redactSlots(effective: HarnessProfile['effective'], found: RedactionCounts): HarnessProfile['effective'] {
  const out: HarnessProfile['effective'] = {};
  for (const [slot, e] of Object.entries(effective)) {
    const binding = e.binding && 'value' in e.binding && typeof e.binding.value === 'string' ? { value: addRedacted(e.binding.value, 'slot ' + slot, found) } : e.binding;
    out[slot] = { ...e, binding } as HarnessEffective;
  }
  return out;
}
function addRedacted(text: string, what: string, found: RedactionCounts): string {
  const r = redacted(text, what);
  addCounts(found, r.found);
  return r.text;
}

/**
 * Builds the snapshot of a resolved handoff, without writing anything. Fails closed (HarnessError) on
 * a credential-like file name, a text whose bytes no longer match the digest it was read with, an
 * element or the snapshot over its size limit, the essential texts over the prompt budget, or a
 * redaction that fails. The digest is deterministic: the same inputs, in any order of slots or
 * resources, give the same digest; any changed byte of any text gives another.
 */
export function buildSnapshot(input: SnapshotInput): StoredSnapshot {
  const { resolved } = input;
  if (resolved.resources.length > SNAPSHOT_LIMITS.resources) throw new HarnessError(`The effective harness exceeds ${SNAPSHOT_LIMITS.resources} resources.`);
  const elements: SnapshotElement[] = [], content: Record<string, string> = {}, redactions: SnapshotRedaction[] = [];
  const add = (entry: HarnessText, bound: SnapshotOrigin['bound'], mode: SnapshotElement['mode']) => {
    if (content[entry.id] !== undefined) return;
    if (credentialLike(entry.path)) throw new HarnessError(`Assigned harness resource has a credential-like file name and is never embedded: ${entry.id} (${entry.source} / ${entry.path}).`);
    if (sha256(entry.text) !== entry.digest) throw new HarnessError(`Assigned harness resource does not match the digest it was read with (changed while it was read, or not valid UTF-8): ${entry.id}. Take the card again.`);
    if (Buffer.byteLength(entry.text) > SNAPSHOT_LIMITS.elementBytes) throw new HarnessError(`Assigned harness resource exceeds ${SNAPSHOT_LIMITS.elementBytes / 1024} KiB: ${entry.id}.`);
    const { text, found } = redacted(entry.text, entry.id);
    for (const [kind, count] of Object.entries(found)) redactions.push({ element: entry.id, kind, count });
    const levels = bound.map((b) => b.scope);
    const scope = levels.length ? (['global', 'project', 'page', 'layer', 'area', 'sector', 'task'] as const).find((l) => levels.includes(l)) ?? null : null;
    elements.push({
      id: entry.id, ns: elementNamespace(entry.id) ?? 'source', category: entry.category, title: entry.title,
      version: entry.version, digest: entry.digest, textDigest: sha256(text), bytes: Buffer.byteLength(text),
      scope, mode, origin: { source: entry.source, path: entry.path, bound: [...bound].sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0)) }, redacted: Object.keys(found).length > 0,
    });
    content[entry.id] = text;
  };
  for (const { entry, bound } of resolved.resources) add(entry, bound, EAGER_CATEGORIES.includes(entry.category) ? 'eager' : 'lazy');
  for (const guide of input.guides ?? []) add(guide, [], 'lazy');
  const slotFound: RedactionCounts = {};
  const slots = redactSlots(resolved.profile.effective, slotFound);
  for (const [kind, count] of Object.entries(slotFound)) redactions.push({ element: 'slots', kind, count });
  elements.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  redactions.sort((a, b) => (a.element + '\0' + a.kind < b.element + '\0' + b.kind ? -1 : 1));
  const eager = elements.filter((e) => e.mode === 'eager');
  const eagerBytes = eager.reduce((n, e) => n + e.bytes, 0);
  if (eagerBytes > SNAPSHOT_LIMITS.eagerBytes) throw new HarnessError(`The essential harness instructions exceed ${SNAPSHOT_LIMITS.eagerBytes / 1024} KiB (${Math.ceil(eagerBytes / 1024)} KiB); choose smaller resources.`);
  const total = elements.reduce((n, e) => n + e.bytes, 0);
  if (total > SNAPSHOT_LIMITS.snapshotBytes) throw new HarnessError(`The run snapshot exceeds ${SNAPSHOT_LIMITS.snapshotBytes / 1024 / 1024} MiB; choose smaller resources.`);
  const runId = input.runId ?? randomUUID();
  if (!RUN_ID.test(runId)) throw new HarnessError('Invalid run id: ' + runId);
  const body: Omit<RunSnapshot, 'digest'> = {
    schema: SNAPSHOT_SCHEMA, runId, createdAt: input.createdAt ?? new Date().toISOString(),
    card: { project: input.card.project, workspace: input.card.workspace, nodeId: input.card.nodeId },
    binding: input.binding ? { project: input.binding.project, workspace: input.binding.workspace } : null,
    task: resolved.task, level: resolved.level, path: resolved.profile.path, revision: resolved.profile.revision, slots,
    elements, eager: eager.map((e) => e.id), lazy: elements.filter((e) => e.mode === 'lazy').map((e) => e.id),
    redactions, limits: SNAPSHOT_LIMITS,
  };
  return { ...body, digest: snapshotDigest(body), content };
}

/** The folder snapshots are kept in. */
export const snapshotDir = (dataDir: string) => path.join(dataDir, 'harness-snapshots');
function snapshotFile(dataDir: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new HarnessError('Invalid run id: ' + runId, 400);
  return path.join(snapshotDir(dataDir), runId + '.json');
}

/**
 * Writes a snapshot once. The file is written under a temporary name and hard-linked to its final name,
 * which fails when that name exists: a run's snapshot is never overwritten, not even by a race. Older
 * snapshots past the retention bound are removed afterwards (best effort). Throws when it can't write.
 */
export function persistSnapshot(dataDir: string, snapshot: StoredSnapshot): string {
  const file = snapshotFile(dataDir, snapshot.runId);
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
    linkSync(temp, file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new HarnessError(code === 'EEXIST' ? `Run snapshot ${snapshot.runId} already exists and is never overwritten.` : `The run snapshot could not be written (${(err as Error).message}); the card was not taken.`, code === 'EEXIST' ? 409 : 500);
  } finally {
    try { unlinkSync(temp); } catch { /* never written */ }
  }
  pruneSnapshots(dataDir, snapshot.runId);
  return file;
}

/** Removes snapshots older than the age bound, and past the count bound the oldest that are over a day old; `keep` is never removed. */
export function pruneSnapshots(dataDir: string, keep: string, now = Date.now()): void {
  try {
    const dir = snapshotDir(dataDir);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== keep + '.json').map((f) => {
      try { return { f, at: statSync(path.join(dir, f)).mtimeMs }; } catch { return undefined; }
    }).filter((x): x is { f: string; at: number } => !!x).sort((a, b) => b.at - a.at);
    const room = SNAPSHOT_LIMITS.keep - 1;
    files.forEach(({ f, at }, i) => {
      if (now - at > SNAPSHOT_LIMITS.maxAgeDays * DAY || (i >= room && now - at > DAY)) try { unlinkSync(path.join(dir, f)); } catch { /* still in use, or gone */ }
    });
  } catch { /* nothing to prune */ }
}

/**
 * Loads a run's snapshot and checks it is the one written: its schema and run id, its digest over the
 * canonical body, and every text against its textDigest. Anything else (missing, unreadable, altered)
 * throws: a damaged snapshot is never served.
 */
export function loadSnapshot(dataDir: string, runId: string): StoredSnapshot {
  const file = snapshotFile(dataDir, runId);
  let data: StoredSnapshot;
  try {
    const raw = readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw) > 4 * SNAPSHOT_LIMITS.snapshotBytes) throw new Error('too large');
    data = JSON.parse(raw) as StoredSnapshot;
  } catch (err) {
    throw new HarnessError(`Run snapshot ${runId} is unavailable (${(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : (err as Error).message}).`, 404);
  }
  const altered = () => new HarnessError(`Run snapshot ${runId} does not match its digest; it is refused, not served.`, 409);
  if (!data || data.schema !== SNAPSHOT_SCHEMA || data.runId !== runId || !Array.isArray(data.elements) || !data.content || typeof data.content !== 'object') throw altered();
  if (snapshotDigest(data) !== data.digest) throw altered();
  for (const e of data.elements) if (typeof data.content[e.id] !== 'string' || sha256(data.content[e.id]) !== e.textDigest) throw altered();
  return data;
}

/** How an element read from a snapshot compares with the library now. */
export type SnapshotReadStatus = 'unchanged' | 'changed' | 'unavailable';
export interface SnapshotRead {
  run: string; snapshot: string; id: string; title: string; category: HarnessCategory; version: number; digest: string;
  status: SnapshotReadStatus; current?: { version: number; digest: string }; note: string; text: string;
}

/**
 * One element as the run was seated with it. The text is always the snapshot's: when the library now
 * holds other content (`changed`) or none (`unavailable`), the reply says so and still hands out the
 * snapshot's text, never the new one. An ID the snapshot doesn't hold is refused.
 */
export function readFromSnapshot(snapshot: StoredSnapshot, id: string, current?: { version: number; digest: string }): SnapshotRead {
  const element = snapshot.elements.find((e) => e.id === id);
  if (!element) throw new HarnessError(`${id} is not in this run's snapshot (run ${snapshot.runId}); a worker reads only the elements it was seated with: ${snapshot.elements.map((e) => e.id).join(', ') || 'none'}.`, 404);
  const status: SnapshotReadStatus = !current ? 'unavailable' : current.digest === element.digest ? 'unchanged' : 'changed';
  const note = status === 'unchanged' ? 'Unchanged since the snapshot.'
    : status === 'changed' ? `Changed since snapshot: the library now holds revision ${current!.version} (sha256:${current!.digest}); this is revision ${element.version} (sha256:${element.digest}), the version this run was seated with. Work from this text.`
      : `No longer available in the library; this is revision ${element.version} (sha256:${element.digest}), the version this run was seated with.`;
  return { run: snapshot.runId, snapshot: snapshot.digest, id, title: element.title, category: element.category, version: element.version, digest: element.digest, status, ...(current ? { current } : {}), note, text: snapshot.content[id] };
}

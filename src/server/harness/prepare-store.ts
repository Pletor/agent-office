// The preparation records of the runner (prepare.ts, docs/harness.md "Preparation runner"): one file per
// run at `<dataDir>/harness-prepared/<runId>.json`, next to the run's scoped folder `<runId>/`. A record
// moves through a fixed state machine and every move is fenced: it is made under the record's lock,
// against the state on disk, and refused when that state isn't one it may come from, so a restarted
// office and the take that was under way can never both win (a run rolled back by a recovery can't be
// claimed after all, a run claimed can't be prepared again). A record is written whole: to a temporary
// file first and renamed over the old one, so a reader sees the record before or after a move, never half.
// The runs that aren't finished are indexed by card in `active/` (prepare-index.ts reads it), so neither
// a take nor a recovery ever reads the whole store.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarnessError } from './profiles.js';
import { withFileLock } from './lock.js';
import { snapshotDir } from './snapshot.js';
import type { Capability } from './adapters.js';
import type { RunLaunch } from './launch-scope.js';
import type { OporaPlace } from '../../shared/opora-identity.js';

export const PREPARED_SCHEMA = 'harness.prepared/1';
/**
 * planned → preparing → prepared → claimed → seated, and failed / rolledBack from any state before
 * seated. `failed` is a step that failed with its rollback not finished yet (a recovery finishes it);
 * `rolledBack` and `seated` are final.
 */
export type PrepareState = 'planned' | 'preparing' | 'prepared' | 'claimed' | 'seated' | 'failed' | 'rolledBack';
export const PREPARE_TRANSITIONS: Readonly<Record<PrepareState, readonly PrepareState[]>> = {
  planned: ['preparing', 'failed', 'rolledBack'],
  preparing: ['prepared', 'failed', 'rolledBack'],
  prepared: ['claimed', 'failed', 'rolledBack'],
  claimed: ['seated', 'failed', 'rolledBack'],
  seated: [],
  failed: ['rolledBack'],
  rolledBack: [],
};
export const STEP_IDS = ['resolve', 'availability', 'snapshot', 'adapters', 'verify'] as const;
export type StepId = typeof STEP_IDS[number];
export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'rolledBack';
export interface StepAttempt { at: string; ms: number; error: string }
/** `writes` are relative to the data dir, with forward slashes (as in a plan). */
export interface StepReport { id: StepId; status: StepStatus; detail: string; attempts: StepAttempt[]; writes: string[] }

export interface PreparedRecord {
  schema: typeof PREPARED_SCHEMA;
  runId: string;
  /** The floor's checkout, as the profile store keys it (harnessRepoKey). */
  repo: string;
  /** The floor the run was prepared for (absent in records written before it was kept): a recovery acts on its own floor's runs only. */
  floor?: string;
  card: OporaPlace & { nodeId: string };
  /** The card as the bridge read it when claiming (name, group, sector), for a run a restarted office takes over. */
  cardMeta?: { name: string; group: 'dev' | 'design'; sectorName?: string };
  state: PrepareState;
  /** One more on every write: what a reader compares to see a record moved. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** The process working on the run: a restart tells an interrupted run from one still under way by it. */
  owner: { pid: number; token: string };
  /** The adapters' scoped folder, relative to the data dir with forward slashes (one per attempt); absent in older records (then `harness-prepared/<runId>`). */
  scope?: string;
  /** The run snapshot's digest, once it was written. */
  digest?: string;
  adapters: string[];
  capabilities: Capability[];
  /** Prompt text of adapters other than `context` (which is rendered from the snapshot again). */
  contexts: Record<string, string>;
  /** What the adapters handed the worker's launch for this run only (launch-scope.ts): scoped files, never secrets. */
  launch?: RunLaunch;
  /** Each adapter's persisted state (AdapterResult.persist), for its `recover` after a restart. */
  adapterState?: Record<string, Record<string, unknown>>;
  steps: StepReport[];
  /**
   * The Opora lease the run holds once claimed (the file is private, like opora.json): a restart releases
   * it with this. Once Opora confirmed the release, the token is dropped and `released` says when.
   */
  lease?: { token?: string; agent: string; at: string; released?: string };
  /** Set just before the claim is asked for: a run found `prepared` with it may hold a lease (its token in `claimFile`). */
  claiming?: { agent: string; at: string };
  workerId?: string;
  /** The desk the worker is seated at (known from the claim on): a restart adopts a worker only at this desk. */
  deskId?: string;
  error?: { step: StepId | 'claim' | 'seat' | 'recover'; reason: string };
  rollback?: { at: string; done: string[]; errors: string[] };
  history: { state: PrepareState; at: string; note?: string }[];
}

export const RUN_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
/** This process, for `owner`: a record of another token is a restarted (or another) office's. */
export const PROCESS_TOKEN = randomUUID();
/**
 * How long a record of another process counts as that process's work in progress while its pid is alive;
 * past it the run is taken for an office that stopped (Windows reuses pids after a restart).
 */
export const OWNER_FRESH_MS = 15 * 60_000;

export const preparedDir = (dataDir: string) => path.join(dataDir, 'harness-prepared');
export function recordFile(dataDir: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new HarnessError('Invalid run id: ' + runId, 400);
  return path.join(preparedDir(dataDir), runId + '.json');
}
/** The run's folder (validated like its record's name, so an id never reaches outside the store); each adapters attempt has its own folder inside it. */
export function scopeDir(dataDir: string, runId: string): string {
  recordFile(dataDir, runId);
  return path.join(preparedDir(dataDir), runId);
}
/** The scoped folder of one adapters attempt, `<runId>/<attempt>/`: a late attempt never writes into its retry's folder. */
export const attemptScope = (dataDir: string, runId: string, attempt: number) => path.join(scopeDir(dataDir, runId), String(attempt));
/** A run's scoped folder as recorded (`scope`), or the run folder for an older record. */
export function recordScope(dataDir: string, r: Pick<PreparedRecord, 'runId' | 'scope'>): string {
  const base = scopeDir(dataDir, r.runId);
  if (!r.scope) return base;
  const at = path.resolve(dataDir, r.scope);
  return at === base || at.startsWith(base + path.sep) ? at : base;
}
/** A path as a record and a plan show it: relative to the data dir, with forward slashes. */
export const dataRel = (dataDir: string, file: string) => path.relative(dataDir, file).split(path.sep).join('/');

/** A card of a checkout, as the per-card lock and the index of active runs name it. */
export function cardKey(repo: string, card: OporaPlace & { nodeId: string }): string {
  return createHash('sha256').update([repo, card.project, card.workspace, card.nodeId].join('\0')).digest('hex').slice(0, 32);
}
/** The lock that makes looking up a card's runs and starting a new one a single step. */
export function cardLockFile(dataDir: string, repo: string, card: OporaPlace & { nodeId: string }): string {
  return path.join(preparedDir(dataDir), 'card-' + cardKey(repo, card) + '.lock');
}
/**
 * The index of the runs that aren't finished: an empty marker `<cardKey>.<runId>` per run, written
 * before its record and removed once the run is rolled back or swept. A take and a recovery read this
 * folder (a handful of names), never the whole store; a record without a marker is final.
 */
export const activeDir = (dataDir: string) => path.join(preparedDir(dataDir), 'active');
export const markerFile = (dataDir: string, r: Pick<PreparedRecord, 'repo' | 'card' | 'runId'>) => path.join(activeDir(dataDir), cardKey(r.repo, r.card) + '.' + r.runId);
/** Where the lease token goes the moment the claim answers, before the record's lock is waited for (see PreparedRecord.claiming). */
export function claimFile(dataDir: string, runId: string): string {
  recordFile(dataDir, runId);
  return path.join(preparedDir(dataDir), runId + '.claim');
}

const str = (x: unknown): x is string => typeof x === 'string';
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
/** Whether parsed JSON has the shape of a record of `runId`: an own, known state, and the fields acted on typed as they should be. */
export function validRecord(r: unknown, runId: string): r is PreparedRecord {
  if (!obj(r) || r.schema !== PREPARED_SCHEMA || r.runId !== runId || !str(r.repo) || !str(r.state) || !Object.hasOwn(PREPARE_TRANSITIONS, r.state)) return false;
  const { card, owner, lease } = r;
  if (!obj(card) || !str(card.project) || !str(card.workspace) || !str(card.nodeId)) return false;
  if (!obj(owner) || typeof owner.pid !== 'number' || !str(owner.token)) return false;
  if (typeof r.revision !== 'number' || !str(r.createdAt) || !str(r.updatedAt) || Number.isNaN(Date.parse(r.updatedAt))) return false;
  if (!Array.isArray(r.steps) || !r.steps.every((s) => obj(s) && (STEP_IDS as readonly unknown[]).includes(s.id) && Array.isArray(s.attempts) && Array.isArray(s.writes))) return false;
  if (!Array.isArray(r.history) || !Array.isArray(r.adapters) || !Array.isArray(r.capabilities) || !obj(r.contexts)) return false;
  if (lease !== undefined && (!obj(lease) || !str(lease.agent) || (lease.token !== undefined && !str(lease.token)))) return false;
  for (const k of ['floor', 'scope', 'workerId', 'deskId', 'digest'] as const) if (r[k] !== undefined && !str(r[k])) return false;
  return true;
}

/** A record as stored, or undefined when it's missing or isn't one (a damaged file is never acted on). */
export function readRecord(dataDir: string, runId: string): PreparedRecord | undefined {
  let raw: string;
  try { raw = readFileSync(recordFile(dataDir, runId), 'utf8'); } catch { return undefined; }
  return parseRecord(raw, runId);
}
export function parseRecord(raw: string, runId: string): PreparedRecord | undefined {
  try {
    const r: unknown = JSON.parse(raw);
    return validRecord(r, runId) ? r : undefined;
  } catch { return undefined; }
}

/**
 * Every readable record (newest first), and the age in ms of each file the scan couldn't read as one.
 * A full, synchronous read of the store, for tests and tools: the runner and the recovery read the
 * index of active runs instead (prepare-index.ts), never this.
 */
export function listRecords(dataDir: string): { records: PreparedRecord[]; damaged: { file: string; ageMs: number }[] } {
  let names: string[];
  try { names = readdirSync(preparedDir(dataDir)); } catch { return { records: [], damaged: [] }; }
  const records: PreparedRecord[] = [], damaged: { file: string; ageMs: number }[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const runId = name.slice(0, -5);
    if (!RUN_ID.test(runId)) continue;
    const r = readRecord(dataDir, runId);
    if (r) records.push(r);
    else try { damaged.push({ file: path.join(preparedDir(dataDir), name), ageMs: Date.now() - statSync(path.join(preparedDir(dataDir), name)).mtimeMs }); } catch { /* gone */ }
  }
  return { records: records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)), damaged };
}

/** Writes a record whole: a temporary file renamed over the old one (retried while Windows holds the old one open). */
function writeRecord(dataDir: string, record: PreparedRecord) {
  const file = recordFile(dataDir, record.runId);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temp, file); return; }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt < 50) continue;
      try { unlinkSync(temp); } catch { /* gone */ }
      throw new HarnessError(`The preparation record of run ${record.runId} could not be written (${(err as Error).message}).`, 500);
    }
  }
}

/** A move the state machine (or the record's current state) doesn't allow: the run is someone else's now, or finished. */
export class PrepareFenceError extends HarnessError {
  constructor(message: string) { super(message, 409); }
}

/** Creates a run's record in `planned` (its marker in the index first); refuses an id that exists. */
export function createRecord(dataDir: string, record: Omit<PreparedRecord, 'schema' | 'revision' | 'createdAt' | 'updatedAt' | 'history' | 'state'>, history: PreparedRecord['history'] = []): PreparedRecord {
  const at = new Date().toISOString();
  const full: PreparedRecord = { schema: PREPARED_SCHEMA, ...record, state: 'planned', revision: 1, createdAt: at, updatedAt: at, history: [{ state: 'planned', at }, ...history] };
  mkdirSync(activeDir(dataDir), { recursive: true });
  // The marker before the record, so an active record is never unindexed (a marker whose record never came is swept).
  writeFileSync(markerFile(dataDir, record), '', { mode: 0o600 });
  // `wx`: a run id is used once, whatever else runs at the same time.
  try { writeFileSync(recordFile(dataDir, record.runId), JSON.stringify(full, null, 2), { mode: 0o600, flag: 'wx' }); }
  catch (err) { throw new HarnessError(`The preparation record of run ${record.runId} could not be created (${(err as Error).message}).`, (err as NodeJS.ErrnoException).code === 'EEXIST' ? 409 : 500); }
  return full;
}

/**
 * Changes a record under its lock, against the record on disk. `to` must be a move the state machine
 * allows from the state on disk, and that state must be one of `from` (the fence): otherwise nothing is
 * written and a PrepareFenceError says what the run is now. With `to` undefined the state stays and only
 * the patch is written (a step's report). Returns the record as written.
 */
export async function updateRecord(dataDir: string, runId: string, from: readonly PrepareState[], to: PrepareState | undefined, patch: (r: PreparedRecord) => void = () => undefined, note?: string): Promise<PreparedRecord> {
  const file = recordFile(dataDir, runId);
  return withFileLock(file + '.lock', { waitMs: 5000 }, async (lease) => {
    const record = readRecord(dataDir, runId);
    if (!record) throw new PrepareFenceError(`The preparation record of run ${runId} is gone or damaged.`);
    if (!from.includes(record.state)) throw new PrepareFenceError(`Run ${runId} is ${record.state} now, not ${from.join(' or ')}: it was moved by another step or a restarted office, and is left as it is.`);
    if (to && to !== record.state && !PREPARE_TRANSITIONS[record.state].includes(to)) throw new PrepareFenceError(`Run ${runId} can't go from ${record.state} to ${to}.`);
    patch(record);
    const at = new Date().toISOString();
    if (to && to !== record.state) { record.state = to; record.history.push({ state: to, at, ...(note ? { note } : {}) }); }
    record.revision++;
    record.updatedAt = at;
    lease.verify();
    writeRecord(dataDir, record);
    if (record.state === 'rolledBack') unmark(dataDir, record);
    return record;
  });
}

/** Takes a run off the index of active runs (best effort: a marker left over is removed by the next recovery). */
export function unmark(dataDir: string, r: Pick<PreparedRecord, 'repo' | 'card' | 'runId'>) {
  try { unlinkSync(markerFile(dataDir, r)); } catch { /* gone */ }
}

/**
 * Undoes what a run left on disk: its scoped folder and its snapshot (both by run id, so a crash between
 * writing one and recording it leaves nothing behind). Returns what was removed and what couldn't be.
 */
export function removeRunFiles(dataDir: string, runId: string): { done: string[]; errors: string[] } {
  const done: string[] = [], errors: string[] = [];
  const scope = scopeDir(dataDir, runId), snapshot = path.join(snapshotDir(dataDir), runId + '.json');
  const had = existsSync(scope);
  try { rmSync(scope, { recursive: true, force: true, maxRetries: 5 }); if (had) done.push('scoped files'); }
  catch (err) { errors.push('scoped files: ' + (err as Error).message); }
  // A snapshot that can't be removed is reported, never taken for gone: the run stays `failed` and a recovery tries again.
  try { unlinkSync(snapshot); done.push('snapshot'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') errors.push('snapshot: ' + (err as Error).message); }
  try { unlinkSync(claimFile(dataDir, runId)); } catch { /* none */ }
  return { done, errors };
}

/** Removes one scoped folder of a run (a failed adapters attempt's, before it is retried). */
export function removeScope(dir: string) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

/** Removes a final record, its scoped folder and its marker (the sweep); the snapshot keeps its own retention. */
export function deleteRecord(dataDir: string, runId: string, r: Pick<PreparedRecord, 'repo' | 'card' | 'runId'> | undefined = readRecord(dataDir, runId)) {
  try { rmSync(scopeDir(dataDir, runId), { recursive: true, force: true, maxRetries: 5 }); } catch { /* next sweep */ }
  try { unlinkSync(recordFile(dataDir, runId)); } catch { /* gone */ }
  try { unlinkSync(claimFile(dataDir, runId)); } catch { /* none */ }
  if (r) unmark(dataDir, r);
}

/** Whether the process that owns a record is still there (this one counts only for runs it has under way). */
export function ownerAlive(owner: PreparedRecord['owner'], inFlight: ReadonlySet<string>, runId: string): boolean {
  if (owner.token === PROCESS_TOKEN) return inFlight.has(runId);
  try { process.kill(owner.pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

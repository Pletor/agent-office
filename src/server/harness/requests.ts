// Safe retries of harness writes, `<dataDir>/harness-requests.json`: the last writes each repository
// (or floor) accepted, each with the request that made it and the result it got. A write sent again
// gets the stored result back and changes nothing (no second save, no second audit entry): the same
// `requestId` with the same payload, or, without one, the same payload (revision included). The same
// `requestId` with another payload is a mistake, refused (409), never written.
//
// Two identical requests at once must not both write: the log's lock (lock.ts, `harness-requests.json.lock`)
// is held across the whole of a write (`exclusive`: replay check, the write, the record), so the second
// request waits, then finds the first's record and is a replay. `record` re-reads the file under that
// lock, checks the lease is still ours (fencing) and replaces the file atomically.
//
// The log is bounded, and the writer never writes a file its own reader would refuse: at most MAX_SCOPES
// scopes, MAX_BYTES in all, MAX_RECORD_BYTES a record, KEEP records a scope. Over a bound, records are evicted
// (see `fit`): replay is best effort once one was. An evicted id counts as a new write, so a stale revision
// then gets the ordinary 409. `read` still refuses an oversized or tampered file (fail closed, never overwritten).
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HarnessError } from './profiles.js';
import { FileLockError, withFileLock, type Lease, type LockOptions } from './lock.js';

/** One accepted write: the request's id (when it had one), its payload's digest, and what it got back. */
export interface HarnessRequestRecord { id?: string; digest: string; status: number; body: unknown; at: string }
interface Stored { version?: number; requests: Record<string, HarnessRequestRecord[]> }

export const HARNESS_REQUESTS_VERSION = 1;
/** Records kept for each scope, oldest dropped first. */
const KEEP = 20;
/** The most the file may hold. The writer never writes a file above it, so its own file is always one `read` accepts. */
const MAX_BYTES = 4 * 1024 * 1024;
/** The most scopes (callers x repositories or floors) kept; past it the one least recently written is dropped, so the number of scopes cannot grow without limit. */
const MAX_SCOPES = 200;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** The request's id, undefined when it has none; a malformed one is refused (400). */
export function parseRequestId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw new HarnessError('requestId must be 1–100 characters of letters, digits, "_", ".", ":" or "-".');
  return value;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}
/** The digest of the payload and of what it addresses (`target`: the node's key, '' for none), the request id left out: what decides whether two requests are the same write. */
export function requestDigest(body: Record<string, unknown>, target = ''): string {
  const { requestId: _id, ...rest } = body;
  return createHash('sha256').update(JSON.stringify([target, canonical(rest)])).digest('hex');
}
/**
 * The most one stored result may take; a bigger one is not kept (the retry then gets an ordinary answer). Ten of
 * them fit the file's cap, so ordinary use never evicts; more callers than that evict (see `record`).
 */
const MAX_RECORD_BYTES = 400 * 1024;

/** A write holds the log's lock while it waits for the profiles' or the bindings' lock, so this wait is longer than theirs. */
const LOCK_WAIT_MS = 15_000, LOCK_STALE_MS = 10_000;

export class HarnessRequests {
  private file: string;
  private lease: Lease | undefined;
  constructor(private dataDir: string, private lockOptions: LockOptions = {}) { this.file = path.join(dataDir, 'harness-requests.json'); }
  /**
   * Runs `work` holding the log's lock: the one place a write is replayed, done and recorded without
   * another office doing the same in between. Out of wait is 503 (retry in a moment). One call at a time per instance.
   */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    mkdirSync(this.dataDir, { recursive: true });
    try {
      return await withFileLock(this.file + '.lock', { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS, ...this.lockOptions }, async (lease) => {
        this.lease = lease;
        try { return await work(); } finally { this.lease = undefined; }
      });
    } catch (err) {
      if (err instanceof FileLockError) throw new HarnessError(err.code === 'timeout' ? 'Another office is writing harness settings. Try again in a moment.' : 'Another office took over the request-log lock while this write waited; retry it with the same requestId.', 503);
      throw err;
    }
  }
  private read(): Stored {
    let text: string;
    for (let attempt = 0; ; attempt++) {
      try { text = readFileSync(this.file, 'utf8'); break; }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return { requests: {} };
        if ((code === 'EPERM' || code === 'EBUSY') && attempt < 50) continue;
        throw err;
      }
    }
    try {
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('too large');
      const data = JSON.parse(text) as Stored;
      if (!object(data.requests)) throw new Error('invalid schema');
      for (const list of Object.values(data.requests)) {
        if (!Array.isArray(list) || !list.every((r) => object(r) && typeof r.digest === 'string' && Number.isSafeInteger(r.status) && typeof r.at === 'string' && (r.id === undefined || typeof r.id === 'string'))) throw new Error('invalid record');
      }
      return data;
    } catch { throw new HarnessError('The harness request log is unreadable. Repair the saved file; it has not been overwritten.', 503); }
  }
  /**
   * The result `body` got before under `scope` (a repository's or a floor's key), when it did: by its
   * `requestId`, which must carry the same payload (409 when it doesn't), or else by the payload itself.
   */
  replay(scope: string, body: Record<string, unknown>, target = ''): HarnessRequestRecord | undefined {
    const id = parseRequestId(body.requestId);
    const digest = requestDigest(body, target);
    const list = this.read().requests[scope] ?? [];
    if (id !== undefined) {
      const same = list.find((r) => r.id === id);
      if (!same) return undefined;
      if (same.digest !== digest) throw new HarnessError(`requestId ${id} was used for another request (a different payload). Choose a new requestId for a new request.`, 409);
      return same;
    }
    return [...list].reverse().find((r) => r.id === undefined && r.digest === digest);
  }
  /**
   * Remembers that `body` at `target` was accepted under `scope` with `status` and `result`, so sending it
   * again changes nothing. A result too big to keep is not kept; the write it belongs to is done either way.
   * Only inside `exclusive`: the log is re-read there, under the lock, never trusted from before it.
   */
  record(scope: string, body: Record<string, unknown>, status: number, result: unknown, target = ''): void {
    const lease = this.lease;
    if (!lease) throw new Error('HarnessRequests.record runs inside exclusive()');
    const id = parseRequestId(body.requestId);
    const entry: HarnessRequestRecord = { ...(id === undefined ? {} : { id }), digest: requestDigest(body, target), status, body: result, at: new Date().toISOString() };
    if (Buffer.byteLength(JSON.stringify(entry)) > MAX_RECORD_BYTES) return;
    const data = this.read();
    const list = (data.requests[scope] ?? []).filter((r) => id === undefined || r.id !== id);
    delete data.requests[scope];
    data.requests[scope] = [...list.slice(-(KEEP - 1)), entry];
    data.version = HARNESS_REQUESTS_VERSION;
    const text = this.fit(data, scope);
    if (text === undefined) return;
    mkdirSync(this.dataDir, { recursive: true });
    const temp = this.file + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, text, { mode: 0o600 });
    try { lease.verify(); renameSync(temp, this.file); }
    catch (err) { try { unlinkSync(temp); } catch { /* keep the error that matters */ } throw err; }
  }
  /**
   * The log as text within MAX_BYTES and MAX_SCOPES, evicting in an order that always ends: first the oldest
   * records of the scopes holding more than one, then whole scopes, the oldest write first, and `keep` (the
   * scope just written to) last of all. When even that scope alone is over the cap, undefined: nothing is stored.
   * Evicted records are forgotten: replaying them is best effort, and a retry of one is a new write.
   */
  private fit(data: Stored, keep: string): string | undefined {
    const newest = (key: string) => data.requests[key].reduce((m, r) => (r.at > m ? r.at : m), '');
    const oldestFirst = (keys: string[]) => keys.sort((x, y) => (newest(x) < newest(y) ? -1 : newest(x) > newest(y) ? 1 : 0));
    const others = () => Object.keys(data.requests).filter((key) => key !== keep);
    // Insertion order is write order (a scope written again is moved last), so a tie on `at` drops the earlier one.
    while (Object.keys(data.requests).length > MAX_SCOPES) delete data.requests[oldestFirst(others())[0]];
    let text = JSON.stringify(data, null, 2);
    while (Buffer.byteLength(text) > MAX_BYTES) {
      const many = others().filter((key) => data.requests[key].length > 1);
      if (many.length) for (const key of many) data.requests[key].shift();
      else if (data.requests[keep].length > 1) data.requests[keep].shift();
      else if (others().length) delete data.requests[oldestFirst(others())[0]];
      else return undefined;
      text = JSON.stringify(data, null, 2);
    }
    return text;
  }
}

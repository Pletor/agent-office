// Safe retries of harness writes, `<dataDir>/harness-requests.json`: the last writes each repository
// (or floor) accepted, each with the request that made it and the result it got. A write sent again
// gets the stored result back and changes nothing (no second save, no second audit entry): the same
// `requestId` with the same payload, or, without one, the same payload (revision included). The same
// `requestId` with another payload is a mistake, refused (409), never written.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HarnessError } from './profiles.js';

/** One accepted write: the request's id (when it had one), its payload's digest, and what it got back. */
export interface HarnessRequestRecord { id?: string; digest: string; status: number; body: unknown; at: string }
interface Stored { version?: number; requests: Record<string, HarnessRequestRecord[]> }

export const HARNESS_REQUESTS_VERSION = 1;
/** Records kept for each repository, oldest dropped first. */
const KEEP = 20;
const MAX_BYTES = 4 * 1024 * 1024;
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
/** The payload's digest, the request id left out: what decides whether two requests are the same write. */
export function requestDigest(body: Record<string, unknown>): string {
  const { requestId: _id, ...rest } = body;
  return createHash('sha256').update(JSON.stringify(canonical(rest))).digest('hex');
}

export class HarnessRequests {
  private file: string;
  constructor(private dataDir: string) { this.file = path.join(dataDir, 'harness-requests.json'); }
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
  replay(scope: string, body: Record<string, unknown>): HarnessRequestRecord | undefined {
    const id = parseRequestId(body.requestId);
    const digest = requestDigest(body);
    const list = this.read().requests[scope] ?? [];
    if (id !== undefined) {
      const same = list.find((r) => r.id === id);
      if (!same) return undefined;
      if (same.digest !== digest) throw new HarnessError(`requestId ${id} was used for another request (a different payload). Choose a new requestId for a new request.`, 409);
      return same;
    }
    return [...list].reverse().find((r) => r.id === undefined && r.digest === digest);
  }
  /** Remembers that `body` was accepted under `scope` with `status` and `result`, so sending it again changes nothing. */
  record(scope: string, body: Record<string, unknown>, status: number, result: unknown): void {
    const id = parseRequestId(body.requestId);
    const data = this.read();
    const list = (data.requests[scope] ?? []).filter((r) => id === undefined || r.id !== id);
    data.requests[scope] = [...list.slice(-(KEEP - 1)), { ...(id === undefined ? {} : { id }), digest: requestDigest(body), status, body: result, at: new Date().toISOString() }];
    data.version = HARNESS_REQUESTS_VERSION;
    let text = JSON.stringify(data, null, 2);
    // A log that outgrew its cap drops the oldest records of every scope until it fits; a retry of those gets an ordinary answer (409 on a stale revision).
    while (Buffer.byteLength(text) > MAX_BYTES && Object.values(data.requests).some((l) => l.length)) {
      for (const key of Object.keys(data.requests)) { data.requests[key].shift(); if (!data.requests[key].length) delete data.requests[key]; }
      text = JSON.stringify(data, null, 2);
    }
    mkdirSync(this.dataDir, { recursive: true });
    const temp = this.file + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, text, { mode: 0o600 });
    try { renameSync(temp, this.file); }
    catch (err) { try { unlinkSync(temp); } catch { /* keep the error that matters */ } throw err; }
  }
}

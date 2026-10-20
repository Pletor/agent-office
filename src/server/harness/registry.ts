// The element registry: one record per Harness element ID on this installation, kept beside the
// profiles store. It gives every element a monotonically increasing revision (bumped when the
// content digest changes) and keeps a tombstone when a listed element disappears, so an assignment
// that points at it resolves as "missing" instead of being remapped or forgotten.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HarnessCategory } from '../../shared/harness.js';

export interface ElementRecord {
  /** Namespace and source-relative key the ID was derived from, for people reading the file. */
  ns: string;
  key: string;
  /** Hash of the real root of the source instance that last listed the element; only that instance's complete listing can tombstone it. */
  root: string;
  title: string;
  path: string;
  source: string;
  category: HarnessCategory;
  /** Revision of the content listed most recently: the number that content got when first seen. New content always gets a higher number than any before. */
  revision: number;
  digest: string;
  /** Revision each distinct digest got when first seen, so content seen before keeps its number. */
  versions: Record<string, number>;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Set when a complete listing of the element's source no longer found it; cleared when it is back. */
  missingSince?: string;
}
export interface Observed { id: string; ns: string; key: string; root: string; title: string; path: string; source: string; category: HarnessCategory; digest: string }
/** The key under which a listing declares a source instance completely walked: source name + root hash. */
export const sourceInstance = (source: string, root: string) => source + '\0' + root;
interface Stored { schema: 1; elements: Record<string, ElementRecord> }

const MAX_ELEMENTS = 6000;
const MAX_VERSIONS = 32;
const MAX_BYTES = 8 * 1024 * 1024;

/** Synchronous read-modify-write per update serializes writers inside one process; atomic replacement survives restarts. */
export class HarnessRegistry {
  readonly file: string;
  private broken = false;
  constructor(dataDir: string) { this.file = path.join(dataDir, 'harness-registry.json'); }

  private read(): Stored {
    const empty: Stored = { schema: 1, elements: {} };
    let text: string;
    try { text = readFileSync(this.file, 'utf8'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty; this.broken = true; return empty; }
    try {
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('too large');
      const data = JSON.parse(text) as Stored;
      if (data.schema !== 1 || !data.elements || typeof data.elements !== 'object' || Array.isArray(data.elements)) throw new Error('invalid schema');
      return data;
    } catch {
      // Fail closed: serve no versions or tombstones and never overwrite a file someone may want to repair.
      if (!this.broken) console.warn('agent-office: harness registry is unreadable and will not be updated: ' + this.file);
      this.broken = true;
      return empty;
    }
  }
  private write(data: Stored) {
    if (this.broken) return;
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > MAX_BYTES) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, this.file);
  }

  /**
   * Record one listing. `seen` are the elements found now; `complete` holds the source instances
   * (see sourceInstance) walked to the end, so only their own absent elements become tombstones.
   * Returns the revision of every seen element; empty when the registry is unreadable.
   */
  observe(seen: Observed[], complete: Set<string>, now = new Date()): Map<string, number> {
    const data = this.read();
    const versions = new Map<string, number>();
    if (this.broken) return versions;
    const at = now.toISOString();
    const present = new Set<string>();
    let dirty = false;
    for (const o of seen) {
      present.add(o.id);
      let record = data.elements[o.id];
      if (!record) {
        record = { ns: o.ns, key: o.key, root: o.root, title: o.title, path: o.path, source: o.source, category: o.category, revision: 1, digest: o.digest, versions: { [o.digest]: 1 }, firstSeenAt: at, lastSeenAt: at };
        data.elements[o.id] = record;
        dirty = true;
      } else {
        let revision = record.versions[o.digest];
        if (revision === undefined) {
          revision = Math.max(record.revision, ...Object.values(record.versions)) + 1;
          record.versions[o.digest] = revision;
          const kept = Object.entries(record.versions).sort((a, b) => b[1] - a[1]).slice(0, MAX_VERSIONS);
          record.versions = Object.fromEntries(kept);
          dirty = true;
        }
        const next = { ...record, root: o.root, revision, digest: o.digest, title: o.title, category: o.category, path: o.path, source: o.source, lastSeenAt: record.lastSeenAt };
        delete next.missingSince;
        if (JSON.stringify(next) !== JSON.stringify(record)) dirty = true;
        next.lastSeenAt = at;
        data.elements[o.id] = record = next;
      }
      versions.set(o.id, record.revision);
    }
    for (const [id, record] of Object.entries(data.elements)) {
      if (present.has(id) || record.missingSince || !complete.has(sourceInstance(record.source, record.root))) continue;
      record.missingSince = at;
      dirty = true;
    }
    if (dirty) { this.prune(data); this.write(data); }
    else if (seen.length) this.touch(data, at);
    return versions;
  }
  /** lastSeenAt is informational; rewriting the file for it on every unchanged listing would be wasteful, so it is coalesced per hour. */
  private touch(data: Stored, at: string) {
    const stale = Object.values(data.elements).some((r) => !r.missingSince && Date.parse(at) - Date.parse(r.lastSeenAt) > 3600_000);
    if (!stale) return;
    for (const r of Object.values(data.elements)) if (!r.missingSince) r.lastSeenAt = at;
    this.write(data);
  }
  private prune(data: Stored) {
    const ids = Object.keys(data.elements);
    if (ids.length <= MAX_ELEMENTS) return;
    // Oldest tombstones go first; live records are never dropped by pruning.
    const tombstones = ids.filter((id) => data.elements[id].missingSince).sort((a, b) => Date.parse(data.elements[a].missingSince!) - Date.parse(data.elements[b].missingSince!));
    for (const id of tombstones.slice(0, ids.length - MAX_ELEMENTS)) delete data.elements[id];
  }
  lookup(id: string): ElementRecord | undefined {
    const record = this.read().elements[id];
    return record ? structuredClone(record) : undefined;
  }
}

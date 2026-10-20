// The element registry: one record per Harness element ID on this installation, kept beside the
// profiles store. It gives every element a revision that follows its content (a digest seen before
// keeps its number, new content gets a higher one) and keeps a tombstone when a listed element
// disappears, so an assignment that points at it resolves as "missing" instead of being remapped or
// forgotten. One ID can live in several places at once (two checkouts of a repository, two projects
// with the same layout), so the state that depends on the place is kept per source instance.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HARNESS_CATEGORIES, type HarnessCategory } from '../../shared/harness.js';

/** The element as one source instance (a published folder at one real root) last saw it. */
export interface ElementInstance {
  digest: string;
  revision: number;
  lastSeenAt: string;
  /** Set when a complete listing of this instance no longer found the element; cleared when it is back. */
  missingSince?: string;
}
export interface ElementRecord {
  /** Namespace and source-relative key the ID was derived from, for people reading the file. */
  ns: string;
  key: string;
  title: string;
  path: string;
  source: string;
  category: HarnessCategory;
  /** Revision each distinct digest got when first seen; new content always gets a higher number than any before. */
  versions: Record<string, number>;
  firstSeenAt: string;
  /** Keyed by the hash of the source instance's real root (see sourceInstance). */
  instances: Record<string, ElementInstance>;
}
export interface Observed { id: string; ns: string; key: string; root: string; title: string; path: string; source: string; category: HarnessCategory; digest: string }
/** What the registry knows about an ID that is not in the current listing. */
export interface Known { title: string; path: string; source: string; category: HarnessCategory; revision: number; digest: string; lastSeenAt: string; missingSince: string }
/** The key under which a listing declares a source instance completely walked: source name + root hash. */
export const sourceInstance = (source: string, root: string) => source + '\0' + root;
interface Stored { schema: 1; elements: Record<string, ElementRecord> }

const MAX_ELEMENTS = 6000;
const MAX_VERSIONS = 32;
const MAX_INSTANCES = 16;
const MAX_BYTES = 8 * 1024 * 1024;
const LOCK_STALE_MS = 10_000;
const LOCK_TRIES = 40;
const LOCK_WAIT_MS = 25;
const TOUCH_MS = 3600_000;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const own = <T>(record: Record<string, T>, key: string): T | undefined => Object.hasOwn(record, key) ? record[key] : undefined;
const text = (v: unknown, max = 1000): v is string => typeof v === 'string' && v.length <= max;
const revisionOf = (v: unknown): number | undefined => Number.isSafeInteger(v) && (v as number) > 0 ? v as number : undefined;

/**
 * Each update is one synchronous read-modify-write under a lock file, so writers in this process and
 * in other processes (the CLI, a second office) take turns; atomic replacement survives restarts.
 * A registry that cannot be read or written never breaks a listing: versions then read 0.
 */
export class HarnessRegistry {
  readonly file: string;
  private unreadable = false;
  private warned = false;
  constructor(dataDir: string) { this.file = path.join(dataDir, 'harness-registry.json'); }

  private warn(message: string) {
    if (!this.warned) console.warn('agent-office: harness registry ' + message + ': ' + this.file);
    this.warned = true;
  }
  private read(): Stored {
    const empty: Stored = { schema: 1, elements: {} };
    let raw: string;
    try { raw = readFileSync(this.file, 'utf8'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { this.unreadable = false; return empty; }
      this.unreadable = true; this.warn('cannot be read and will not be updated'); return empty;
    }
    try {
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('too large');
      const data = JSON.parse(raw) as Stored;
      if (data.schema !== 1 || !data.elements || typeof data.elements !== 'object' || Array.isArray(data.elements)) throw new Error('invalid schema');
      const elements: Record<string, ElementRecord> = {};
      for (const [id, r] of Object.entries(data.elements)) { const record = this.sanitize(r); if (record && /^[A-Za-z0-9:_.-]{1,80}$/.test(id)) elements[id] = record; }
      this.unreadable = false;
      return { schema: 1, elements };
    } catch {
      // Fail closed: serve no versions or tombstones and never overwrite a file someone may want to repair.
      this.unreadable = true; this.warn('is unreadable and will not be updated');
      return empty;
    }
  }
  /** A hand-edited or damaged record is dropped rather than poisoning every later revision. */
  private sanitize(r: unknown): ElementRecord | undefined {
    if (!r || typeof r !== 'object') return;
    const x = r as Record<string, unknown>;
    if (!text(x.ns, 40) || !text(x.key, 2000) || !text(x.title) || !text(x.path, 2000) || !text(x.source) || !(HARNESS_CATEGORIES as readonly string[]).includes(x.category as string)) return;
    if (!text(x.firstSeenAt, 40) || !ISO.test(x.firstSeenAt) || !x.versions || typeof x.versions !== 'object' || !x.instances || typeof x.instances !== 'object') return;
    const versions: Record<string, number> = {};
    for (const [digest, n] of Object.entries(x.versions as Record<string, unknown>)) { const v = revisionOf(n); if (v && /^[0-9a-f]{64}$/.test(digest)) versions[digest] = v; }
    const instances: Record<string, ElementInstance> = {};
    for (const [root, i] of Object.entries(x.instances as Record<string, unknown>)) {
      if (!i || typeof i !== 'object' || !/^[0-9a-z]{1,32}$/.test(root)) continue;
      const y = i as Record<string, unknown>, revision = revisionOf(y.revision);
      if (!revision || !text(y.digest, 64) || !text(y.lastSeenAt, 40) || !ISO.test(y.lastSeenAt)) continue;
      instances[root] = { digest: y.digest, revision, lastSeenAt: y.lastSeenAt, ...(text(y.missingSince, 40) && ISO.test(y.missingSince) ? { missingSince: y.missingSince } : {}) };
    }
    if (!Object.keys(versions).length || !Object.keys(instances).length) return;
    return { ns: x.ns, key: x.key, title: x.title, path: x.path, source: x.source, category: x.category as HarnessCategory, versions, firstSeenAt: x.firstSeenAt, instances };
  }
  private write(data: Stored): boolean {
    const json = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(json) > MAX_BYTES) { this.warn('is full and will not be updated'); return false; }
    const temp = this.file + '.' + randomUUID() + '.tmp';
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(temp, json, { mode: 0o600 });
      renameSync(temp, this.file);
      return true;
    } catch {
      try { unlinkSync(temp); } catch { /* never written */ }
      this.warn('cannot be written; revisions are not persisted');
      return false;
    }
  }
  /** An O_EXCL lock file taken with bounded waiting; a lock older than LOCK_STALE_MS is from a dead writer and is taken over. */
  private lock(): (() => void) | undefined {
    const lock = this.file + '.lock';
    for (let attempt = 0; attempt < LOCK_TRIES; attempt++) {
      try {
        mkdirSync(path.dirname(this.file), { recursive: true });
        const fd = openSync(lock, 'wx', 0o600);
        return () => { try { closeSync(fd); unlinkSync(lock); } catch { /* already gone */ } };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
        try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock); } catch { /* raced */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
      }
    }
    return undefined;
  }

  /**
   * Record one listing. `seen` are the elements found now; `complete` holds the source instances
   * (see sourceInstance) walked to the end, so only their own absent elements become tombstones.
   * Returns the revision of every seen element; empty when the registry is unreadable or locked.
   */
  observe(seen: Observed[], complete: Set<string>, now = new Date()): Map<string, number> {
    const versions = new Map<string, number>();
    const release = this.lock();
    if (!release) { this.warn('is locked by another writer; this listing is not recorded'); return versions; }
    try {
      const data = this.read();
      if (this.unreadable) return versions;
      const at = now.toISOString();
      const present = new Set<string>();
      let dirty = false;
      for (const o of seen) {
        present.add(o.id);
        let record = own(data.elements, o.id);
        if (!record) {
          record = { ns: o.ns, key: o.key, title: o.title, path: o.path, source: o.source, category: o.category, versions: {}, firstSeenAt: at, instances: {} };
          data.elements[o.id] = record;
          dirty = true;
        }
        let revision = own(record.versions, o.digest);
        if (revision === undefined) {
          revision = Math.max(0, ...Object.values(record.versions)) + 1;
          record.versions[o.digest] = revision;
          const kept = Object.entries(record.versions).sort((a, b) => b[1] - a[1]).slice(0, MAX_VERSIONS);
          record.versions = Object.fromEntries(kept);
          dirty = true;
        }
        const before = own(record.instances, o.root);
        const instance: ElementInstance = { digest: o.digest, revision, lastSeenAt: before?.lastSeenAt ?? at };
        // lastSeenAt is informational; rewriting the file for it on every unchanged listing would be wasteful, so it moves at most hourly.
        if (!before || Date.parse(at) - Date.parse(before.lastSeenAt) > TOUCH_MS) instance.lastSeenAt = at;
        if (JSON.stringify(instance) !== JSON.stringify(before) || record.title !== o.title || record.path !== o.path || record.source !== o.source || record.category !== o.category) dirty = true;
        record.instances[o.root] = instance;
        Object.assign(record, { title: o.title, path: o.path, source: o.source, category: o.category });
        if (Object.keys(record.instances).length > MAX_INSTANCES) {
          const oldest = Object.entries(record.instances).filter(([r]) => r !== o.root).sort((a, b) => Date.parse(a[1].lastSeenAt) - Date.parse(b[1].lastSeenAt))[0];
          if (oldest) { delete record.instances[oldest[0]]; dirty = true; }
        }
        versions.set(o.id, revision);
      }
      for (const [id, record] of Object.entries(data.elements)) {
        if (present.has(id)) continue;
        for (const [root, instance] of Object.entries(record.instances)) {
          if (instance.missingSince || !complete.has(sourceInstance(record.source, root))) continue;
          instance.missingSince = at;
          dirty = true;
        }
      }
      if (dirty) { this.prune(data); this.write(data); }
      return versions;
    } finally { release(); }
  }
  private prune(data: Stored) {
    const ids = Object.keys(data.elements);
    if (ids.length <= MAX_ELEMENTS) return;
    // Oldest fully tombstoned records go first; a record still present somewhere is never dropped by pruning.
    const gone = (r: ElementRecord) => Object.values(r.instances).every((i) => i.missingSince);
    const since = (r: ElementRecord) => Math.max(...Object.values(r.instances).map((i) => Date.parse(i.missingSince!)));
    const tombstones = ids.filter((id) => gone(data.elements[id])).sort((a, b) => since(data.elements[a]) - since(data.elements[b]));
    for (const id of tombstones.slice(0, ids.length - MAX_ELEMENTS)) delete data.elements[id];
  }
  /** What is known about an ID: the most recently seen instance's content; `missingSince` only when it is gone from every place it was listed. */
  lookup(id: string): Known | undefined {
    const record = own(this.read().elements, id);
    if (!record) return;
    const instances = Object.values(record.instances).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
    const latest = instances[0];
    const everywhere = instances.every((i) => i.missingSince);
    const missingSince = everywhere ? instances.map((i) => i.missingSince!).sort().at(-1)! : '';
    return { title: record.title, path: record.path, source: record.source, category: record.category, revision: latest.revision, digest: latest.digest, lastSeenAt: latest.lastSeenAt, missingSince };
  }
}

// The element registry: one record per Harness element ID on this installation, kept beside the
// profiles store. It gives every element a revision that follows its content (a digest seen before
// keeps its number, new content gets a higher one) and keeps a tombstone when a listed element
// disappears, so an assignment that points at it resolves as "missing" instead of being remapped or
// forgotten. One ID can live in several places at once (two checkouts of a repository, two projects
// with the same layout), so the state that depends on the place is kept per source instance.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HARNESS_CATEGORIES, type HarnessCategory } from '../../shared/harness.js';
import { DigestCache } from './digests.js';

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
export interface Known { ns: string; title: string; path: string; source: string; category: HarnessCategory; revision: number; digest: string; lastSeenAt: string; missingSince: string }
/** The key under which a listing declares a source instance completely walked: source name + root hash. */
export const sourceInstance = (source: string, root: string) => source + '\0' + root;
/** `roots` maps each instance hash to the real folder it stands for, so a root deleted from disk can be pruned. */
interface Stored { schema: 1; elements: Record<string, ElementRecord>; roots: Record<string, string> }

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
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/**
 * A root is pruned only when it is gone while some folder above it, other than the volume root, is still
 * there: a deleted worktree or clone. When nothing above it exists down to the volume root (an unmounted
 * disk, an absent share, a checkout that sat directly under the drive root) it is kept, conservatively.
 */
const rootGone = (dir: string) => {
  if (!path.isAbsolute(dir) || existsSync(dir)) return false;
  const volume = path.parse(dir).root;
  for (let above = path.dirname(dir); above !== volume; above = path.dirname(above)) if (existsSync(above)) return true;
  return false;
};

/**
 * Each update is one read-modify-write under a lock file, so writers in this process and in other
 * processes (the CLI, a second office) take turns; atomic replacement survives restarts. A registry
 * that cannot be read or written never breaks a listing: a revision that was not persisted reads 0.
 */
export class HarnessRegistry {
  readonly file: string;
  /** Verified content digests, persisted beside the registry so a fresh process re-hashes only changed files. */
  readonly digests: DigestCache;
  private unreadable = false;
  private warned = false;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'harness-registry.json');
    this.digests = DigestCache.at(path.join(dataDir, 'harness-digests.json'));
  }

  private warn(message: string) {
    if (!this.warned) console.warn('agent-office: harness registry ' + message + ': ' + this.file);
    this.warned = true;
  }
  private read(): Stored {
    const empty: Stored = { schema: 1, elements: {}, roots: {} };
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
      const roots: Record<string, string> = {};
      if (data.roots && typeof data.roots === 'object' && !Array.isArray(data.roots)) {
        for (const [hash, dir] of Object.entries(data.roots)) if (/^[0-9a-z]{1,32}$/.test(hash) && text(dir, 4000)) roots[hash] = dir;
      }
      this.unreadable = false;
      return { schema: 1, elements, roots };
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
  /** Atomic replacement; when the file would pass the size cap, tombstoned records are pruned first, then the write is refused. */
  private write(data: Stored): boolean {
    let json = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(json) > MAX_BYTES) {
      this.pruneTombstones(data, 0);
      json = JSON.stringify(data, null, 1);
      if (Buffer.byteLength(json) > MAX_BYTES) { this.warn('is full and will not be updated; revisions are not persisted'); return false; }
    }
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
  /**
   * An O_EXCL lock file holding the owner's token, taken with bounded asynchronous waiting (at most
   * LOCK_TRIES × LOCK_WAIT_MS, never blocking the event loop). Release deletes only a lock that still
   * carries this owner's token. A lock older than LOCK_STALE_MS is from a dead writer and is taken over;
   * a younger lock is always left alone.
   */
  private async lock(): Promise<(() => void) | undefined> {
    const lock = this.file + '.lock';
    const token = randomUUID();
    const holder = () => { try { return readFileSync(lock, 'utf8'); } catch { return undefined; } };
    for (let attempt = 0; attempt < LOCK_TRIES; attempt++) {
      try {
        mkdirSync(path.dirname(this.file), { recursive: true });
        const fd = openSync(lock, 'wx', 0o600);
        try { writeSync(fd, token); } finally { closeSync(fd); }
        return () => { try { if (holder() === token) unlinkSync(lock); } catch { /* already gone */ } };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
        try {
          const stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS, seen = holder();
          // Re-checked right before the unlink, so a lock just taken over by another writer is not the one deleted.
          if (stale && seen !== undefined && holder() === seen && Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
        } catch { /* raced */ }
        await delay(LOCK_WAIT_MS);
      }
    }
    return undefined;
  }

  /**
   * Record one listing. `seen` are the elements found now; `complete` holds the source instances
   * (see sourceInstance) walked to the end, so only their own absent elements become tombstones;
   * `roots` maps each instance hash seen to its real folder. Returns the revision of every seen
   * element; 0 for one whose revision could not be persisted (registry unreadable, locked, unwritable or full).
   */
  async observe(seen: Observed[], complete: Set<string>, roots: Record<string, string> = {}, now = new Date()): Promise<Map<string, number>> {
    const versions = new Map<string, number>();
    const release = await this.lock();
    if (!release) { this.warn('is locked by another writer; this listing is not recorded'); return versions; }
    try {
      const data = this.read();
      if (this.unreadable) return versions;
      const at = now.toISOString();
      const present = new Set<string>();
      const fresh = new Set<string>();
      let dirty = false;
      for (const [hash, dir] of Object.entries(roots)) if (data.roots[hash] !== dir && path.isAbsolute(dir)) { data.roots[hash] = dir; dirty = true; }
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
          fresh.add(o.id);
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
      if (this.pruneRoots(data)) dirty = true;
      if (dirty) {
        this.pruneTombstones(data, MAX_ELEMENTS);
        // A revision assigned in this listing but not persisted is not a revision anyone can rely on.
        if (!this.write(data)) for (const id of fresh) versions.set(id, 0);
      }
      return versions;
    } finally { release(); }
  }
  /** Instances whose root folder was deleted (see rootGone) are dropped, and with them records left without any place. */
  private pruneRoots(data: Stored): boolean {
    const gone = new Set(Object.keys(data.roots).filter((hash) => rootGone(data.roots[hash])));
    if (!gone.size) return false;
    for (const hash of gone) delete data.roots[hash];
    for (const [id, record] of Object.entries(data.elements)) {
      for (const hash of Object.keys(record.instances)) if (gone.has(hash)) delete record.instances[hash];
      if (!Object.keys(record.instances).length) delete data.elements[id];
    }
    return true;
  }
  /** Oldest fully tombstoned records go first until at most `keep` records remain; a record still present somewhere is never dropped. */
  private pruneTombstones(data: Stored, keep: number) {
    const ids = Object.keys(data.elements);
    if (ids.length <= keep) return;
    const gone = (r: ElementRecord) => Object.values(r.instances).every((i) => i.missingSince);
    const since = (r: ElementRecord) => Math.max(...Object.values(r.instances).map((i) => Date.parse(i.missingSince!)));
    const tombstones = ids.filter((id) => gone(data.elements[id])).sort((a, b) => since(data.elements[a]) - since(data.elements[b]));
    for (const id of tombstones.slice(0, ids.length - keep)) delete data.elements[id];
  }
  /** What is known about an ID: the most recently seen instance's content; `missingSince` only when it is gone from every place it was listed. */
  lookup(id: string): Known | undefined {
    const record = own(this.read().elements, id);
    if (!record) return;
    const instances = Object.values(record.instances).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
    const latest = instances[0];
    const everywhere = instances.every((i) => i.missingSince);
    const missingSince = everywhere ? instances.map((i) => i.missingSince!).sort().at(-1)! : '';
    return { ns: record.ns, title: record.title, path: record.path, source: record.source, category: record.category, revision: latest.revision, digest: latest.digest, lastSeenAt: latest.lastSeenAt, missingSince };
  }
}

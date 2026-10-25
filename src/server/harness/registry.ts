// The element registry: one record per Harness element ID on this installation, kept beside the
// profiles store. It gives every element a revision that follows its content (a digest seen before
// keeps its number, new content gets a higher one) and keeps a tombstone when a listed element
// disappears, so an assignment that points at it resolves as "missing" instead of being remapped or
// forgotten. One ID can live in several places at once (two checkouts of a repository, two projects
// with the same layout), so the state that depends on the place is kept per source instance.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HARNESS_CATEGORIES, type HarnessCategory } from '../../shared/harness.js';
import { publishRevision, readCommitted } from './commit.js';
import { DigestCache } from './digests.js';
import { acquireLock, LOCK_TIMING, type LockTiming } from './registry-lock.js';

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
/**
 * `roots` maps each instance hash to the real folder it stands for; `rootsMissing` holds the time a save
 * first found that folder deleted, so its instances are pruned only by a second consecutive save that finds it deleted too.
 */
interface Stored { schema: 2; revision: number; elements: Record<string, ElementRecord>; roots: Record<string, string>; rootsMissing: Record<string, string> }

const MAX_ELEMENTS = 6000;
/** Distinct digests remembered per element; a digest evicted from this history gets a new, higher number when its content returns. */
export const MAX_VERSIONS = 64;
const MAX_INSTANCES = 16;
const MAX_BYTES = 8 * 1024 * 1024;
const TOUCH_MS = 3600_000;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const HASH = /^[0-9a-z]{1,32}$/;
const own = <T>(record: Record<string, T>, key: string): T | undefined => Object.hasOwn(record, key) ? record[key] : undefined;
const text = (v: unknown, max = 1000): v is string => typeof v === 'string' && v.length <= max;
const revisionOf = (v: unknown): number | undefined => Number.isSafeInteger(v) && (v as number) > 0 ? v as number : undefined;
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);
/** present, gone (ENOENT/ENOTDIR), or unknown: any other failure, which never counts as deletion. */
const seeDir = (dir: string): 'present' | 'gone' | 'unknown' => {
  try { statSync(dir); return 'present'; } catch (err) { return ABSENT.has((err as NodeJS.ErrnoException).code ?? '') ? 'gone' : 'unknown'; }
};
/**
 * Whether the place (the checkout a published folder belongs to) is deleted: gone with ENOENT while some
 * folder above it, other than the volume root, is still there (a deleted worktree or clone). Anything
 * else keeps it: a permission or I/O error on it or on a folder above it, a UNC path (never checked), a
 * volume root that cannot be reached (a disk that is not mounted or a mapped network drive that is offline: on
 * Windows its drive letter), or nothing above it down to the volume root (a checkout that sat directly
 * under the drive root). On POSIX an unmounted disk leaves its mount-point parent behind, so it is only protected by the two-save rule.
 */
export const rootGone = (dir: string): boolean => {
  if (!path.isAbsolute(dir) || /^[\\/]{2}/.test(dir)) return false;
  if (seeDir(dir) !== 'gone') return false;
  const volume = path.parse(dir).root;
  if (seeDir(volume) !== 'present') return false;
  for (let above = path.dirname(dir); above !== volume; above = path.dirname(above)) {
    const state = seeDir(above);
    if (state !== 'gone') return state === 'present';
  }
  return false;
};

/**
 * Each update publishes an exclusive revision (commit.ts); a best-effort lease reduces contention
 * between this process, the CLI and another office. Readers recover committed successors after
 * interrupted main-file replacement. An unavailable registry never breaks a listing: a revision not
 * persisted reads 0.
 */
export class HarnessRegistry {
  readonly file: string;
  /** Verified content digests, persisted beside the registry so a fresh process re-hashes only changed files. */
  readonly digests: DigestCache;
  private readonly timing: LockTiming;
  private unreadable = false;
  private warned = false;
  /** The file as last read or written by this instance, with its stat signature, for lookups (one parse per batch; a changed file is re-read). */
  private cached?: Stored;
  private cachedSig = '';
  private cachedText = '';
  constructor(dataDir: string, timing: Partial<LockTiming> = {}) {
    this.file = path.join(dataDir, 'harness-registry.json');
    this.digests = DigestCache.at(path.join(dataDir, 'harness-digests.json'));
    this.timing = { ...LOCK_TIMING, ...timing };
  }

  private warn(message: string) {
    if (!this.warned) console.warn('agent-office: harness registry ' + message + ': ' + this.file);
    this.warned = true;
  }
  private read(): Stored {
    const empty: Stored = { schema: 2, revision: 0, elements: Object.create(null), roots: Object.create(null), rootsMissing: Object.create(null) };
    this.cached = undefined;
    this.cachedSig = this.signature();
    this.cachedText = '';
    try {
      const committed = readCommitted(this.file, (raw) => this.parse(raw));
      this.cachedText = committed.text;
      this.unreadable = false;
      return this.cached = committed.value ?? empty;
    } catch {
      this.unreadable = true; this.warn('is unreadable and will not be updated');
      return empty;
    }
  }
  private parse(raw: string): Stored {
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('too large');
    const data = JSON.parse(raw);
    if (!data || (data.schema !== 1 && data.schema !== 2) || !data.elements || typeof data.elements !== 'object' || Array.isArray(data.elements)) throw new Error('invalid schema');
    const revision = data.schema === 1 ? 0 : data.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('invalid revision');
    const elements: Record<string, ElementRecord> = Object.create(null);
    for (const [id, r] of Object.entries(data.elements)) { const record = this.sanitize(r); if (record && /^[A-Za-z0-9:_.-]{1,80}$/.test(id)) elements[id] = record; }
    const roots: Record<string, string> = Object.create(null), rootsMissing: Record<string, string> = Object.create(null);
    if (data.roots && typeof data.roots === 'object' && !Array.isArray(data.roots)) {
      for (const [hash, dir] of Object.entries(data.roots)) if (HASH.test(hash) && text(dir, 4000)) roots[hash] = dir;
    }
    if (data.rootsMissing && typeof data.rootsMissing === 'object' && !Array.isArray(data.rootsMissing)) {
      for (const [hash, at] of Object.entries(data.rootsMissing)) if (roots[hash] && text(at, 40) && ISO.test(at)) rootsMissing[hash] = at;
    }
    return { schema: 2, revision, elements, roots, rootsMissing };
  }
  /** A hand-edited or damaged record is dropped rather than poisoning every later revision. */
  private sanitize(r: unknown): ElementRecord | undefined {
    if (!r || typeof r !== 'object') return;
    const x = r as Record<string, unknown>;
    if (!text(x.ns, 40) || !text(x.key, 2000) || !text(x.title) || !text(x.path, 2000) || !text(x.source) || !(HARNESS_CATEGORIES as readonly string[]).includes(x.category as string)) return;
    if (!text(x.firstSeenAt, 40) || !ISO.test(x.firstSeenAt) || !x.versions || typeof x.versions !== 'object' || !x.instances || typeof x.instances !== 'object') return;
    const versions: Record<string, number> = {};
    for (const [digest, n] of Object.entries(x.versions as Record<string, unknown>)) { const v = revisionOf(n); if (v && /^[0-9a-f]{64}$/.test(digest)) versions[digest] = v; }
    const instances: Record<string, ElementInstance> = Object.create(null);
    for (const [root, i] of Object.entries(x.instances as Record<string, unknown>)) {
      if (!i || typeof i !== 'object' || !HASH.test(root)) continue;
      const y = i as Record<string, unknown>, revision = revisionOf(y.revision);
      if (!revision || !text(y.digest, 64) || !text(y.lastSeenAt, 40) || !ISO.test(y.lastSeenAt)) continue;
      instances[root] = { digest: y.digest, revision, lastSeenAt: y.lastSeenAt, ...(text(y.missingSince, 40) && ISO.test(y.missingSince) ? { missingSince: y.missingSince } : {}) };
    }
    if (!Object.keys(versions).length || !Object.keys(instances).length) return;
    return { ns: x.ns, key: x.key, title: x.title, path: x.path, source: x.source, category: x.category as HarnessCategory, versions, firstSeenAt: x.firstSeenAt, instances };
  }
  private signature(): string {
    let directory = '';
    try { directory = String(statSync(path.dirname(this.file), { bigint: true }).mtimeNs); } catch { /* absent */ }
    try { const s = statSync(this.file, { bigint: true }); return [directory, s.ino, s.size, s.mtimeNs].join(':'); } catch { return directory; }
  }
  /** Preserve the exact legacy bytes before the first schema-2 publication. Never replace a backup. */
  private backupLegacy() {
    if (!this.cachedText || JSON.parse(this.cachedText).schema !== 1) return;
    const backup = this.file + '.v1.' + createHash('sha256').update(this.cachedText).digest('hex') + '.bak';
    let fd: number;
    try { fd = openSync(backup, 'wx', 0o600); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(backup, 'utf8') !== this.cachedText) throw err;
      return;
    }
    try { writeSync(fd, this.cachedText); fsyncSync(fd); } finally { closeSync(fd); }
  }
  /** Exclusive revision publication is authoritative; the lease only reduces contention. */
  private async write(data: Stored, fence: () => boolean): Promise<boolean> {
    if (!Number.isSafeInteger(data.revision + 1)) return false;
    data.revision++;
    let json = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(json) > MAX_BYTES) {
      this.pruneTombstones(data, 0);
      json = JSON.stringify(data, null, 1);
      if (Buffer.byteLength(json) > MAX_BYTES) { this.warn('is full and will not be updated; revisions are not persisted'); return false; }
    }
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      this.backupLegacy();
      await publishRevision(this.file, data.revision, this.cachedText, json, {
        fence: () => { if (!fence()) throw new Error('lost lease'); },
        revisionOf: (raw) => { try { return this.parse(raw).revision; } catch { return undefined; } },
      });
      // A later writer may already have published while replacing the main file awaited a retry.
      this.cached = undefined;
      return true;
    } catch {
      this.warn('cannot be committed; revisions are not persisted');
      return false;
    }
  }

  /**
   * Record one listing. `seen` are the elements found now; `complete` holds the source instances
   * (see sourceInstance) walked to the end, so only their own absent elements become tombstones;
   * `roots` maps each instance hash seen to the real folder of the place it belongs to (the checkout, or
   * the published folder itself when it has no boundary). Returns the revision of every seen element; 0
   * for one whose revision could not be persisted (registry unwritable or full), and 0 for all of them
   * when the registry could not be read or locked.
   */
  async observe(seen: Observed[], complete: Set<string>, roots: Record<string, string> = {}, now = new Date()): Promise<Map<string, number>> {
    const versions = new Map<string, number>();
    const held = await acquireLock(this.file + '.lock', this.timing);
    if (!held) { this.warn('lock could not be taken (held by another writer, or the folder is not writable); this listing is not recorded'); return versions; }
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
          record = { ns: o.ns, key: o.key, title: o.title, path: o.path, source: o.source, category: o.category, versions: Object.create(null), firstSeenAt: at, instances: Object.create(null) };
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
      held.renew();
      if (this.pruneRoots(data, at)) dirty = true;
      if (dirty) {
        this.pruneTombstones(data, MAX_ELEMENTS);
        held.renew();
        // Fencing: a lock claimed from this writer meanwhile (it looked stale) means another writer owns the file now.
        if (!held.valid()) { this.warn('lock was taken over during this update; this listing is not recorded'); this.cached = undefined; for (const id of fresh) versions.set(id, 0); return versions; }
        // A revision assigned in this listing but not persisted is not a revision anyone can rely on.
        if (!await this.write(data, () => held.valid())) { this.cached = undefined; for (const id of fresh) versions.set(id, 0); }
      }
      return versions;
    } finally { held.release(); }
  }
  /**
   * Instances whose root folder is deleted (see rootGone) on this save and was already found deleted on the
   * previous save are dropped, and with them records left without any place. A single sighting is only
   * recorded (`rootsMissing`), and is cleared when the folder is back or cannot be checked.
   */
  private pruneRoots(data: Stored, at: string): boolean {
    let dirty = false;
    const gone = new Set<string>();
    for (const hash of Object.keys(data.roots)) {
      if (rootGone(data.roots[hash])) {
        if (data.rootsMissing[hash]) gone.add(hash);
        else { data.rootsMissing[hash] = at; dirty = true; }
      } else if (data.rootsMissing[hash]) { delete data.rootsMissing[hash]; dirty = true; }
    }
    if (!gone.size) return dirty;
    for (const hash of gone) { delete data.roots[hash]; delete data.rootsMissing[hash]; }
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
  /** The file as last read or written here, parsed once per batch of lookups; one stat per lookup tells whether another process wrote it since. */
  private current(): Stored { return this.cached && this.signature() === this.cachedSig ? this.cached : this.read(); }
  /**
   * Whether the registry has recorded `digest` for `id`: what a cached digest must pass before a listing
   * may reuse it. False when the registry cannot be read (nothing can be verified against it).
   */
  knows(id: string, digest: string): boolean {
    const record = own(this.current().elements, id);
    return !!record && own(record.versions, digest) !== undefined;
  }
  /** What is known about an ID: the most recently seen instance's content; `missingSince` only when it is gone from every place it was listed. */
  lookup(id: string): Known | undefined {
    const record = own(this.current().elements, id);
    if (!record) return;
    const instances = Object.values(record.instances).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
    const latest = instances[0];
    const everywhere = instances.every((i) => i.missingSince);
    const missingSince = everywhere ? instances.map((i) => i.missingSince!).sort().at(-1)! : '';
    return { ns: record.ns, title: record.title, path: record.path, source: record.source, category: record.category, revision: latest.revision, digest: latest.digest, lastSeenAt: latest.lastSeenAt, missingSince };
  }
}

// Verified content digests keyed by path and file identity (dev:ino:size:mtimeNs), so a listing re-reads
// only edited files. With a data dir the cache is persisted beside the registry (`harness-digests.json`),
// so a fresh process (the CLI, a restarted office) does not hash every unchanged file again. It is a
// cache, never an authority: a read always returns the digest of the bytes actually read, and a stale
// entry only costs one re-hash. The file holds paths and digests, never content.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_ENTRIES = 4000;
const MAX_BYTES = 2 * 1024 * 1024;
const ENTRY = /^[0-9:]{1,80} [0-9a-f]{64}$/;
interface Stored { schema: 1; files: Record<string, string> }

export class DigestCache {
  /** One cache per file in this process, shared by every registry instance over the same data dir. */
  private static shared = new Map<string, DigestCache>();
  static at(file: string): DigestCache {
    let cache = DigestCache.shared.get(file);
    if (!cache) DigestCache.shared.set(file, cache = new DigestCache(file));
    return cache;
  }
  /** An in-memory cache for a library without a data dir. */
  static memory(): DigestCache { return new DigestCache(''); }

  private entries = new Map<string, { key: string; digest: string }>();
  private loaded = false;
  private dirty = false;
  private constructor(readonly file: string) {}

  private load() {
    this.loaded = true;
    if (!this.file) return;
    try {
      const raw = readFileSync(this.file, 'utf8');
      if (Buffer.byteLength(raw) > MAX_BYTES) return;
      const data = JSON.parse(raw) as Stored;
      if (data.schema !== 1 || !data.files || typeof data.files !== 'object' || Array.isArray(data.files)) return;
      for (const [file, entry] of Object.entries(data.files).slice(-MAX_ENTRIES)) {
        if (typeof entry !== 'string' || !ENTRY.test(entry) || typeof file !== 'string' || file.length > 4000) continue;
        const [key, digest] = entry.split(' ');
        this.entries.set(file, { key, digest });
      }
    } catch { /* absent or damaged: start empty; it is only a cache */ }
  }
  /** The digest recorded for this path under exactly this file identity, else nothing. A hit is refreshed as most recently used. */
  get(file: string, key: string): string | undefined {
    if (!this.loaded) this.load();
    const cached = this.entries.get(file);
    if (cached?.key !== key) return undefined;
    this.entries.delete(file);
    this.entries.set(file, cached);
    return cached.digest;
  }
  set(file: string, key: string, digest: string) {
    if (!this.loaded) this.load();
    if (this.entries.size >= MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(file, { key, digest });
    this.dirty = true;
  }
  /** Persist new entries (best effort, atomic replacement, no lock: a lost race only costs a re-hash). */
  flush() {
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    const files: Record<string, string> = {};
    for (const [file, { key, digest }] of this.entries) files[file] = key + ' ' + digest;
    const temp = this.file + '.' + randomUUID() + '.tmp';
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(temp, JSON.stringify({ schema: 1, files } satisfies Stored), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch { try { unlinkSync(temp); } catch { /* never written */ } }
  }
}

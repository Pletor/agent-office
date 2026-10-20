// The harness profiles store, `<dataDir>/harness-profiles.json`: one layer per level of the cascade
// (shared/harness-cascade.ts), one revision for all of them, and an audit trail of the saves.
//
// Format (version 2, docs/harness.md "Store format and rollback"). `layers` is the same map the
// 3-level store wrote, with the same keys for the levels it had, so a file from before loads as it
// is and a file from now still loads there:
//   global                      the global layer
//   repo:<sha256 of checkout>   the project (repository) layer
//   task:<repo>:<task key>      a task's layer (the key is the Opora key, or a custom id)
//   node:<repo>:<node key>      a page's, layer's, area's or sector's layer (new in version 2)
// A task: layer the 3-level store wrote for a node that the canvas now places above the task level is
// read as that level's layer (when it has no node: layer), so nothing a version 1 file assigned goes
// missing. That lift is a one-time migration: while the file is version 1 every task: key may be one,
// and the save that makes it version 2 lists them in `legacyTasks`; a task: key version 2 writes is a
// task's layer and nothing else, whatever the canvas makes of the card later. A save at the lifted level
// writes the node: key, takes the key off `legacyTasks` and leaves the task: key as it was for a
// rollback to version 1 (docs/harness.md "Store format and rollback").
// `version`, `audit` and `legacyTasks` are new in version 2; a reader that doesn't know them ignores them.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { emptyLayers, harnessLevel, pathNode, resolveHarness, HARNESS_LEVELS, type HarnessLayer, type HarnessLevel, type HarnessPath, type HarnessProfile } from '../../shared/harness-cascade.js';

export class HarnessError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function parseHarnessLayer(value: unknown): HarnessLayer {
  if (!object(value) || Object.keys(value).length > 64) throw new HarnessError('A layer must be an object with at most 64 slots.');
  for (const [key, binding] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new HarnessError('Invalid slot name: ' + key);
    if (binding === null) continue;
    if (!object(binding) || Object.keys(binding).length !== 1) throw new HarnessError('Each slot needs exactly {resource: id}, {value: scalar}, or null.');
    if (typeof binding.resource === 'string' && binding.resource.length > 0 && binding.resource.length <= 100) continue;
    const v = binding.value;
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 4000)) continue;
    throw new HarnessError('Invalid binding for ' + key);
  }
  return structuredClone(value) as HarnessLayer;
}

/** One save: which level and node changed, into which revision, by whom, and the slots the layer names now. */
export interface HarnessAudit {
  at: string;
  revision: number;
  level: HarnessLevel;
  /** The node's key for a level below the project; '' for global and the project. */
  node: string;
  /** The repository's key (the hash in `repo:<hash>`) for a level below global; absent for global and for entries from before it was recorded. */
  repo?: string;
  by: string;
  /** The slot names the layer sets after the save; [] when the layer was removed (everything inherits again). */
  slots: string[];
}
/** The store's version this code writes. Version 1 (no field) is the 3-level store. */
export const HARNESS_STORE_VERSION = 2;
/** Audit entries kept, oldest dropped first. */
const AUDIT_KEEP = 200;
/**
 * How long a save waits for another office process's lock before giving up (ms), and how old a lock is
 * stale (a crashed holder's). A save holds the lock for one read and one write, milliseconds; the stale
 * age must stay far above that, or a slow holder's lock would be taken over under it.
 */
const LOCK_WAIT_MS = 3000, LOCK_STALE_MS = 10_000;
interface Stored { version?: number; revision: number; layers: Record<string, HarnessLayer>; audit?: HarnessAudit[]; legacyTasks?: string[] }

/** What a view or a save addresses: a task id (the 3-level form), or the way down to a node (shared/harness-hierarchy.ts). */
export type HarnessTarget = string | HarnessPath;
function asPath(target: HarnessTarget): HarnessPath {
  if (typeof target !== 'string') return target;
  return target ? [{ level: 'task', node: target }] : [];
}

/**
 * Reads are plain reads of the file; a save is read-check-write under an exclusive lock file, so two
 * office processes on one data directory never lose each other's writes; atomic replacement survives restarts.
 */
export class HarnessProfiles {
  private file: string;
  private lock: string;
  constructor(private dataDir: string) { this.file = path.join(dataDir, 'harness-profiles.json'); this.lock = this.file + '.lock'; }
  private read(): Stored {
    let text: string;
    // Windows refuses a read for a moment while another process replaces the file. The read is synchronous,
    // so this is a short spin (tens of attempts, no sleep): it covers the rename itself, not a slow writer.
    for (let attempt = 0; ; attempt++) {
      try { text = readFileSync(this.file, 'utf8'); break; }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return { revision: 0, layers: {} };
        if ((code === 'EPERM' || code === 'EBUSY') && attempt < 50) continue;
        throw err;
      }
    }
    try {
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('too large');
      const data = JSON.parse(text) as Stored;
      if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !object(data.layers)) throw new Error('invalid schema');
      if (data.version !== undefined && (!Number.isSafeInteger(data.version) || data.version < 1 || data.version > HARNESS_STORE_VERSION)) throw new Error('unknown store version');
      for (const layer of Object.values(data.layers)) parseHarnessLayer(layer);
      if (data.audit !== undefined && !Array.isArray(data.audit)) throw new Error('invalid audit');
      if (data.audit) data.audit = data.audit.filter((a): a is HarnessAudit => object(a) && typeof a.at === 'string' && Number.isSafeInteger(a.revision) && typeof a.level === 'string' && typeof a.node === 'string' && typeof a.by === 'string' && Array.isArray(a.slots) && a.slots.every((s) => typeof s === 'string') && (a.repo === undefined || typeof a.repo === 'string'));
      if (data.legacyTasks !== undefined && !(Array.isArray(data.legacyTasks) && data.legacyTasks.every((k) => typeof k === 'string'))) throw new Error('invalid legacyTasks');
      return data;
    } catch { throw new HarnessError('Harness profiles are unreadable. Repair the saved file; it has not been overwritten.', 503); }
  }
  private repoKey(repo: string) {
    const dir = path.resolve(repo);
    return createHash('sha256').update(process.platform === 'win32' ? dir.toLowerCase() : dir).digest('hex');
  }
  /** The store key of a level on the path; undefined for a level below the project the path doesn't go through. */
  private key(repo: string, path: HarnessPath, level: HarnessLevel): string | undefined {
    if (level === 'global') return 'global';
    const repoKey = this.repoKey(repo);
    if (level === 'project') return 'repo:' + repoKey;
    const node = pathNode(path, level)?.node;
    if (node === undefined) return undefined;
    if (node.length > 500 || /[\x00-\x1f]/.test(node)) throw new HarnessError('Invalid task ID');
    return (level === 'task' ? 'task:' : 'node:') + repoKey + ':' + node;
  }
  /**
   * The task: key the 3-level store gave the node at `level`, which the canvas now puts above the task
   * level, when that key is still the version 1 store's to lift: any task: key while the file is version 1,
   * afterwards only the ones listed in `legacyTasks`. A task: key version 2 wrote is never one.
   */
  private legacyKey(data: Stored, repo: string, path: HarnessPath, level: HarnessLevel): string | undefined {
    const node = pathNode(path, level);
    if (!node || level === 'task') return undefined;
    const key = this.key(repo, [{ level: 'task', node: node.node }], 'task')!;
    const lifts = data.version === undefined ? key in data.layers : (data.legacyTasks ?? []).includes(key);
    return lifts ? key : undefined;
  }
  private assemble(data: Stored, repo: string, path: HarnessPath): HarnessProfile {
    const layers = emptyLayers();
    for (const level of HARNESS_LEVELS) {
      const key = this.key(repo, path, level), legacy = this.legacyKey(data, repo, path, level);
      const layer = (key && data.layers[key]) || (legacy && data.layers[legacy]);
      if (layer) layers[level] = layer;
    }
    return { revision: data.revision, path, layers, effective: resolveHarness(layers, path) };
  }
  /** The levels' own views and the effective result down `target`. */
  view(repo: string, target: HarnessTarget = ''): HarnessProfile {
    const path = asPath(target);
    for (const level of HARNESS_LEVELS) this.key(repo, path, level);
    return this.assemble(this.read(), repo, path);
  }
  /**
   * The latest saves, newest first, that a reader of `repo` may see: the repository's own saves below
   * global; with `everything` (an administrator) also global saves, other repositories' and entries from
   * before the repository was recorded. Without `repo`, everything.
   */
  audit(limit = 20, repo?: string, everything = true): HarnessAudit[] {
    const mine = repo === undefined ? undefined : this.repoKey(repo);
    const visible = (this.read().audit ?? []).filter((a) => mine === undefined || everything || a.repo === mine);
    return visible.slice(-Math.max(0, limit)).reverse();
  }
  /** Replaces the file atomically; Windows refuses the rename for a moment while another process reads the file, so it is retried briefly. */
  private async replace(text: string) {
    const temp = this.file + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, text, { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temp, this.file); return; }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= 40) { try { unlinkSync(temp); } catch { /* keep the error that matters */ } throw err; }
        await sleep(5 + Math.random() * 20);
      }
    }
  }
  /**
   * Runs `work` holding the lock file: created exclusively, waited for briefly, taken over when stale (a
   * crashed process left it). A stale lock is taken over by renaming it away, so of two waiters that both
   * found it stale only the one whose rename succeeds removes it, and neither can remove the fresh lock
   * the other creates right after.
   */
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    mkdirSync(this.dataDir, { recursive: true });
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      let fd: number;
      try { fd = openSync(this.lock, 'wx', 0o600); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          if (Date.now() - statSync(this.lock).mtimeMs > LOCK_STALE_MS) {
            const gone = this.lock + '.stale.' + randomUUID();
            renameSync(this.lock, gone);
            unlinkSync(gone);
          }
        } catch { /* gone already, or still someone's */ }
        if (Date.now() > until) throw new HarnessError('Another office is saving harness profiles. Try again in a moment.', 503);
        await sleep(5 + Math.random() * 20);
        continue;
      }
      try { writeFileSync(fd, String(process.pid)); return await work(); }
      finally { closeSync(fd); try { unlinkSync(this.lock); } catch { /* taken over as stale */ } }
    }
  }
  /**
   * Replaces one level's own layer down `target`, when `revision` is still the store's (else 409: reload
   * and merge). An empty layer removes the level's layer, so everything inherits again.
   */
  async save(repo: string, target: HarnessTarget, scope: unknown, layer: unknown, revision: unknown, by = ''): Promise<HarnessProfile> {
    const level = harnessLevel(scope);
    const path = asPath(target);
    if (!level) throw new HarnessError('Choose a level: ' + [...HARNESS_LEVELS, 'repository'].join(', ') + '.');
    const key = this.key(repo, path, level);
    if (!key) throw new HarnessError(level === 'task' ? 'Choose a scope and a task ID for task overrides.' : `This target has no ${level} above it: load a node that does before saving at ${level}.`);
    const next = parseHarnessLayer(layer);
    return this.locked(async () => {
      const data = this.read();
      if (revision !== data.revision) throw new HarnessError('Profiles changed elsewhere. Reload before saving.', 409);
      // The save that makes a version 1 file version 2 remembers which task: keys the 3-level store wrote.
      if (data.version === undefined) data.legacyTasks = Object.keys(data.layers).filter((k) => k.startsWith('task:'));
      const legacy = this.legacyKey(data, repo, path, level);
      if (Object.keys(next).length) data.layers[key] = next; else delete data.layers[key];
      // The lifted layer lives at its node: key from now on; the task: key stays as it was, for a rollback.
      // A task: key this office writes (a task save, legacy or not) is the card's task layer and nothing else.
      const settled = legacy ?? (level === 'task' ? key : undefined);
      if (settled) data.legacyTasks = data.legacyTasks?.filter((k) => k !== settled);
      if (data.legacyTasks && !data.legacyTasks.length) delete data.legacyTasks;
      data.revision++;
      data.version = HARNESS_STORE_VERSION;
      const entry: HarnessAudit = { at: new Date().toISOString(), revision: data.revision, level, node: pathNode(path, level)?.node ?? '', ...(level === 'global' ? {} : { repo: this.repoKey(repo) }), by: String(by).slice(0, 120), slots: Object.keys(next) };
      data.audit = [...(data.audit ?? []).slice(-(AUDIT_KEEP - 1)), entry];
      const text = JSON.stringify(data, null, 2);
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new HarnessError('Harness profile storage is full.');
      await this.replace(text);
      return this.assemble(data, repo, path);
    });
  }
}

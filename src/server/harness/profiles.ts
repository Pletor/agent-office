// Seven-level profiles, version 2. Global/repository/task keys retain their identity; intermediate
// levels use node:<repo>:<node key>. Legacy task layers lift once to their current Canvas scope.
// Saving that scope retires its migration marker and leaves original task bytes for recovery.
// Restore the pre-migration backup for downgrades; old writers must not edit a v2 store.
// See docs/harness-hierarchy.md for storage, binding and rollback requirements.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileLockError, withFileLock, type Lease, type LockOptions } from './lock.js';
import { DamagedRevision, publishRevision, readCommitted, RevisionConflict } from './commit.js';
import { emptyLayers, harnessLevel, pathNode, resolveHarness, HARNESS_LEVELS, type HarnessLayer, type HarnessLevel, type HarnessPath, type HarnessProfile } from '../../shared/harness-cascade.js';
import { advanceLifecycle, lifecycleScopeKey, parseLifecycle, type LifecycleCheck, type LifecycleScope, type LifecycleState } from './lifecycle.js';

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

/** The store's key of a checkout (the hash in `repo:<hash>`): its absolute path, case-folded on Windows. The bindings (bindings.ts) name a repository by it too. */
export function harnessRepoKey(repo: string): string {
  const dir = path.resolve(repo);
  return createHash('sha256').update(process.platform === 'win32' ? dir.toLowerCase() : dir).digest('hex');
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
 * How long a save waits for another office process's lock before giving up (ms: room for a save ahead of it
 * that re-reads the canvas from Opora under the lock, up to 2.5 s), and how long a lock may
 * go unrenewed before it is a crashed holder's (lock.ts: a live holder renews it every quarter of that).
 */
const LOCK_WAIT_MS = 6000, LOCK_STALE_MS = 10_000;
const CHANGED = 'Profiles changed elsewhere. Reload before saving.';
interface Stored { version?: number; revision: number; layers: Record<string, HarnessLayer>; audit?: HarnessAudit[]; legacyTasks?: string[]; toolStates?: Record<string, LifecycleState> }

/** What a view or a save addresses: a task id (the 3-level form), or the way down to a node (shared/harness-hierarchy.ts). */
export type HarnessTarget = string | HarnessPath;
function asPath(target: HarnessTarget): HarnessPath {
  if (typeof target !== 'string') return target;
  return target ? [{ level: 'task', node: target }] : [];
}

/**
 * Reads are plain reads of the file (and of the revisions published after it, commit.ts); a save is
 * read-check-write under a lock file (lock.ts, best effort) and commits by publishing the next revision
 * exclusively (commit.ts), so a save never overwrites one it didn't read, even from another office
 * process on the same data directory: the loser gets 409. Atomic replacement survives restarts.
 * `lockOptions` are for tests (time, sleeping, file system calls and interleaving hooks).
 */
export class HarnessProfiles {
  private file: string;
  private lock: string;
  constructor(private dataDir: string, private lockOptions: LockOptions = {}) { this.file = path.join(dataDir, 'harness-profiles.json'); this.lock = this.file + '.lock'; }
  /** The store as committed (commit.ts: the main file and the revisions published after it), and the text a save builds on. */
  private committed(): { data: Stored; base: string } {
    const { text, value } = readCommitted(this.file, (raw) => this.parse(raw));
    return { data: value ?? { revision: 0, layers: {} }, base: text };
  }
  private read(): Stored {
    return this.committed().data;
  }
  private parse(text: string): Stored {
    try {
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('too large');
      const data = JSON.parse(text) as Stored;
      if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !object(data.layers)) throw new Error('invalid schema');
      if (data.version !== undefined && (!Number.isSafeInteger(data.version) || data.version < 1 || data.version > HARNESS_STORE_VERSION)) throw new Error('unknown store version');
      for (const layer of Object.values(data.layers)) parseHarnessLayer(layer);
      if (data.toolStates !== undefined) {
        if (!object(data.toolStates)) throw new Error('invalid tool states');
        for (const [key, state] of Object.entries(data.toolStates)) {
          const parsed = parseLifecycle(state);
          if (!/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(key) || key.split(':')[1] !== lifecycleScopeKey(parsed.scope)) throw new Error('invalid tool scope');
        }
      }
      if (data.audit !== undefined && !Array.isArray(data.audit)) throw new Error('invalid audit');
      if (data.audit) data.audit = data.audit.filter((a): a is HarnessAudit => object(a) && typeof a.at === 'string' && Number.isSafeInteger(a.revision) && typeof a.level === 'string' && typeof a.node === 'string' && typeof a.by === 'string' && Array.isArray(a.slots) && a.slots.every((s) => typeof s === 'string') && (a.repo === undefined || typeof a.repo === 'string'));
      if (data.legacyTasks !== undefined && !(Array.isArray(data.legacyTasks) && data.legacyTasks.every((k) => typeof k === 'string'))) throw new Error('invalid legacyTasks');
      return data;
    } catch { throw new HarnessError('Harness profiles are unreadable. Repair the saved file; it has not been overwritten.', 503); }
  }
  private repoKey(repo: string) { return harnessRepoKey(repo); }
  /** The store key of a level on the path; undefined for a level below the project the path doesn't go through. */
  private key(repo: string, path: HarnessPath, level: HarnessLevel): string | undefined {
    if (level === 'global') return 'global';
    const repoKey = this.repoKey(repo);
    if (level === 'repository') return 'repo:' + repoKey;
    const node = pathNode(path, level)?.node;
    if (node === undefined) return undefined;
    if (!node.trim() || node.length > 500 || /[\x00-\x1f]/.test(node)) throw new HarnessError('Invalid task ID');
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
    const lifts = (data.version ?? 1) === 1 ? key in data.layers : (data.legacyTasks ?? []).includes(key);
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
  lifecycle(repo: string, scope: LifecycleScope): { revision: number; state?: LifecycleState } {
    const data = this.read(), key = this.repoKey(repo) + ':' + lifecycleScopeKey(scope);
    return { revision: data.revision, state: data.toolStates?.[key] ? structuredClone(data.toolStates[key]) : undefined };
  }
  /** Internal server seam. Never expose readEvidence as worker-supplied observations. */
  async advanceTool(repo: string, scope: LifecycleScope, revision: number, operation: 'promote' | 'reconcile',
    readEvidence: (current: LifecycleState | undefined) => Promise<LifecycleCheck>): Promise<{ revision: number; state: LifecycleState }> {
    const key = this.repoKey(repo) + ':' + lifecycleScopeKey(scope);
    return this.locked(async lease => {
      const { data, base } = this.committed();
      if (revision !== data.revision) throw new HarnessError(CHANGED, 409);
      const before = data.toolStates?.[key];
      const checks = await readEvidence(before ? structuredClone(before) : undefined);
      const state = advanceLifecycle(scope, before, checks, operation);
      if ((data.version ?? 1) === 1) data.legacyTasks = Object.keys(data.layers).filter(k => k.startsWith('task:'));
      data.version = HARNESS_STORE_VERSION;
      // Keep optional v2 fields: earlier v2 writers preserve unknown properties when saving layers.
      data.toolStates = { ...data.toolStates, [key]: state }; data.revision++;
      const text = JSON.stringify(data, null, 2);
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new HarnessError('Harness profile storage is full.');
      const revisionOf = (raw: string) => { try { return this.parse(raw).revision; } catch { return undefined; } };
      try { await publishRevision(this.file, data.revision, base, text,
        { fence: () => { lease.verify(); this.lockOptions.hooks?.verified?.(); }, revisionOf }); }
      catch (err) {
        if (err instanceof RevisionConflict) throw new HarnessError(CHANGED, 409);
        if (err instanceof DamagedRevision) throw new HarnessError(err.message, 503);
        throw err;
      }
      return { revision: data.revision, state: structuredClone(state) };
    });
  }
  /**
   * The latest saves, newest first, that a reader of `repo` may see: the repository's own saves below
   * global; with `everything` (an administrator) also global saves, other repositories' and entries from
   * before the repository was recorded. Without `repo`, everything. With `own`, only the saves of that one
   * level (and below the project, that node of this repository).
   */
  audit(limit = 20, repo?: string, everything = true, own?: { level: HarnessLevel; node: string }): HarnessAudit[] {
    const mine = repo === undefined ? undefined : this.repoKey(repo);
    let visible = (this.read().audit ?? []).filter((a) => mine === undefined || everything || a.repo === mine);
    // One level's own saves (the editor's "Latest saves"): filtered before the limit, so a busy store never pushes them out. Below global, this repository's only.
    if (own) visible = visible.filter((a) => a.level === own.level && (own.level === 'global' || ((mine === undefined || a.repo === mine) && a.node === own.node)));
    return visible.slice(-Math.max(0, limit)).reverse();
  }
  /**
   * Runs `work` holding the lock file (lock.ts: best effort, it keeps honest writers from colliding; the
   * commit in commit.ts is what refuses a lost update). Out of wait is 503: retry in a moment.
   */
  private async locked<T>(work: (lease: Lease) => Promise<T>): Promise<T> {
    mkdirSync(this.dataDir, { recursive: true });
    try { return await withFileLock(this.lock, { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS, ...this.lockOptions }, work); }
    catch (err) {
      if (err instanceof FileLockError) throw new HarnessError(err.code === 'timeout' ? 'Another office is saving harness profiles. Try again in a moment.' : err.message, 503);
      throw err;
    }
  }
  /**
   * Replaces one level's own layer down `target`, when `revision` is still the store's (else 409: reload
   * and merge). An empty layer removes the level's layer, so everything inherits again. `recheck` runs
   * under the lock, after the store is read and before anything is written, for what the caller validated
   * before waiting for it (the target's place on the canvas); it throws to refuse the save, and may return
   * the target's path as it is now, which the returned profile then carries. The commit is an exclusive
   * publish of the next revision (commit.ts): a writer that loses it gets 409 and nothing is written.
   * Returns the profile as committed.
   */
  async save(repo: string, target: HarnessTarget, scope: unknown, layer: unknown, revision: unknown, by = '', recheck?: () => void | HarnessPath | Promise<void | HarnessPath>): Promise<HarnessProfile> {
    const level = harnessLevel(scope);
    let path = asPath(target);
    if (!level) throw new HarnessError('Choose a level: ' + [...HARNESS_LEVELS, 'repository'].join(', ') + '.');
    const key = this.key(repo, path, level);
    if (!key) throw new HarnessError(level === 'task' ? 'Choose a scope and a task ID for task overrides.' : `This target has no ${level} above it: load a node that does before saving at ${level}.`);
    const next = parseHarnessLayer(layer);
    return this.locked(async (lease) => {
      // Read-check-write, all under the lock: the revision is compared against what the file says now.
      const { data, base } = this.committed();
      if (revision !== data.revision) throw new HarnessError(CHANGED, 409);
      path = (await recheck?.()) ?? path;
      // The save that makes a version 1 file version 2 remembers which task: keys the 3-level store wrote.
      if ((data.version ?? 1) === 1) data.legacyTasks = Object.keys(data.layers).filter((k) => k.startsWith('task:'));
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
      // The lock is checked right before the publish (a holder whose lock was taken over stops here, 503); the
      // publish itself refuses a successor of this revision when another writer got there first (409).
      const revisionOf = (raw: string) => { try { return this.parse(raw).revision; } catch { return undefined; } };
      try { await publishRevision(this.file, data.revision, base, text, { fence: () => { lease.verify(); this.lockOptions.hooks?.verified?.(); }, revisionOf }); }
      catch (err) {
        if (err instanceof RevisionConflict) throw new HarnessError(CHANGED, 409);
        if (err instanceof DamagedRevision) throw new HarnessError(err.message, 503);
        throw err;
      }
      return this.assemble(data, repo, path);
    });
  }
}

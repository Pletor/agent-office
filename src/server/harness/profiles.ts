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
// A task: layer the 3-level store (or a save before the canvas was read) wrote for a node that the
// canvas now places above the task level is read as that level's layer (when it has no node: layer)
// and moved to its node: key on that level's next save, so nothing a version 1 file assigned goes missing.
// `version` and `audit` are new in version 2; a reader that doesn't know them ignores them.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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
  by: string;
  /** The slot names the layer sets after the save; [] when the layer was removed (everything inherits again). */
  slots: string[];
}
/** The store's version this code writes. Version 1 (no field) is the 3-level store. */
export const HARNESS_STORE_VERSION = 2;
/** Audit entries kept, oldest dropped first. */
const AUDIT_KEEP = 200;
interface Stored { version?: number; revision: number; layers: Record<string, HarnessLayer>; audit?: HarnessAudit[] }

/** What a view or a save addresses: a task id (the 3-level form), or the way down to a node (shared/harness-hierarchy.ts). */
export type HarnessTarget = string | HarnessPath;
function asPath(target: HarnessTarget): HarnessPath {
  if (typeof target !== 'string') return target;
  return target ? [{ level: 'task', node: target }] : [];
}

/** Synchronous bounded transactions serialize writes within the office process; atomic replacement survives restarts. */
export class HarnessProfiles {
  private file: string;
  constructor(private dataDir: string) { this.file = path.join(dataDir, 'harness-profiles.json'); }
  private read(): Stored {
    let text: string;
    try { text = readFileSync(this.file, 'utf8'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, layers: {} }; throw err; }
    try {
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('too large');
      const data = JSON.parse(text) as Stored;
      if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !object(data.layers)) throw new Error('invalid schema');
      if (data.version !== undefined && (!Number.isSafeInteger(data.version) || data.version < 1 || data.version > HARNESS_STORE_VERSION)) throw new Error('unknown store version');
      for (const layer of Object.values(data.layers)) parseHarnessLayer(layer);
      if (data.audit !== undefined && !Array.isArray(data.audit)) throw new Error('invalid audit');
      if (data.audit) data.audit = data.audit.filter((a): a is HarnessAudit => object(a) && typeof a.at === 'string' && Number.isSafeInteger(a.revision) && typeof a.level === 'string' && typeof a.node === 'string' && typeof a.by === 'string' && Array.isArray(a.slots) && a.slots.every((s) => typeof s === 'string'));
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
  /** The task: key a 3-level store would have given the node at `level`, which the canvas now puts above the task level. */
  private legacyKey(repo: string, path: HarnessPath, level: HarnessLevel): string | undefined {
    const node = pathNode(path, level);
    if (!node || level === 'task') return undefined;
    return this.key(repo, [{ level: 'task', node: node.node }], 'task');
  }
  private assemble(data: Stored, repo: string, path: HarnessPath): HarnessProfile {
    const layers = emptyLayers();
    for (const level of HARNESS_LEVELS) {
      const key = this.key(repo, path, level), legacy = this.legacyKey(repo, path, level);
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
  /** The latest saves, newest first. */
  audit(limit = 20): HarnessAudit[] {
    return (this.read().audit ?? []).slice(-Math.max(0, limit)).reverse();
  }
  /**
   * Replaces one level's own layer down `target`, when `revision` is still the store's (else 409: reload
   * and merge). An empty layer removes the level's layer, so everything inherits again.
   */
  save(repo: string, target: HarnessTarget, scope: unknown, layer: unknown, revision: unknown, by = ''): HarnessProfile {
    const level = harnessLevel(scope);
    const path = asPath(target);
    if (!level) throw new HarnessError('Choose a level: ' + [...HARNESS_LEVELS, 'repository'].join(', ') + '.');
    const key = this.key(repo, path, level);
    if (!key) throw new HarnessError(level === 'task' ? 'Choose a scope and a task ID for task overrides.' : `This target has no ${level} above it: load a node that does before saving at ${level}.`);
    const next = parseHarnessLayer(layer), data = this.read();
    if (revision !== data.revision) throw new HarnessError('Profiles changed elsewhere. Reload before saving.', 409);
    if (Object.keys(next).length) data.layers[key] = next; else delete data.layers[key];
    const legacy = this.legacyKey(repo, path, level);
    if (legacy) delete data.layers[legacy];
    data.revision++;
    data.version = HARNESS_STORE_VERSION;
    const entry: HarnessAudit = { at: new Date().toISOString(), revision: data.revision, level, node: pathNode(path, level)?.node ?? '', by: String(by).slice(0, 120), slots: Object.keys(next) };
    data.audit = [...(data.audit ?? []).slice(-(AUDIT_KEEP - 1)), entry];
    const text = JSON.stringify(data, null, 2);
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new HarnessError('Harness profile storage is full.');
    mkdirSync(this.dataDir, { recursive: true });
    const temp = this.file + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, this.file);
    return this.assemble(data, repo, path);
  }
}

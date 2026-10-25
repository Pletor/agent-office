// The floor ↔ Opora project bindings, `<dataDir>/harness-bindings.json`: which Opora project and
// workspace each floor's checkout is planned by, written down once by an administrator (or the
// orchestrator an administrator owns) instead of guessed from the Opora window every time. A floor is
// bound to exactly one project + workspace at a time; rebinding is an explicit, audited act that
// leaves the old binding's profiles where they are (they are keyed by the checkout's hash, not by
// the project). Project identity is Opora's project and workspace ids, never a name.
//
// Format (version 1), kept apart from harness-profiles.json, whose format does not change:
//   { version: 1, revision: N, bindings: { <floorId>: HarnessBinding }, audit: [HarnessBindingAudit] }
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { HarnessError, harnessRepoKey } from './profiles.js';
import { DamagedRevision, publishRevision, readCommitted, RevisionConflict } from './commit.js';
import { FileLockError, withFileLock, type Lease, type LockOptions } from './lock.js';
import { samePlace, type OporaPlace } from '../../shared/opora-identity.js';

/** One floor's binding: the project and workspace on Opora, and the checkout they plan. */
export interface HarnessBinding extends OporaPlace {
  /** The profile store's key of the checkout (`repo:<repoHash>`). */
  repoHash: string;
  floorId: string;
  checkoutPath: string;
  baseUrl?: string;
  boundAt: string;
  /** Who bound it: account:<id> | shared-password | worker:<id>. */
  boundBy: string;
}
/** What a profile response says about the floor's binding. */
export type HarnessBindingView = Pick<HarnessBinding, 'project' | 'workspace' | 'repoHash' | 'floorId'>;
/** One bind or rebind: from which place (null for a first binding) to which, by whom. */
export interface HarnessBindingAudit { at: string; revision: number; floorId: string; repoHash: string; from: OporaPlace | null; to: OporaPlace; by: string }
interface Stored { version?: number; revision: number; bindings: Record<string, HarnessBinding>; audit: HarnessBindingAudit[] }

export const HARNESS_BINDINGS_VERSION = 1;
const AUDIT_KEEP = 200;
/** An Opora id as the office accepts it in a binding: bounded, printable, no separators of the Opora key. */
const OPORA_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** The project and workspace a request names, or the reason it names none well. */
export function parseBindingPlace(body: unknown): OporaPlace {
  if (!object(body)) throw new HarnessError('Expected a JSON object with project and workspace.');
  const { project, workspace } = body;
  if (typeof project !== 'string' || !OPORA_ID.test(project)) throw new HarnessError('project must be an Opora project id.');
  if (typeof workspace !== 'string' || !OPORA_ID.test(workspace)) throw new HarnessError('workspace must be an Opora workspace id.');
  return { project, workspace };
}
export function bindingView(binding: HarnessBinding | undefined): HarnessBindingView | null {
  return binding ? { project: binding.project, workspace: binding.workspace, repoHash: binding.repoHash, floorId: binding.floorId } : null;
}

const LOCK_WAIT_MS = 3000, LOCK_STALE_MS = 10_000;

/**
 * Reads are plain reads of the file (and of the revisions published after it, commit.ts); a bind is
 * read-check-write under a lock file (lock.ts, `harness-bindings.json.lock`, best effort) and commits by
 * publishing the next revision exclusively (commit.ts), so two offices (or two requests) binding at once
 * never both commit on the same revision even when a lock was taken over or a holder stalled: the loser
 * gets 409, a damaged published file 503. The main file keeps its format; a binding survives a restart
 * or a crash mid-write.
 */
export class HarnessBindings {
  private file: string;
  constructor(private dataDir: string, private lockOptions: LockOptions = {}) { this.file = path.join(dataDir, 'harness-bindings.json'); }
  /** The store as committed (the main file and the revisions published after it), and the text a bind builds on. */
  private committed(): { data: Stored; base: string } {
    const { text, value } = readCommitted(this.file, (raw) => this.parse(raw));
    return { data: value ?? { revision: 0, bindings: {}, audit: [] }, base: text };
  }
  private read(): Stored { return this.committed().data; }
  private parse(text: string): Stored {
    try {
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('too large');
      const data = JSON.parse(text) as Stored;
      if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !object(data.bindings) || !Array.isArray(data.audit)) throw new Error('invalid schema');
      if (data.version !== undefined && (!Number.isSafeInteger(data.version) || data.version < 1 || data.version > HARNESS_BINDINGS_VERSION)) throw new Error('unknown store version');
      for (const [floorId, b] of Object.entries(data.bindings)) {
        if (!object(b) || b.floorId !== floorId || [b.project, b.workspace, b.repoHash, b.checkoutPath, b.boundAt, b.boundBy].some((v) => typeof v !== 'string')) throw new Error('invalid binding');
        if (b.baseUrl !== undefined) {
          if (typeof b.baseUrl !== 'string') throw new Error('invalid binding origin');
          const url = new URL(b.baseUrl);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== b.baseUrl) throw new Error('invalid binding origin');
        }
      }
      const place = (v: unknown) => object(v) && typeof v.project === 'string' && typeof v.workspace === 'string';
      for (const a of data.audit) {
        if (!object(a) || typeof a.at !== 'string' || !Number.isSafeInteger(a.revision) || typeof a.floorId !== 'string' || typeof a.repoHash !== 'string' || typeof a.by !== 'string' || !place(a.to) || (a.from !== null && !place(a.from))) throw new Error('invalid audit entry');
      }
      return data;
    } catch { throw new HarnessError('Harness bindings are unreadable. Repair the saved file; it has not been overwritten.', 503); }
  }
  revision(): number { return this.read().revision; }
  /** The floor's binding, if it has one. */
  forFloor(floorId: string): HarnessBinding | undefined { return this.read().bindings[floorId]; }
  /** The binding of the floor whose checkout is `repo` (by the profile store's key of it), if any. */
  forRepo(repo: string): HarnessBinding | undefined {
    const hash = harnessRepoKey(repo);
    return Object.values(this.read().bindings).find((b) => b.repoHash === hash);
  }
  /** The latest binds, newest first; with `floorId`, the floor's own. */
  audit(limit = 20, floorId?: string): HarnessBindingAudit[] {
    return this.read().audit.filter((a) => floorId === undefined || a.floorId === floorId).slice(-Math.max(0, limit)).reverse();
  }
  private async locked<T>(work: (lease: Lease) => Promise<T>): Promise<T> {
    mkdirSync(this.dataDir, { recursive: true });
    try { return await withFileLock(this.file + '.lock', { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS, ...this.lockOptions }, work); }
    catch (err) {
      if (err instanceof FileLockError) throw new HarnessError(err.code === 'timeout' ? 'Another office is binding a floor. Try again in a moment.' : err.code === 'unavailable' ? err.message : 'Another office took over the bindings lock while this bind waited; nothing was written. Try again.', 503);
      throw err;
    }
  }
  /**
   * Binds `floorId` (whose checkout is `checkout`) to `place`. Binding a floor to the place it is bound
   * to already changes nothing (and writes nothing); binding it to another place is a rebind, which
   * must be asked for (`rebind`) and is audited; with `revision` the bind is compare-and-set (409).
   */
  bind(floorId: string, checkout: string, place: OporaPlace, by: string, options: { rebind?: boolean; revision?: unknown; baseUrl?: string } = {}): Promise<{ binding: HarnessBinding; revision: number; changed: boolean }> {
    return this.locked((lease) => this.bindLocked(lease, floorId, checkout, place, by, options));
  }
  /** The read, the checks and the write of a bind, all under the lock: what the file says now decides. */
  private async bindLocked(lease: Lease, floorId: string, checkout: string, place: OporaPlace, by: string, options: { rebind?: boolean; revision?: unknown; baseUrl?: string }): Promise<{ binding: HarnessBinding; revision: number; changed: boolean }> {
    const { data, base } = this.committed();
    if (options.revision !== undefined && options.revision !== data.revision) throw new HarnessError('Bindings changed elsewhere. Reload before binding.', 409);
    const current = data.bindings[floorId];
    if (current && samePlace(current, place) && (options.baseUrl === undefined || current.baseUrl === options.baseUrl)) return { binding: current, revision: data.revision, changed: false };
    if (current && !options.rebind) throw new HarnessError(`Floor ${floorId} is bound to Opora project ${current.project}, workspace ${current.workspace}. Rebinding is explicit: send rebind: true (CLI: --rebind). The old binding's profiles stay in the store under its repository key.`, 409);
    const repoHash = harnessRepoKey(checkout);
    // Profiles are the checkout's, so floors on one checkout share one place: a first binding of another floor on it must name the same place (409),
    // and a rebind moves every floor on the checkout together, each with its own audit entry, so the dispatch gate stays unambiguous.
    const sharing = Object.values(data.bindings).filter((b) => b.floorId !== floorId && b.repoHash === repoHash);
    const elsewhere = sharing.find((b) => !samePlace(b, place) || (options.baseUrl !== undefined && b.baseUrl !== undefined && b.baseUrl !== options.baseUrl));
    if (elsewhere && !current) throw new HarnessError(`Floor ${elsewhere.floorId} has the same checkout bound to project ${elsewhere.project}, workspace ${elsewhere.workspace}: one checkout's profiles belong to one project and workspace. Rebind that floor, which moves every floor on the checkout, or bind this one to the same place.`, 409);
    const binding: HarnessBinding = { project: place.project, workspace: place.workspace, repoHash, floorId, checkoutPath: path.resolve(checkout), ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}), boundAt: new Date().toISOString(), boundBy: String(by).slice(0, 120) };
    data.revision++;
    data.version = HARNESS_BINDINGS_VERSION;
    const moved = [{ binding, from: current }, ...sharing.filter((b) => !samePlace(b, place) || (options.baseUrl !== undefined && b.baseUrl !== options.baseUrl)).map((b) => ({ binding: { ...b, project: place.project, workspace: place.workspace, ...(binding.baseUrl ? { baseUrl: binding.baseUrl } : {}), boundAt: binding.boundAt, boundBy: binding.boundBy }, from: b as HarnessBinding | undefined }))];
    for (const m of moved) {
      data.bindings[m.binding.floorId] = m.binding;
      data.audit = [...data.audit.slice(-(AUDIT_KEEP - 1)), { at: binding.boundAt, revision: data.revision, floorId: m.binding.floorId, repoHash, from: m.from ? { project: m.from.project, workspace: m.from.workspace } : null, to: { ...place }, by: binding.boundBy }];
    }
    const text = JSON.stringify(data, null, 2);
    // The lock is checked right before the publish (a holder whose lock was taken over stops here, 503); the publish itself
    // refuses a successor of this revision when another writer got there first: a bind that lost the race is a normal conflict (409).
    const revisionOf = (raw: string) => { try { return this.parse(raw).revision; } catch { return undefined; } };
    try { await publishRevision(this.file, data.revision, base, text, { fence: () => { lease.verify(); this.lockOptions.hooks?.verified?.(); }, revisionOf }); }
    catch (err) {
      if (err instanceof RevisionConflict) throw new HarnessError('Bindings changed elsewhere. Reload before binding.', 409);
      if (err instanceof DamagedRevision) throw new HarnessError(err.message, 503);
      throw err;
    }
    return { binding, revision: data.revision, changed: true };
  }
}


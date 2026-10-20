// The floor ↔ Opora project bindings, `<dataDir>/harness-bindings.json`: which Opora project and
// workspace each floor's checkout is planned by, written down once by an administrator (or the
// orchestrator an administrator owns) instead of guessed from the Opora window every time. A floor is
// bound to exactly one project + workspace at a time; rebinding is an explicit, audited act that
// leaves the old binding's profiles where they are (they are keyed by the checkout's hash, not by
// the project). Project identity is Opora's project and workspace ids, never a name.
//
// Format (version 1), kept apart from harness-profiles.json, whose format does not change:
//   { version: 1, revision: N, bindings: { <floorId>: HarnessBinding }, audit: [HarnessBindingAudit] }
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessError, harnessRepoKey } from './profiles.js';
import { parseOporaKey, samePlace, type OporaPlace } from '../../shared/opora-identity.js';

/** One floor's binding: the project and workspace on Opora, and the checkout they plan. */
export interface HarnessBinding extends OporaPlace {
  /** The profile store's key of the checkout (`repo:<repoHash>`). */
  repoHash: string;
  floorId: string;
  checkoutPath: string;
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

/** Reads are plain reads of the file; a bind is read-check-write with atomic replacement, so a binding survives a restart or a crash mid-write. */
export class HarnessBindings {
  private file: string;
  constructor(private dataDir: string) { this.file = path.join(dataDir, 'harness-bindings.json'); }
  private read(): Stored {
    let text: string;
    for (let attempt = 0; ; attempt++) {
      try { text = readFileSync(this.file, 'utf8'); break; }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return { revision: 0, bindings: {}, audit: [] };
        if ((code === 'EPERM' || code === 'EBUSY') && attempt < 50) continue;
        throw err;
      }
    }
    try {
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('too large');
      const data = JSON.parse(text) as Stored;
      if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !object(data.bindings) || !Array.isArray(data.audit)) throw new Error('invalid schema');
      if (data.version !== undefined && (!Number.isSafeInteger(data.version) || data.version < 1 || data.version > HARNESS_BINDINGS_VERSION)) throw new Error('unknown store version');
      for (const [floorId, b] of Object.entries(data.bindings)) {
        if (!object(b) || b.floorId !== floorId || [b.project, b.workspace, b.repoHash, b.checkoutPath, b.boundAt, b.boundBy].some((v) => typeof v !== 'string')) throw new Error('invalid binding');
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
  private replace(text: string) {
    mkdirSync(this.dataDir, { recursive: true });
    const temp = this.file + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, text, { mode: 0o600 });
    try { renameSync(temp, this.file); }
    catch (err) { try { unlinkSync(temp); } catch { /* keep the error that matters */ } throw err; }
  }
  /**
   * Binds `floorId` (whose checkout is `checkout`) to `place`. Binding a floor to the place it is bound
   * to already changes nothing (and writes nothing); binding it to another place is a rebind, which
   * must be asked for (`rebind`) and is audited; with `revision` the bind is compare-and-set (409).
   */
  bind(floorId: string, checkout: string, place: OporaPlace, by: string, options: { rebind?: boolean; revision?: unknown } = {}): { binding: HarnessBinding; revision: number; changed: boolean } {
    const data = this.read();
    if (options.revision !== undefined && options.revision !== data.revision) throw new HarnessError('Bindings changed elsewhere. Reload before binding.', 409);
    const current = data.bindings[floorId];
    if (current && samePlace(current, place)) return { binding: current, revision: data.revision, changed: false };
    if (current && !options.rebind) throw new HarnessError(`Floor ${floorId} is bound to Opora project ${current.project}, workspace ${current.workspace}. Rebinding is explicit: send rebind: true (CLI: --rebind). The old binding's profiles stay in the store under its repository key.`, 409);
    const repoHash = harnessRepoKey(checkout);
    // Profiles are the checkout's, so floors on one checkout share one place: a first binding of another floor on it must name the same place (409),
    // and a rebind moves every floor on the checkout together, each with its own audit entry, so the dispatch gate stays unambiguous.
    const sharing = Object.values(data.bindings).filter((b) => b.floorId !== floorId && b.repoHash === repoHash);
    const elsewhere = sharing.find((b) => !samePlace(b, place));
    if (elsewhere && !current) throw new HarnessError(`Floor ${elsewhere.floorId} has the same checkout bound to project ${elsewhere.project}, workspace ${elsewhere.workspace}: one checkout's profiles belong to one project and workspace. Rebind that floor, which moves every floor on the checkout, or bind this one to the same place.`, 409);
    const binding: HarnessBinding = { project: place.project, workspace: place.workspace, repoHash, floorId, checkoutPath: path.resolve(checkout), boundAt: new Date().toISOString(), boundBy: String(by).slice(0, 120) };
    data.revision++;
    data.version = HARNESS_BINDINGS_VERSION;
    const moved = [{ binding, from: current }, ...sharing.filter((b) => !samePlace(b, place)).map((b) => ({ binding: { ...b, project: place.project, workspace: place.workspace, boundAt: binding.boundAt, boundBy: binding.boundBy }, from: b as HarnessBinding | undefined }))];
    for (const m of moved) {
      data.bindings[m.binding.floorId] = m.binding;
      data.audit = [...data.audit.slice(-(AUDIT_KEEP - 1)), { at: binding.boundAt, revision: data.revision, floorId: m.binding.floorId, repoHash, from: m.from ? { project: m.from.project, workspace: m.from.workspace } : null, to: { ...place }, by: binding.boundBy }];
    }
    this.replace(JSON.stringify(data, null, 2));
    return { binding, revision: data.revision, changed: true };
  }
}

/** What a profile write is checked against: the floor's binding, Opora as the floor reads it, and the request. */
export interface BoundWrite {
  floorId: string;
  binding: HarnessBinding | undefined;
  /** Whether Opora answered at the last read, and why not. */
  opora: { connected: boolean; error?: string };
  /** The project and workspace the floor's Opora window reads now, if any. */
  linked: OporaPlace | undefined;
  /** The id addressed (`?node=` / `?task=`). */
  key: string;
  /** Whether the save is at a level below the project (one that is an Opora node). */
  below: boolean;
  /** The project and workspace the request says it acts on, when it says. */
  claims: { project?: unknown; workspace?: unknown };
  /** Whether the canvas as last read has the node the key names. */
  known: boolean;
}

/**
 * Why a profile write may not go ahead, thrown as the HarnessError it is refused with; nothing when it may.
 * A request that names the project and workspace it believes it acts on is refused when the floor is
 * bound elsewhere (409) or not at all (409). A save below the project at an Opora node needs the floor
 * bound (409), the node in the bound project and workspace (403: another project's node, never
 * remapped), Opora answering so the node's place on the canvas can be checked (503, nothing written),
 * the window reading the bound project (409: drift between link and binding) and the node on the
 * canvas (400, with the node id). A custom task id, the project and the global layer need none of this.
 */
export function assertBoundWrite(w: BoundWrite): void {
  const { binding } = w;
  const bound = binding ? `project ${binding.project}, workspace ${binding.workspace}` : '';
  if (w.claims.project !== undefined || w.claims.workspace !== undefined) {
    if (!binding) throw new HarnessError(`Floor ${w.floorId} is not bound to an Opora project: bind it first (POST /api/harness/binding, or office-harness --bind PROJECT WORKSPACE).`, 409);
    if (w.claims.project !== binding.project || w.claims.workspace !== binding.workspace) throw new HarnessError(`This request acts on project ${String(w.claims.project)}, workspace ${String(w.claims.workspace)}, but floor ${w.floorId} is bound to ${bound}. Nothing was written.`, 409);
  }
  const at = parseOporaKey(w.key);
  if (!at || !w.below) return;
  if (!binding) throw new HarnessError(`Floor ${w.floorId} is not bound to an Opora project, so a profile at an Opora node can't be placed: bind it first (POST /api/harness/binding, or office-harness --bind PROJECT WORKSPACE).`, 409);
  if (!samePlace(at, binding)) throw new HarnessError(`That node is in project ${at.project}, workspace ${at.workspace}; floor ${w.floorId} is bound to ${bound}. Another project's profiles are not this floor's to change.`, 403);
  if (!w.opora.connected) throw new HarnessError(`Opora isn't answering${w.opora.error ? ' (' + w.opora.error + ')' : ''}: the node's place on the canvas can't be checked, so nothing was written. Try again when Opora is back.`, 503);
  if (!samePlace(w.linked, binding)) throw new HarnessError(`This floor's Opora window reads ${w.linked ? `project ${w.linked.project}, workspace ${w.linked.workspace}` : 'no project'}, but the floor is bound to ${bound}: link the window to the bound project, or rebind the floor. Nothing was written.`, 409);
  if (!w.known) throw new HarnessError(`Unknown node ${at.nodeId}: it isn't on the canvas of project ${binding.project}, workspace ${binding.workspace} as last read. Nothing was written.`, 400);
}

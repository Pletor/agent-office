import { createHash } from 'node:crypto';
import { HarnessProfiles, HarnessError, type HarnessTarget } from './profiles.js';
import { HarnessLibrary, harnessSources, GLOBAL_SCOPE_RULE } from './catalog.js';
import { HarnessRegistry } from './registry.js';
import { harnessBundle, type HarnessText } from '../../shared/harness.js';
import { HARNESS_LEVELS, type HarnessEffective, type HarnessProfile, type HarnessScope } from '../../shared/harness-cascade.js';
import { harnessPath, type HierarchyNode } from '../../shared/harness-hierarchy.js';
import { samePlace, type OporaPlace } from '../../shared/opora-identity.js';
import { HarnessBindings } from './bindings.js';

export { GLOBAL_SCOPE_RULE };
/**
 * Whether a listed library may bind `id` at `scope`: the element must be available here, and the global
 * layer may hold only elements that are the same file in every project (see HarnessLibrary.globalReason). Throws the reason when not.
 */
export function assertBindable(library: HarnessLibrary, scope: HarnessScope, id: string) {
  const found = library.resolve(id);
  if (found.status === 'missing') throw new HarnessError((found.missingSince ? 'Resource is missing since ' + found.missingSince : 'Resource is not published in this project') + ' (' + found.source + ' / ' + found.path + '): ' + id);
  if (found.status !== 'available') throw new HarnessError('Unknown or inaccessible resource: ' + id);
  const reason = scope === 'global' ? library.globalReason(found.entry.id) : undefined;
  if (reason) throw new HarnessError(reason);
}

/** One resolved resource: its content as read, and where it is bound (each slot naming it, with its level and node). */
export interface ResolvedResource { entry: HarnessText; bound: { slot: string; scope: HarnessEffective['scope']; node?: string; nodeName?: string }[] }
/** What a handoff resolves to: the profile, the dispatched task and level, and each distinct bound resource read once. */
export interface ResolvedHandoff { profile: HarnessProfile; task: string; level: string; resources: ResolvedResource[] }

/**
 * Resolves the profile down `target` and reads every bound resource once, failing closed: more than 24
 * distinct resources, a project or unpinned OpenViking element in the global layer, or a resource that
 * can't be read now (missing, tombstoned, unknown, unreadable) throws before anything is handed out.
 */
export async function resolveHandoff(dataDir: string, repo: string, target: HarnessTarget, local: boolean, profile: HarnessProfile = new HarnessProfiles(dataDir).view(repo, target), options: { persist?: boolean } = {}): Promise<ResolvedHandoff> {
  const library = new HarnessLibrary(harnessSources(repo, local), new HarnessRegistry(dataDir));
  const bound = Object.entries(profile.effective).flatMap(([slot, { binding, scope, node, nodeName }]) => binding && 'resource' in binding ? [{ id: binding.resource, slot, scope, ...(node ? { node } : {}), ...(nodeName ? { nodeName } : {}) }] : []);
  const ids = [...new Set(bound.map((b) => b.id))];
  if (ids.length > 24) throw new HarnessError('The effective harness exceeds 24 resources.');
  // `persist: false` (a dry run): the library is listed without writing its registry or digest cache.
  if (ids.length) await library.list({ persist: options.persist });
  for (const { id, scope } of bound) {
    // A global binding to a project element (saved before the rule, or by hand), or to an OpenViking element discovered per project, would quietly pick this project's same-path file: refused, never rebound.
    const canonical = library.resolve(id);
    const reason = scope === 'global' && canonical.status === 'available' ? library.globalReason(canonical.entry.id) : undefined;
    if (reason) throw new HarnessError('Assigned harness resource is unavailable for this worker: ' + reason.replace(/^Project-scoped/, 'project-scoped'));
  }
  const resources: ResolvedResource[] = [];
  for (const id of ids) {
    const entry = await library.read(id);
    if (!entry) throw new HarnessError('Assigned harness resource is unavailable for this worker: ' + id);
    resources.push({ entry, bound: bound.filter((b) => b.id === id).map(({ id: _id, ...rest }) => rest) });
  }
  // What was dispatched: the deepest node of the path (a card, or a sector handed out whole), or a custom task id.
  const last = profile.path[profile.path.length - 1];
  const task = last?.node ?? (typeof target === 'string' ? target : '');
  const level = last?.level ?? (task ? 'task' : 'project');
  return { profile, task, level, resources };
}

/** The manifest a worker reads, pretty-printed: the task, its level, the path, the store revision and the effective slots with their provenance. */
export function handoffManifest(head: { task: string; level: string; path: HarnessProfile['path']; revision: number }, slots: HarnessProfile['effective'], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ task: head.task, level: head.level, path: head.path, revision: head.revision, slots, ...extra }, null, 2);
}

/** What every handoff says about what it is (and isn't): task context, never a grant. */
export const HANDOFF_CAVEAT = 'Settings and resources are task context, not permission grants. Tools/MCP/memory listed here are requirements, not proof of availability; report missing capabilities. Do not expose credentials.';

/** Resolve once, then embed the actual content: later edits at any level cannot change an already seated task. */
export async function harnessHandoff(dataDir: string, repo: string, target: HarnessTarget, local: boolean, profile?: HarnessProfile) {
  const resolved = await resolveHandoff(dataDir, repo, target, local, profile);
  const entries = resolved.resources.map((r) => r.entry);
  const manifest = handoffManifest({ task: resolved.task, level: resolved.level, path: resolved.profile.path, revision: resolved.profile.revision }, resolved.profile.effective);
  const body = manifest + '\n\n' + (entries.length ? harnessBundle(entries) : 'No resource instructions assigned.');
  if (Buffer.byteLength(body) > 96 * 1024) throw new HarnessError('Effective harness exceeds 96 KiB; choose smaller resources.');
  const digest = createHash('sha256').update(body).digest('hex');
  return `\n\n## Resolved Harness (${HARNESS_LEVELS.join(' → ')})\nSnapshot SHA-256: ${digest}\n${HANDOFF_CAVEAT}\n\n${body}`;
}

/**
 * The handoff for an Opora card: its way down the canvas (page, layer, area, sector) resolved with it.
 * A floor bound to another project or workspace than the card's (bindings.ts) hands nothing out: its
 * profiles are that project's, so the dispatch fails before the card is claimed, instead of seating a
 * worker with another project's harness.
 */
export async function harnessCardHandoff(dataDir: string, repo: string, place: OporaPlace, card: string, nodes: readonly HierarchyNode[], local: boolean) {
  cardBinding(dataDir, repo, place);
  return harnessHandoff(dataDir, repo, harnessPath(nodes, place, card), local);
}

/** The floor's binding when it may hand out a card of `place` (none, or the same project and workspace); throws 409 for another. */
export function cardBinding(dataDir: string, repo: string, place: OporaPlace): OporaPlace | undefined {
  const bound = new HarnessBindings(dataDir).forRepo(repo);
  if (bound && !samePlace(bound, place)) throw new HarnessError(`This floor is bound to Opora project ${bound.project}, workspace ${bound.workspace}, and the card is in project ${place.project}, workspace ${place.workspace}: link the window to the bound project, or rebind the floor, before handing cards out.`, 409);
  return bound ? { project: bound.project, workspace: bound.workspace } : undefined;
}

export function harnessPlannerBrief(prompt: string, id: string): string {
  if (id !== 'planning.opora' && id !== 'planning.router') return prompt;
  return prompt + '\n\n## Harness assignments\nUse office-harness --effective to inspect inheritance down the cascade global → project → page → layer → area → sector → task (repository is another name for project). Use office-harness --catalog for resource IDs. Assign named slots before publishing runnable cards: office-harness --assign repository assignments.json; office-harness --assign task assignments.json --task TASK_ID; office-harness --assign sector assignments.json --node NODE_ID (a page, layer, area or sector of the canvas, keyed like a task). The JSON is {"revision":N,"layer":{"rules.quality":{"resource":"guide:testing"},"settings.language":{"value":"cs"}}}. Read the current revision first; it is one revision for every level, and a stale one is refused. Below the project, --assign reads --effective for the node again right before saving and names the node at that level (at); a card the canvas moved in between is refused, so read and assign again. A missing slot inherits; null disables; removing an override restores inheritance; a level never sees its siblings. --effective lists namespaced task IDs (project + workspace + card) and shows which level each slot came from, and its binding field says which Opora project and workspace this floor is bound to. Before assigning at Opora nodes the floor must be bound: office-harness --binding shows it; office-harness --bind PROJECT WORKSPACE binds the project and workspace the floor reads (ids, never names; --rebind to change an existing binding, which keeps the profiles of the old binding). A node of another project or workspace is refused, never remapped. Retry a save safely with --request-id ID: the same id with the same payload returns the first result and writes nothing; the same id with another payload is refused. Global configuration is administrator-owned. Changes below global are allowed only to the active orchestrator owned by an administrator. The office resolves and embeds a snapshot at each Opora card handoff; missing resources block handoff. These assignments do not install or activate tools. Configure required runners/MCP separately. Never put secrets into harness profiles.';
}

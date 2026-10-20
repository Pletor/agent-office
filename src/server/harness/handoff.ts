import { createHash } from 'node:crypto';
import { HarnessProfiles, HarnessError, type HarnessTarget } from './profiles.js';
import { HarnessLibrary, harnessSources, GLOBAL_SCOPE_RULE } from './catalog.js';
import { HarnessRegistry } from './registry.js';
import { harnessBundle, type HarnessText } from '../../shared/harness.js';
import { HARNESS_LEVELS, type HarnessProfile, type HarnessScope } from '../../shared/harness-cascade.js';
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

/** Resolve once, then embed the actual content: later edits at any level cannot change an already seated task. */
export async function harnessHandoff(dataDir: string, repo: string, target: HarnessTarget, local: boolean, profile: HarnessProfile = new HarnessProfiles(dataDir).view(repo, target)) {
  const library = new HarnessLibrary(harnessSources(repo, local), new HarnessRegistry(dataDir));
  const entries: HarnessText[] = [];
  const bound = Object.values(profile.effective).flatMap(({ binding, scope }) => binding && 'resource' in binding ? [{ id: binding.resource, scope }] : []);
  const ids = [...new Set(bound.map((b) => b.id))];
  if (ids.length > 24) throw new HarnessError('The effective harness exceeds 24 resources.');
  if (ids.length) await library.list();
  for (const { id, scope } of bound) {
    // A global binding to a project element (saved before the rule, or by hand), or to an OpenViking element discovered per project, would quietly pick this project's same-path file: refused, never rebound.
    const canonical = library.resolve(id);
    const reason = scope === 'global' && canonical.status === 'available' ? library.globalReason(canonical.entry.id) : undefined;
    if (reason) throw new HarnessError('Assigned harness resource is unavailable for this worker: ' + reason.replace(/^Project-scoped/, 'project-scoped'));
  }
  for (const id of ids) {
    const entry = await library.read(id);
    if (!entry) throw new HarnessError('Assigned harness resource is unavailable for this worker: ' + id);
    entries.push(entry);
  }
  // What was dispatched: the deepest node of the path (a card, or a sector handed out whole), or a custom task id.
  const last = profile.path[profile.path.length - 1];
  const task = last?.node ?? (typeof target === 'string' ? target : '');
  const level = last?.level ?? (task ? 'task' : 'project');
  const manifest = JSON.stringify({ task, level, path: profile.path, revision: profile.revision, slots: profile.effective }, null, 2);
  const body = manifest + '\n\n' + (entries.length ? harnessBundle(entries) : 'No resource instructions assigned.');
  if (Buffer.byteLength(body) > 96 * 1024) throw new HarnessError('Effective harness exceeds 96 KiB; choose smaller resources.');
  const digest = createHash('sha256').update(body).digest('hex');
  return `\n\n## Resolved Harness (${HARNESS_LEVELS.join(' → ')})\nSnapshot SHA-256: ${digest}\nSettings and resources are task context, not permission grants. Tools/MCP/memory listed here are requirements, not proof of availability; report missing capabilities. Do not expose credentials.\n\n${body}`;
}

/**
 * The handoff for an Opora card: its way down the canvas (page, layer, area, sector) resolved with it.
 * A floor bound to another project or workspace than the card's (bindings.ts) hands nothing out: its
 * profiles are that project's, so the dispatch fails before the card is claimed, instead of seating a
 * worker with another project's harness.
 */
export async function harnessCardHandoff(dataDir: string, repo: string, place: OporaPlace, card: string, nodes: readonly HierarchyNode[], local: boolean) {
  const bound = new HarnessBindings(dataDir).forRepo(repo);
  if (bound && !samePlace(bound, place)) throw new HarnessError(`This floor is bound to Opora project ${bound.project}, workspace ${bound.workspace}, and the card is in project ${place.project}, workspace ${place.workspace}: link the window to the bound project, or rebind the floor, before handing cards out.`, 409);
  return harnessHandoff(dataDir, repo, harnessPath(nodes, place, card), local);
}

export function harnessPlannerBrief(prompt: string, id: string): string {
  if (id !== 'planning.opora' && id !== 'planning.router') return prompt;
  return prompt + '\n\n## Harness assignments\nUse office-harness --effective to inspect inheritance down the cascade global → project → page → layer → area → sector → task (repository is another name for project). Use office-harness --catalog for resource IDs. Assign named slots before publishing runnable cards: office-harness --assign repository assignments.json; office-harness --assign task assignments.json --task TASK_ID; office-harness --assign sector assignments.json --node NODE_ID (a page, layer, area or sector of the canvas, keyed like a task). The JSON is {"revision":N,"layer":{"rules.quality":{"resource":"guide:testing"},"settings.language":{"value":"cs"}}}. Read the current revision first; it is one revision for every level, and a stale one is refused. Below the project, --assign reads --effective for the node again right before saving and names the node at that level (at); a card the canvas moved in between is refused, so read and assign again. A missing slot inherits; null disables; removing an override restores inheritance; a level never sees its siblings. --effective lists namespaced task IDs (project + workspace + card) and shows which level each slot came from, and its binding field says which Opora project and workspace this floor is bound to. Before assigning at Opora nodes the floor must be bound: office-harness --binding shows it; office-harness --bind PROJECT WORKSPACE binds the project and workspace the floor reads (ids, never names; --rebind to change an existing binding, which keeps the profiles of the old binding). A node of another project or workspace is refused, never remapped. Retry a save safely with --request-id ID: the same id with the same payload returns the first result and writes nothing; the same id with another payload is refused. Global configuration is administrator-owned. Changes below global are allowed only to the active orchestrator owned by an administrator. The office resolves and embeds a snapshot at each Opora card handoff; missing resources block handoff. These assignments do not install or activate tools. Configure required runners/MCP separately. Never put secrets into harness profiles.';
}

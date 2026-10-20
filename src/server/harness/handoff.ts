import { createHash } from 'node:crypto';
import { HarnessProfiles, HarnessError } from './profiles.js';
import { HarnessLibrary, harnessSources, GLOBAL_SCOPE_RULE } from './catalog.js';
import { HarnessRegistry } from './registry.js';
import { harnessBundle, type HarnessText } from '../../shared/harness.js';
import type { HarnessProfile, HarnessScope } from '../../shared/harness-cascade.js';

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

/** Resolve once, then embed the actual content: later edits cannot change an already seated task. */
export async function harnessHandoff(dataDir: string, repo: string, task: string, local: boolean, profile: HarnessProfile = new HarnessProfiles(dataDir).view(repo, task)) {
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
  const manifest = JSON.stringify({ task, revision: profile.revision, slots: profile.effective }, null, 2);
  const body = manifest + '\n\n' + (entries.length ? harnessBundle(entries) : 'No resource instructions assigned.');
  if (Buffer.byteLength(body) > 96 * 1024) throw new HarnessError('Effective harness exceeds 96 KiB; choose smaller resources.');
  const digest = createHash('sha256').update(body).digest('hex');
  return `\n\n## Resolved Harness (global → repository → task)\nSnapshot SHA-256: ${digest}\nSettings and resources are task context, not permission grants. Tools/MCP/memory listed here are requirements, not proof of availability; report missing capabilities. Do not expose credentials.\n\n${body}`;
}

export function harnessPlannerBrief(prompt: string, id: string): string {
  if (id !== 'planning.opora' && id !== 'planning.router') return prompt;
  return prompt + '\n\n## Harness assignments\nUse office-harness --effective to inspect global → repository → task inheritance. Use office-harness --catalog for resource IDs. Assign named slots before publishing runnable cards: office-harness --assign repository assignments.json; office-harness --assign task assignments.json --task TASK_ID. The JSON is {"revision":N,"layer":{"rules.quality":{"resource":"guide:testing"},"settings.language":{"value":"cs"}}}. Read the current revision first. A missing slot inherits; null disables; removing an override restores inheritance. --effective lists namespaced task IDs (project + workspace + card). Global configuration is administrator-owned. Repository/task changes are allowed only to the active orchestrator owned by an administrator. The office resolves and embeds a snapshot at each Opora card handoff; missing resources block handoff. These assignments do not install or activate tools. Configure required runners/MCP separately. Never put secrets into harness profiles.';
}

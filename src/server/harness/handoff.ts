import { createHash } from 'node:crypto';
import { HarnessProfiles, HarnessError, type HarnessTarget } from './profiles.js';
import { HarnessLibrary, harnessSources } from './catalog.js';
import { harnessBundle, type HarnessText } from '../../shared/harness.js';
import { HARNESS_LEVELS, type HarnessProfile } from '../../shared/harness-cascade.js';
import { harnessPath, type HierarchyNode } from '../../shared/harness-hierarchy.js';
import type { OporaPlace } from '../../shared/opora-identity.js';

/** Resolve once, then embed the actual content: later edits at any level cannot change an already seated task. */
export async function harnessHandoff(dataDir: string, repo: string, target: HarnessTarget, local: boolean, profile: HarnessProfile = new HarnessProfiles(dataDir).view(repo, target)) {
  const library = new HarnessLibrary(harnessSources(repo, local));
  const entries: HarnessText[] = [];
  const ids = [...new Set(Object.values(profile.effective).flatMap(({ binding }) => binding && 'resource' in binding ? [binding.resource] : []))];
  if (ids.length > 24) throw new HarnessError('The effective harness exceeds 24 resources.');
  if (ids.length) await library.list();
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

/** The handoff for an Opora card: its way down the canvas (page, layer, area, sector) resolved with it. */
export function harnessCardHandoff(dataDir: string, repo: string, place: OporaPlace, card: string, nodes: readonly HierarchyNode[], local: boolean) {
  return harnessHandoff(dataDir, repo, harnessPath(nodes, place, card), local);
}

export function harnessPlannerBrief(prompt: string, id: string): string {
  if (id !== 'planning.opora' && id !== 'planning.router') return prompt;
  return prompt + '\n\n## Harness assignments\nUse office-harness --effective to inspect inheritance down the cascade global → project → page → layer → area → sector → task (repository is another name for project). Use office-harness --catalog for resource IDs. Assign named slots before publishing runnable cards: office-harness --assign repository assignments.json; office-harness --assign task assignments.json --task TASK_ID; office-harness --assign sector assignments.json --node NODE_ID (a page, layer, area or sector of the canvas, keyed like a task). The JSON is {"revision":N,"layer":{"rules.quality":{"resource":"guide:testing"},"settings.language":{"value":"cs"}}}. Read the current revision first; it is one revision for every level, and a stale one is refused. A missing slot inherits; null disables; removing an override restores inheritance; a level never sees its siblings. --effective lists namespaced task IDs (project + workspace + card) and shows which level each slot came from. Global configuration is administrator-owned. Changes below global are allowed only to the active orchestrator owned by an administrator. The office resolves and embeds a snapshot at each Opora card handoff; missing resources block handoff. These assignments do not install or activate tools. Configure required runners/MCP separately. Never put secrets into harness profiles.';
}

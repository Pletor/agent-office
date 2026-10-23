import { createHash } from 'node:crypto';
import { HarnessError } from './profiles.js';
import { HarnessLibrary, harnessSources } from './catalog.js';
import { HarnessRegistry } from './registry.js';
import { harnessBundle, type HarnessText } from '../../shared/harness.js';
import type { HarnessProfile, HarnessScope } from '../../shared/harness-cascade.js';
import { boundHarnessProfile } from './bound-profile.js';

/** Validate aliases against currently visible resources before binding them. */
export function assertBindable(library: HarnessLibrary, scope: HarnessScope, id: string) {
  const found = library.resolve(id);
  if (found.status === 'missing') throw new HarnessError('Resource is missing or not published in this project: ' + id);
  if (found.status !== 'available') throw new HarnessError('Unknown or inaccessible resource: ' + id);
  const reason = scope === 'global' ? library.globalReason(found.entry.id) : undefined;
  if (reason) throw new HarnessError(reason);
}

/** Resolve once, then embed the actual content: later edits cannot change an already seated task. */
export async function harnessHandoff(dataDir: string, repo: string, task: string, local: boolean, profile?: HarnessProfile) {
  profile ??= await boundHarnessProfile(dataDir, repo, task);
  const library = new HarnessLibrary(harnessSources(repo, local), new HarnessRegistry(dataDir));
  const entries: HarnessText[] = [];
  const ids = [...new Set(Object.values(profile.effective).flatMap(({ binding }) => binding && 'resource' in binding ? [binding.resource] : []))];
  if (ids.length > 24) throw new HarnessError('The effective harness exceeds 24 resources.');
  if (ids.length) await library.list();
  for (const { binding, scope } of Object.values(profile.effective)) {
    if (!binding || !('resource' in binding) || scope !== 'global') continue;
    const found = library.resolve(binding.resource);
    const reason = found.status === 'available' ? library.globalReason(found.entry.id) : undefined;
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
  return `\n\n## Resolved Harness (seven-level inheritance)\nSnapshot SHA-256: ${digest}\nSettings and resources are task context, not permission grants. Tools/MCP/memory listed here are requirements, not proof of availability; report missing capabilities. Do not expose credentials.\n\n${body}`;
}

export function harnessPlannerBrief(prompt: string, id: string): string {
  if (id !== 'planning.opora' && id !== 'planning.router') return prompt;
  prompt += '\n\nFor automatic preparation use office-harness --recommend PROBLEM [--task KEY] [--capability ID]... . Probe requirements in the actual runner before declaring a capability. Read constraints and selection reasons; the returned kit is a proposal, not activation. Publish narrowly scoped candidates in .harness/toolbox.json and test them before reuse. Native outcome counts compare exact versions; reported claims are not verified results. Honor disabled slots and settings.harness.auto=false. Recall native memory facts through the existing scoped Opora memory workflow and validate current Harness outcomes before reuse.';
  return prompt + '\n\n## Harness assignments\nFor a bound Opora project use office-harness --hierarchy to read bindingRevision and choices; --bind PROJECT WORKSPACE REVISION connects the currently open project. Read --hierarchy --task KEY, then --configure LEVEL assignments.json --task KEY with revision, pathDigest and the replacement layer. Levels: repository/page/layer/area/sector/task. Node writes require their own level and current ancestry. Legacy custom/unbound tasks use the commands below. Context v2 keeps its accepted immutable assignment; live profiles are not appended.\nUse office-harness --effective to inspect global → repository → task inheritance. Use office-harness --catalog for resource IDs. Assign named slots before publishing runnable cards: office-harness --assign repository assignments.json; office-harness --assign task assignments.json --task TASK_ID. The JSON is {"revision":N,"layer":{"rules.quality":{"resource":"guide:testing"},"settings.language":{"value":"cs"}}}. Read the current revision first. A missing slot inherits; null disables; removing an override restores inheritance. --effective lists namespaced task IDs (project + workspace + card). Global configuration is administrator-owned. Repository/task changes are allowed only to the active orchestrator owned by an administrator. The office resolves and embeds a snapshot at each Opora card handoff; missing resources block handoff. These assignments do not install or activate tools. Configure required runners/MCP separately. Never put secrets into harness profiles.';
}

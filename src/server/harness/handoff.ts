import { createHash } from 'node:crypto';
import { HarnessProfiles, HarnessError } from './profiles.js';
import { HarnessLibrary, harnessSources } from './catalog.js';
import { harnessBundle, type HarnessText } from '../../shared/harness.js';
import type { HarnessProfile } from '../../shared/harness-cascade.js';

/** Resolve once, then embed the actual content: later edits cannot change an already seated task. */
export async function harnessHandoff(dataDir: string, repo: string, task: string, local: boolean, profile: HarnessProfile = new HarnessProfiles(dataDir).view(repo, task)) {
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
  const manifest = JSON.stringify({ task, revision: profile.revision, slots: profile.effective }, null, 2);
  const body = manifest + '\n\n' + (entries.length ? harnessBundle(entries) : 'No resource instructions assigned.');
  if (Buffer.byteLength(body) > 96 * 1024) throw new HarnessError('Effective harness exceeds 96 KiB; choose smaller resources.');
  const digest = createHash('sha256').update(body).digest('hex');
  return `\n\n## Resolved Harness (global → repository → task)\nSnapshot SHA-256: ${digest}\nSettings and resources are task context, not permission grants. Tools/MCP/memory listed here are requirements, not proof of availability; report missing capabilities. Do not expose credentials.\n\n${body}`;
}

export function harnessPlannerBrief(prompt: string, id: string): string {
  if (id !== 'planning.opora' && id !== 'planning.router') return prompt;
  prompt += '\n\nFor context-protocol-2 cards, when the optional v2 writer and compatible native validator are installed, request office-harness --recommend PROBLEM --kit-schema harness.kit/2 --task KEY. Obtain the exact namespaced KEY from the linked hierarchy/effective profile; do not invent it. Add --capability ID only for capabilities checked in the intended worker runner, not inferred from the planner host or model name. Inspect constraints, warnings and selection provenance. A null kit is blocked; an unavailable integration is not success and must not silently downgrade v2. Put the returned kit unchanged in the target specification fields.harness through the normal proposal and acceptance flow, then dispatch a new accepted assignment. Profile edits alone do not equip a context-v2 card or change an already running kit. The worker reads --accepted-kit, checks --prepare-accepted when installed, uses supported adapters and returns their observations with task results; a successful tool call alone does not complete the card.';
  prompt += '\n\nFor automatic preparation use office-harness --recommend PROBLEM [--task KEY] [--capability ID]... . Probe requirements in the actual runner before declaring a capability. Read constraints and selection reasons; the returned kit is a proposal, not activation. Publish narrowly scoped candidates in .harness/toolbox.json and test them before reuse. Native outcome counts compare exact versions; reported claims are not verified results. Honor disabled slots and settings.harness.auto=false. Recall native memory facts through the existing scoped Opora memory workflow and validate current Harness outcomes before reuse.';
  return prompt + '\n\n## Harness assignments\nUse office-harness --effective to inspect global → repository → task inheritance. Use office-harness --catalog for resource IDs. Assign named slots before publishing runnable cards: office-harness --assign repository assignments.json; office-harness --assign task assignments.json --task TASK_ID. The JSON is {"revision":N,"layer":{"rules.quality":{"resource":"guide:testing"},"settings.language":{"value":"cs"}}}. Read the current revision first. A missing slot inherits; null disables; removing an override restores inheritance. --effective lists namespaced task IDs (project + workspace + card). Global configuration is administrator-owned. Repository/task changes are allowed only to the active orchestrator owned by an administrator. For legacy context handoff the office resolves and embeds the profile snapshot; missing resources block handoff. Context v2 instead uses only the already accepted immutable assignment, including its accepted kit. These assignments do not install or activate tools. Configure required runners/MCP separately. Never put secrets into harness profiles.';
}

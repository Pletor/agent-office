// Seating a worker for an Opora card with a run snapshot (snapshot.ts): resolve the card's profile,
// build and write the snapshot once, and hand the worker a short contract with the essential elements
// embedded and every other element listed by ID for `office-harness --read`. Everything that can fail
// fails here, before the bridge claims the card.
import { HarnessError } from './profiles.js';
import { HANDOFF_CAVEAT, cardBinding, handoffManifest, resolveHandoff } from './handoff.js';
import { HARNESS_GUIDES } from './guides.js';
import { EAGER_CATEGORIES, buildSnapshot, persistSnapshot, SNAPSHOT_LIMITS, SNAPSHOT_SCHEMA, type StoredSnapshot } from './snapshot.js';
import { harnessBundle } from '../../shared/harness.js';
import { HARNESS_LEVELS } from '../../shared/harness-cascade.js';
import { harnessPath, type HierarchyNode } from '../../shared/harness-hierarchy.js';
import type { OporaPlace } from '../../shared/opora-identity.js';

/** What the bridge seats a card's worker with: the prompt section, and the run it was pinned to. */
export interface HarnessRun { context: string; snapshot: { runId: string; digest: string } }

/**
 * The run for an Opora card: the floor's binding checked (bindings.ts), the profile down the card's way
 * through the canvas resolved, its elements pinned in a snapshot written once under the data dir, and
 * the worker's contract rendered from that snapshot. A missing, tombstoned or unreadable element, a
 * global binding to a project element, anything over its size limit, a failed redaction or a snapshot
 * that can't be written throws, so the bridge never claims the card.
 */
export async function harnessCardRun(dataDir: string, repo: string, place: OporaPlace, card: string, nodes: readonly HierarchyNode[], local: boolean): Promise<HarnessRun> {
  const binding = cardBinding(dataDir, repo, place) ?? null;
  const resolved = await resolveHandoff(dataDir, repo, harnessPath(nodes, place, card), local);
  const snapshot = buildSnapshot({ card: { ...place, nodeId: card }, binding, resolved, guides: HARNESS_GUIDES });
  const context = runContract(snapshot);
  if (Buffer.byteLength(context) > SNAPSHOT_LIMITS.eagerBytes + 32 * 1024) throw new HarnessError(`The worker's harness contract exceeds ${(SNAPSHOT_LIMITS.eagerBytes + 32 * 1024) / 1024} KiB; choose smaller resources.`);
  persistSnapshot(dataDir, snapshot);
  return { context, snapshot: { runId: snapshot.runId, digest: snapshot.digest } };
}

/**
 * The worker's contract: what the run is, when it is done, the essential elements in full, the rest
 * by ID with revision and digest, the commands, what to do when something fails, and the manifest.
 */
export function runContract(snapshot: StoredSnapshot): string {
  const { runId, digest } = snapshot;
  const eager = snapshot.elements.filter((e) => e.mode === 'eager');
  const lazy = snapshot.elements.filter((e) => e.mode === 'lazy');
  const line = (e: StoredSnapshot['elements'][number]) => `  - ${e.id} · ${e.category} · ${e.title} · revision ${e.version} · sha256:${e.digest.slice(0, 12)}${e.origin.bound.length ? ' · bound ' + e.origin.bound.map((b) => b.slot + '@' + b.scope).join(', ') : ''}${e.redacted ? ' · redacted' : ''}`;
  const manifest = handoffManifest(snapshot, snapshot.slots, {
    run: runId, schema: SNAPSHOT_SCHEMA, snapshot: digest, eager: snapshot.eager, lazy: snapshot.lazy,
    redactions: snapshot.redactions,
  });
  const bundle = eager.length ? harnessBundle(eager.map((e) => ({ id: e.id, title: e.title, category: e.category, group: '', source: e.origin.source, path: e.origin.path, version: e.version, digest: e.digest, aliases: [], text: snapshot.content[e.id] }))) : 'No essential instructions assigned; the guides above are read by ID.';
  const redactedNote = snapshot.redactions.length ? `\n- Redacted: ${snapshot.redactions.map((r) => `${r.kind} ×${r.count} in ${r.element}`).join('; ')}. The values were never stored; ask a person if you need one.` : '';
  return `\n\n## Resolved Harness (${HARNESS_LEVELS.join(' → ')})
Run: ${runId}
Snapshot SHA-256: ${digest} (${SNAPSHOT_SCHEMA}: exactly the element revisions below, pinned for this run)
${HANDOFF_CAVEAT}

Contract:
- Task: ${snapshot.task || '(custom)'} (${snapshot.level}). Done when the card's definition of done (node-brief --raw) is met, the checks it names were run, and agent-output carries the evidence.
- Essential instructions: the ${eager.length} element${eager.length === 1 ? '' : 's'} embedded below (categories ${EAGER_CATEGORIES.join(', ')}), with the repository's own rules.
- Guides and references, read by ID only when you need them: office-harness --read <id> (from this run's snapshot; add --run ${runId} to name it).
${lazy.length ? lazy.map(line).join('\n') : '  - none'}
- Provenance: name "harness run ${runId} sha256:${digest}" in your agent-output (the agentWorkspace log and the evidence note) and in the pull request body, so the card and everything you produce point back to exactly these instructions.
- If something fails: a read marked "changed since snapshot" or "no longer available" still returns the snapshot's text, which is the one to follow, never the library's current file. An element you need that isn't in this snapshot, or a refused read, goes into agent-output errors; stop and report rather than guess.${redactedNote}

Manifest:
${manifest}

${bundle}`;
}

import { createHash } from 'node:crypto';
import type { HarnessEntry } from '../../shared/harness.js';
import type { HarnessBinding, HarnessLayer, HarnessProfile } from '../../shared/harness-cascade.js';
import type { HarnessKit } from '../../shared/harness-kit.js';
import type { LearningRate } from '../../shared/harness-learning.js';
import { HarnessLibrary } from './catalog.js';
import { buildHarnessKit, kitBytes } from './kit.js';
import { HarnessError } from './profiles.js';
import { noHistory, type NativeHistory, type NativeGuardrails } from './native-outcomes.js';
import { toolbox, toolId } from './toolbox.js';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
interface Candidate {
  id: string; title: string; category: HarnessEntry['category']; digest: string; versionDigest: string; requires: string[];
  mandatory: boolean; baseline: boolean; disabled: boolean; missing: string[]; metadataMissing: boolean;
  priority: number; observed: boolean; low: boolean; reported: LearningRate | null; verified: LearningRate | null; tasks: number; state: string;
  guardrails: NativeGuardrails | null;
}
/** Same sorted metadata keys as Canvas's version digest; content has its own UTF-8 hash. */
export function toolVersion(resource: string, category: string, digest: string, requires: string[]) {
  return hash(JSON.stringify({ category, digest, requires, resource }));
}
function checkboxSlot(id: string) {
  let value = 2166136261; for (const char of id) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return 'resource.' + (value >>> 0).toString(16);
}
function disabled(profile: HarnessProfile | undefined, ids: string[]): Set<string> {
  const blocked = new Set<string>(), previous = new Map<string, HarnessBinding | null>();
  for (const layer of Object.values(profile?.layers ?? {}) as HarnessLayer[]) for (const [slot, binding] of Object.entries(layer)) {
    const before = previous.get(slot);
    if (before && 'resource' in before && (!binding || !('resource' in binding) || binding.resource !== before.resource)) blocked.add(before.resource);
    previous.set(slot, binding);
  }
  const active = new Set(Object.values(profile?.effective ?? {}).flatMap(({ binding }) => binding && 'resource' in binding ? [binding.resource] : []));
  for (const id of active) blocked.delete(id);
  for (const id of ids) if (!active.has(id) && previous.get(checkboxSlot(id)) === null) blocked.add(id);
  return blocked;
}

/** A preparation proposal only: no tool execution, profile writes or global promotion. */
export function validateRecommendation(problem: string, capabilities: string[]) {
  if (!toolId(problem) || capabilities.length > 32 || !capabilities.every(toolId) || new Set(capabilities).size !== capabilities.length) throw new HarnessError('Choose one problem ID and at most 32 distinct declared capabilities.');
}
export async function recommendHarness(library: HarnessLibrary, problem: string, capabilities: string[],
  profile?: HarnessProfile, history: NativeHistory = noHistory('no-native-peer')) {
  validateRecommendation(problem, capabilities);
  const catalog = await library.list(), policy = await toolbox(library, catalog.entries, problem), descriptors = policy.descriptors;
  const canonical = new Map(catalog.entries.flatMap(entry => [entry.id, ...((entry as { aliases?: string[] }).aliases ?? [])].map(id => [id, entry.id] as const)));
  const normalize = (id: string) => canonical.get(id) ?? id;
  const explicit = new Set(Object.values(profile?.effective ?? {}).flatMap(({ binding }) => binding && 'resource' in binding ? [normalize(binding.resource)] : []));
  const blocked = new Set([...disabled(profile, [...canonical.keys()])].map(normalize));
  for (const id of explicit) blocked.delete(id);
  const automatic = profile?.effective['settings.harness.auto']?.binding;
  const auto = !(automatic && 'value' in automatic && automatic.value === false);
  const baseline = auto ? ['guide:instructions', 'guide:testing'].filter(id => !blocked.has(id)) : [];
  const ids = [...new Set([...explicit, ...baseline, ...descriptors.keys()])];
  const candidates: Candidate[] = [];
  const constraints: { resource: string; reason: string; missing?: string[] }[] = [];
  for (const id of ids) {
    const entry: HarnessEntry | undefined = catalog.entries.find(entry => entry.id === id);
    if (!entry) { if (explicit.has(id)) constraints.push({ resource: id, reason: 'assigned-resource-unavailable' }); continue; }
    const text = await library.read(id);
    if (!text) throw new HarnessError('Resource changed or disappeared; retry preparation: ' + id, 409);
    const descriptor = descriptors.get(id), requires = descriptor?.requires ?? [], digest = hash(text.text);
    const version = toolVersion(id, entry.category, digest, requires);
    const rows = history.cohorts.filter(row => row.resource === id && row.digest === digest && row.versionDigest === version && row.problem === problem);
    const verified = rows.find(row => row.tier === 'verified'), reported = rows.find(row => row.tier === 'reported');
    const guardrails = verified?.guardrails ?? reported?.guardrails ?? null, flagged = !!guardrails?.affectedExecutions;
    const missing = requires.filter(requirement => !capabilities.includes(requirement));
    const metadataMissing = !descriptor && !id.startsWith('guide:') && ['scripts', 'tools', 'commands', 'hooks', 'mcp', 'plugins'].includes(entry.category);
    const mandatory = explicit.has(id);
    const observed = !flagged && !!verified && verified.rate.pass + verified.rate.fail >= 5 && verified.tasks >= 3
      && (verified.rate.coverage ?? 0) >= .8 && (verified.rate.interval95?.[0] ?? 0) >= 50;
    const low = !!verified && verified.rate.fail >= 4 && (verified.rate.interval95?.[1] ?? 100) < 50;
    if (mandatory && (missing.length || metadataMissing)) constraints.push({ resource: id, reason: metadataMissing ? 'tool-metadata-needed' : 'missing-declared-capabilities', missing });
    candidates.push({ id, title: entry.title, category: entry.category, digest, versionDigest: version, requires,
      mandatory, baseline: baseline.includes(id), disabled: blocked.has(id), missing, metadataMissing,
      priority: descriptor?.priority ?? 0, observed, low, guardrails,
      reported: reported?.rate ?? null, verified: verified?.rate ?? null, tasks: verified?.tasks ?? 0,
      state: blocked.has(id) ? 'disabled' : flagged ? 'regression-review-needed' : missing.length || metadataMissing ? 'needs-capabilities' : low ? 'low-observed-success' : observed ? 'observed-success' : 'candidate' });
  }
  const selected = candidates.filter(candidate => candidate.mandatory);
  const add = (candidate: typeof candidates[number]) => { if (!selected.some(entry => entry.id === candidate.id) && selected.length < 24) selected.push(candidate); };
  if (auto) {
    // A correlated incident must not optimize away the baseline instructions/testing policy.
    for (const candidate of candidates.filter(entry => entry.baseline && !entry.disabled)) add(candidate);
    const optional = candidates.filter(entry => !entry.mandatory && !entry.baseline && !entry.disabled && !entry.missing.length && !entry.metadataMissing && !entry.low && !entry.guardrails?.affectedExecutions);
    optional.sort((a, b) => (b.verified?.interval95?.[0] ?? 0) - (a.verified?.interval95?.[0] ?? 0) || b.priority - a.priority || (a.id < b.id ? -1 : 1));
    for (const candidate of optional.filter(entry => entry.observed).slice(0, 3)) add(candidate);
    const exploration = optional.find(entry => !entry.observed);
    if (exploration) add(exploration); // At most one insufficiently measured addition per preparation.
  }
  let kit: HarnessKit | null = null;
  if (!constraints.length) {
    kit = await buildHarnessKit(library, problem, selected.map(entry => entry.id));
    for (const resource of kit.resources) {
      const candidate = selected.find(entry => entry.id === resource.resource)!;
      if (resource.digest !== candidate.digest) throw new HarnessError('Tool content changed during recommendation. Retry preparation.', 409);
      resource.requires = candidate.requires;
    }
    const settings = Object.entries(profile?.effective ?? {}).filter(([, value]) => value.binding && 'value' in value.binding)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (settings.length) {
      const content = 'Inherited settings are context requirements, not permissions or provider flags.\n' + JSON.stringify(Object.fromEntries(settings));
      kit.resources.push({ slot: 'settings.profile', resource: 'profile:settings', category: 'instructions', digest: hash(content), content, requires: [] });
    }
    if (kit.resources.length > 24 || kitBytes(kit) > 96 * 1024) throw new HarnessError('Recommended kit exceeds 24 resources or 96 KiB. Narrow the inherited context.');
  }
  await policy.verify();
  return { schema: 'harness.recommendation/1', problem, profileRevision: profile?.revision ?? null, automatic: auto,
    proposalStatus: constraints.length ? 'blocked' : selected.some(entry => !entry.id.startsWith('guide:')) ? 'tools-proposed' : 'reference-only',
    unresolvedCandidateRequirements: [...new Set(candidates.filter(entry => !entry.disabled).flatMap(entry => entry.missing))],
    history: { status: history.status, limited: history.limited, reason: history.reason ?? null },
    capabilityEvidence: 'caller-declared; not native attestation or permission grants',
    association: 'selected-kit outcomes; actual invocation and causal contribution unobserved', promotionAllowed: false,
    constraints, warnings: selected.filter(entry => entry.guardrails?.affectedExecutions).map(entry => ({ resource: entry.id, reason: 'linked-regression-needs-review', preserved: entry.mandatory ? 'explicit' : 'baseline-policy' })), selected: selected.map(entry => entry.id), candidates, kit };
}

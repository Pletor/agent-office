/** Matches native harness.selection/1; valid caller claims are not attestations. */
import { createHash } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,199}(?![\s\S])/;
const NODE = /^[A-Za-z0-9][A-Za-z0-9_.:@/%+\-]{0,1023}(?![\s\S])/;
const SCOPES = new Set(['global', 'repository', 'page', 'layer', 'area', 'sector', 'task']);
const REASONS = new Set(['explicit-assignment', 'baseline-policy', 'native-stable', 'observed-outcomes',
  'shared-fixture-exploration', 'unknown-exploration', 'inherited-settings']);
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: unknown, names: string[]): v is Record<string, any> => object(v)
  && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const identifier = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const fail = (): never => { throw new Error('Invalid accepted Harness selection provenance.'); };

/** Resources are validated first. Never normalize an accepted snapshot. */
export function validateSelection(kit: Record<string, any>) {
  const selection = kit.selection;
  if (!keys(selection, ['schema', 'policy', 'problem', 'profileRevision', 'declaredCapabilities', 'evidence', 'entries'])
    || selection.schema !== 'harness.selection/1' || selection.policy !== 'harness.recommendation/1'
    || selection.evidence !== 'caller-declared-selection' || !kit.problems.includes(selection.problem)) return fail();
  if (selection.profileRevision !== null && (!Number.isSafeInteger(selection.profileRevision) || selection.profileRevision < 0)) return fail();
  const capabilities = selection.declaredCapabilities;
  if (!Array.isArray(capabilities) || capabilities.length > 32 || !capabilities.every(identifier)
    || new Set(capabilities).size !== capabilities.length) return fail();
  if (!Array.isArray(selection.entries) || selection.entries.length !== kit.resources.length) return fail();
  for (const [order, resource] of kit.resources.entries()) {
    const entry = selection.entries[order];
    const version = createHash('sha256').update(JSON.stringify({ category: resource.category, digest: resource.digest,
      requires: resource.requires, resource: resource.resource })).digest('hex');
    if (!keys(entry, ['resource', 'digest', 'versionDigest', 'order', 'reason', 'assignments'])
      || entry.resource !== resource.resource || entry.digest !== resource.digest || entry.versionDigest !== version
      || !Number.isSafeInteger(entry.order) || entry.order !== order || !REASONS.has(entry.reason)) return fail();
    const assignments = entry.assignments;
    if (!Array.isArray(assignments) || assignments.length > 32
      || (entry.reason === 'explicit-assignment') !== Boolean(assignments.length)) return fail();
    const seen = new Set<string>();
    for (const origin of assignments) {
      if (!keys(origin, ['slot', 'scope', 'node']) || !identifier(origin.slot) || !SCOPES.has(origin.scope)
        || seen.has(origin.slot)) return fail();
      if (origin.node !== null && (typeof origin.node !== 'string' || !NODE.test(origin.node)
        || origin.scope === 'global' || origin.scope === 'repository')) return fail();
      seen.add(origin.slot);
    }
    if (assignments.length && selection.profileRevision === null) return fail();
    const settings = resource.resource === 'profile:settings';
    if (settings !== (entry.reason === 'inherited-settings')) return fail();
    if (settings && (resource.slot !== 'settings.profile' || resource.category !== 'instructions' || resource.requires.length)) return fail();
    if (entry.reason === 'baseline-policy' && !['guide:instructions', 'guide:testing'].includes(resource.resource)) return fail();
  }
}

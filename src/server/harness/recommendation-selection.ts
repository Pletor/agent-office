import type { HarnessProfile } from '../../shared/harness-cascade.js';
import { recommendHarness, toolVersion } from './recommend.js';
import { HarnessError } from './profiles.js';

type Recommendation = Awaited<ReturnType<typeof recommendHarness>>;

/** Pin the actual decision and effective origins, never reconstruct a missing hierarchy. */
export async function recommendationSelection(input: Recommendation, profile: HarnessProfile, capabilities: string[]) {
  const result = structuredClone(input), effective = structuredClone(profile.effective);
  if (!result.kit) return result;
  const entries = result.kit.resources.map((resource, order) => {
    if (resource.resource === 'profile:settings') return { resource: resource.resource, digest: resource.digest,
      versionDigest: toolVersion(resource.resource, resource.category, resource.digest, resource.requires),
      order, reason: 'inherited-settings', assignments: [] };
    const decision = result.selection.find(entry => entry.resource === resource.resource);
    if (!decision || decision.order !== order || decision.digest !== resource.digest
      || decision.versionDigest !== toolVersion(resource.resource, resource.category, resource.digest, resource.requires))
      throw new HarnessError('Recommendation selection changed before pinning provenance.', 409);
    const assignments = decision.assignments.map(origin => {
      const actual = effective[origin.slot] as { scope: string; node?: string } | undefined;
      if (!actual || actual.scope !== origin.scope) throw new HarnessError('Selection origin changed. Retry preparation.', 409);
      const top = ['global', 'repository'].includes(actual.scope);
      if (!top && !actual.node) throw new HarnessError('Selection origin requires the installed hierarchy resolver.', 409);
      return { ...origin, node: top ? null : actual.node! };
    });
    return { ...decision, assignments };
  });
  const kit = { ...result.kit, schema: 'harness.kit/2', selection: {
    schema: 'harness.selection/1', policy: 'harness.recommendation/1', problem: result.problem,
    profileRevision: result.profileRevision, declaredCapabilities: [...capabilities],
    evidence: 'caller-declared-selection', entries } };
  const modulePath = './accepted-kit.js';
  let validate: (value: unknown) => unknown;
  try { validate = (await import(modulePath)).validateAcceptedKit;
    if (typeof validate !== 'function') throw new Error();
  } catch { throw new HarnessError('Accepted kit v2 validator is unavailable in this Office installation.', 409); }
  validate(kit); // Includes all resources, provenance, configuration digests and the whole-kit size limit.
  return { ...result, kit, selectionEvidence: 'caller-declared-selection; proposal requires normal acceptance' };
}

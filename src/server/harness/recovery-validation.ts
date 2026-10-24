import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateAcceptedKit } from './accepted-kit.js';

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const hash = (v: unknown, length: number) => typeof v === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(v) && v.length === length;
const fail = (): never => { throw new Error('Invalid historical recovery proposal'); };

/** The peer can propose one historical replacement, never a new scope, tool, requirement or permission. */
export function validateRecovery(value: unknown, current: Record<string, any>, kit: Record<string, any>, resource: string, sourceId: string) {
  if (!object(value) || value.schema !== 'harness.recovery-proposal/1' || !object(value.scope)
    || !['project', 'workspace', 'nodeId'].every(key => value.scope[key] === current[key])
    || !['executionId', 'epoch', 'assignmentDigest', 'acceptedRevision'].every(key => value[key] === current[key])
    || value.requiresAcceptance !== true || value.promotionAllowed !== false || !object(value.source)
    || value.source.executionId !== sourceId || sourceId === current.executionId || value.source.resource !== resource
    || !hash(value.source.assignmentDigest, 64) || !hash(value.source.acceptedRevision, 40)
    || !hash(value.source.digest, 64) || !hash(value.source.versionDigest, 64) || !object(value.evidence)
    || !['unknown', 'pass'].includes(value.evidence.verifiedOutcome)
    || !['unavailable', 'no-recorded-failure'].includes(value.evidence.fixtureHistory)
    || !(value.evidence.sourceEvent === null || (Number.isSafeInteger(value.evidence.sourceEvent) && value.evidence.sourceEvent > 0))) return fail();
  const proposed = validateAcceptedKit(value.kit);
  const proposedResources = proposed.resources as Record<string, any>[];
  if (!isDeepStrictEqual(proposed.problems, kit.problems) || proposedResources.length !== kit.resources.length) return fail();
  let replacement: Record<string, any> | undefined;
  for (let index = 0; index < kit.resources.length; index++) {
    const before = kit.resources[index], after = proposedResources[index];
    if (before.resource !== resource) { if (!isDeepStrictEqual(before, after)) return fail(); continue; }
    if (after.resource !== resource || after.slot !== before.slot || after.category !== before.category
      || !isDeepStrictEqual([...after.requires].sort(), [...before.requires].sort()) || after.digest === before.digest
      || after.digest !== value.source.digest) return fail();
    replacement = after;
  }
  if (!replacement) return fail();
  const version = createHash('sha256').update(JSON.stringify({ category: replacement.category, digest: replacement.digest,
    requires: replacement.requires, resource: replacement.resource })).digest('hex');
  if (version !== value.source.versionDigest) return fail();
  return { schema: 'harness.recovery-proposal/1', scope: { project: current.project, workspace: current.workspace, nodeId: current.nodeId },
    executionId: current.executionId, epoch: current.epoch, assignmentDigest: current.assignmentDigest, acceptedRevision: current.acceptedRevision,
    source: { executionId: sourceId, resource, digest: replacement.digest, versionDigest: version,
      assignmentDigest: value.source.assignmentDigest, acceptedRevision: value.source.acceptedRevision },
    evidence: { verifiedOutcome: value.evidence.verifiedOutcome, sourceEvent: value.evidence.sourceEvent, fixtureHistory: value.evidence.fixtureHistory },
    kit: proposed, requiresAcceptance: true, promotionAllowed: false,
    meaning: 'Historical candidate only. Submit through normal specification acceptance; the running assignment is unchanged.' };
}

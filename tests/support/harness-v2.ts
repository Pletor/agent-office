import { createHash } from 'node:crypto';
export function v2Kit(kit: { schema: string; problems: string[]; resources: Record<string, any>[] }) {
  return { ...kit, schema: 'harness.kit/2', selection: {
    schema: 'harness.selection/1', policy: 'harness.recommendation/1', problem: kit.problems[0],
    profileRevision: 3, declaredCapabilities: ['command:node'], evidence: 'caller-declared-selection',
    entries: kit.resources.map((r, order) => ({ resource: r.resource, digest: r.digest, order,
      versionDigest: createHash('sha256').update(JSON.stringify({ category: r.category, digest: r.digest,
        requires: r.requires, resource: r.resource })).digest('hex'), reason: 'explicit-assignment',
      assignments: [{ slot: 'work', scope: 'task', node: 'opora:p:w:card' }] })) } };
}

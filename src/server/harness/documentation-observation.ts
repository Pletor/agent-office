import { randomUUID } from 'node:crypto';

/** Only bounded metadata is reportable; questions, retrieved text and credentials stay out. */
export function documentationObservation(execution: Record<string, unknown>, resource: { id: string; digest: string },
  document: { library: string; digest: string; fetchedAt: string; elapsedMs: number; text: string }) {
  const keys = ['executionId', 'epoch', 'project', 'workspace', 'nodeId', 'acceptedRevision', 'assignmentDigest'];
  return { schema: 'harness.documentation-observation/1', readId: randomUUID(),
    execution: Object.fromEntries(keys.map(key => [key, execution[key]])), resource,
    adapter: 'context7-documentation/1', library: document.library, documentDigest: document.digest,
    fetchedAt: document.fetchedAt, durationMs: document.elapsedMs, outputBytes: Buffer.byteLength(document.text),
    evidence: 'worker-reported', independentlyVerified: false, causalContribution: false, promotionAllowed: false };
}

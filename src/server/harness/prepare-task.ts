import type { acceptedReceipt } from './invoke-node.js';
import { prepareAccepted } from './prepare-accepted.js';
import type { DocumentationProbe } from './prepare-documentation.js';

/** Automatic task preparation distinguishes an explicitly absent kit from unavailable authority. */
export async function prepareTask(read: () => ReturnType<typeof acceptedReceipt>, cwd: string,
  options: { documentation?: DocumentationProbe } = {}) {
  const first = await read();
  if (first.kit !== null) return { ...await prepareAccepted(async () => {
    const current = await read();
    if (JSON.stringify(current.execution) !== JSON.stringify(first.execution)) throw new Error('Execution changed before preparation');
    return current;
  }, cwd, options), kitPresent: true };
  const current = await read();
  const unchanged = current.kit === null && JSON.stringify(current.execution) === JSON.stringify(first.execution);
  return { schema: 'harness.preparation/1', scope: 'worker-process', execution: first.execution,
    kitPresent: false, resources: [], ready: unchanged, authorityCurrentAtCompletion: unchanged, cleanupComplete: true,
    reason: unchanged ? 'accepted-task-has-no-kit' : 'execution-changed-or-unavailable',
    evidence: 'worker-observed', independentlyVerified: false, promotionAllowed: false,
    resourceContentsExecuted: false, permissionsGranted: false };
}

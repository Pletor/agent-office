import type { ExecutionController } from '../opora/execution-controller.js';
import { nativeHarnessGrant } from './native-grant.js';
import { validateRecovery } from './recovery-validation.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}$/;
const EXECUTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const failure = () => new Error('Historical recovery is unavailable, incompatible or unauthorized.');

/** Existing private bundle is read internally, never selected by a worker or reflected to it. */
export async function recoverTool(controller: ExecutionController, dataDir: string, worker: string,
  resource: string, sourceExecutionId: string, transport: typeof fetch = fetch) {
  try {
    if (!ID.test(resource) || /[\r\n]/.test(resource) || !EXECUTION.test(sourceExecutionId) || /[\r\n]/.test(sourceExecutionId)) throw failure();
    const grant = nativeHarnessGrant(controller, dataDir, worker, transport);
    if (!(grant.kit.resources as Record<string, unknown>[]).some(entry => entry.resource === resource)) throw failure();
    const value = await grant.request('/api/oporahub/harness-recovery', { sourceExecutionId, resource });
    const result = validateRecovery(value, grant.current, grant.kit, resource, sourceExecutionId);
    grant.assertCurrent();
    return result;
  } catch { throw failure(); }
}

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ExecutionController } from '../opora/execution-controller.js';
import { validateExecution } from '../opora/execution-client.js';
import { validateBudgetFiles } from '../opora/execution-budget-files.js';
import { acceptedKit } from './accepted-kit.js';
import { validateRecovery } from './recovery-validation.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}$/;
const EXECUTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const failure = () => new Error('Historical recovery is unavailable, incompatible or unauthorized.');
const binding = (value: Record<string, unknown>) => ['executionId', 'project', 'workspace', 'nodeId', 'epoch',
  'acceptedRevision', 'assignmentDigest'].map(key => value[key]);

/** Existing private bundle is read internally, never selected by a worker or reflected to it. */
export async function recoverTool(controller: ExecutionController, dataDir: string, worker: string,
  resource: string, sourceExecutionId: string, transport: typeof fetch = fetch) {
  try {
    if (!ID.test(resource) || /[\r\n]/.test(resource) || !EXECUTION.test(sourceExecutionId) || /[\r\n]/.test(sourceExecutionId)) throw failure();
    const current = controller.assignmentFor(worker);
    if (!current || current.contextProtocolVersion !== 2 || !EXECUTION.test(current.executionId)) throw failure();
    const kit = acceptedKit(current.assignment, current.nodeId);
    if (!kit || !(kit.resources as Record<string, unknown>[]).some(entry => entry.resource === resource)) throw failure();
    const file = path.join(dataDir, 'opora-executions', current.executionId + '.json');
    const raw = readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw failure();
    const bundle = JSON.parse(raw), lease = validateExecution(bundle, current);
    if (!isDeepStrictEqual(binding(lease as unknown as Record<string, unknown>), binding(current))
      || !isDeepStrictEqual(lease.assignment, current.assignment)) throw failure();
    validateBudgetFiles(dataDir, controller.client.base, controller.client.agent, lease);
    const base = new URL(controller.client.base);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw failure();
    const response = await transport(new URL('/api/oporahub/harness-recovery', base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', origin: base.origin, 'X-Opora-Actor': `agent; name=${controller.client.agent}` },
      body: JSON.stringify({ project: current.project, workspace: current.workspace, executionId: current.executionId,
        epoch: current.epoch, token: lease.token, sourceExecutionId, resource }),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw failure(); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
        if (bytes > 128 * 1024) throw failure(); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const value = JSON.parse(text);
    if (JSON.stringify(value).includes(lease.token)) throw failure();
    const result = validateRecovery(value, current, kit, resource, sourceExecutionId);
    const after = controller.assignmentFor(worker);
    if (!after || !isDeepStrictEqual(binding(after), binding(current))) throw failure();
    return result;
  } catch { throw failure(); }
}

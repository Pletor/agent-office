import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ExecutionController } from '../opora/execution-controller.js';
import { validateExecution } from '../opora/execution-client.js';
import { validateBudgetFiles } from '../opora/execution-budget-files.js';
import { acceptedKit } from './accepted-kit.js';

const EXECUTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const failure = () => new Error('Native Harness evidence is unavailable or unauthorized.');
const binding = (value: Record<string, unknown>) => ['executionId', 'project', 'workspace', 'nodeId', 'epoch',
  'acceptedRevision', 'assignmentDigest'].map(key => value[key]);

/** Server-private current grant and bounded transport, shared by recovery and lifecycle. */
export function nativeHarnessGrant(controller: ExecutionController, dataDir: string, worker: string, transport: typeof fetch = fetch) {
  const current = controller.assignmentFor(worker);
  if (!current || current.contextProtocolVersion !== 2 || !EXECUTION.test(current.executionId)) throw failure();
  const kit = acceptedKit(current.assignment, current.nodeId);
  if (!kit) throw failure();
  const file = path.join(dataDir, 'opora-executions', current.executionId + '.json');
  const raw = readFileSync(file, 'utf8');
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw failure();
  const bundle = JSON.parse(raw), lease = validateExecution(bundle, current);
  if (!isDeepStrictEqual(binding(lease as unknown as Record<string, unknown>), binding(current))
    || !isDeepStrictEqual(lease.assignment, current.assignment)) throw failure();
  validateBudgetFiles(dataDir, controller.client.base, controller.client.agent, lease);
  const base = new URL(controller.client.base);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw failure();
  const assertCurrent = () => {
    const after = controller.assignmentFor(worker);
    if (!after || !isDeepStrictEqual(binding(after), binding(current))) throw failure();
  };
  const post = async (endpoint: string, fields: Record<string, unknown>, timeoutMs = 8000) => {
    assertCurrent();
    const response = await transport(new URL(endpoint, base), {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', origin: base.origin, 'X-Opora-Actor': `agent; name=${controller.client.agent}` },
      body: JSON.stringify(fields),
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
    assertCurrent();
    return value as unknown;
  };
  // A verifier run is bounded by Canvas (90 s plus container cleanup); everything else answers at once.
  const request = (endpoint: '/api/oporahub/harness-recovery' | '/api/oporahub/harness-verifier/eligibility' | '/api/oporahub/harness-verifier/requests', fields: Record<string, unknown>) =>
    post(endpoint, { ...fields, project: current.project, workspace: current.workspace, executionId: current.executionId,
      epoch: current.epoch, token: lease.token }, endpoint.endsWith('/requests') ? 150_000 : 8000);
  const publicationRequest = (endpoint: '/api/oporahub/harness-verifier/eligibility/shared' | '/api/oporahub/harness-shared-memory/publish' | '/api/oporahub/harness-shared-memory/recall', publication: string) =>
    post(endpoint, { publication });
  return { current, kit, peer: base.origin, assertCurrent, request, publicationRequest };
}

/** Accepted content integrity before claim/seat, not a probe of the future worker environment. */
import { isDeepStrictEqual } from 'node:util';
import { ExecutionError } from '../opora/execution-client.js';
import type { PreflightInput, PreparedExecutionCheck } from '../opora/execution-preflights.js';
import { acceptedKit, validateAcceptedKit } from './accepted-kit.js';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const fail = (): never => { throw new ExecutionError(409, true, 'Accepted Harness preflight is unavailable or changed; refresh the accepted task.'); };

export async function harnessExecutionPreflight(input: PreflightInput): Promise<PreparedExecutionCheck> {
  const enabled = process.env.AGENT_OFFICE_HARNESS_PREFLIGHT;
  if (enabled === undefined) return () => {};
  if (enabled !== '1') throw new Error('AGENT_OFFICE_HARNESS_PREFLIGHT must be unset or 1');
  if (input.contextVersion !== 2) return () => {};
  const { client, scope } = input;
  const context = await client.context(scope, 2);
  if (!context.available || !context.acceptedHead || !context.contextVersion) return fail();
  let value: unknown;
  try {
    const response = await fetch(new URL('/api/oporahub/harness-preflight', client.base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: new URL(client.base).origin,
        'X-Opora-Actor': `agent; name=${client.agent}` },
      body: JSON.stringify({ ...scope, expectedAcceptedHead: context.acceptedHead, expectedContextVersion: context.contextVersion }),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); return fail(); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 256 * 1024) { await reader.cancel(); return fail(); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return fail(); }
  if (!object(value) || value.schema !== 'harness.preflight/1' || !isDeepStrictEqual(value.scope, scope)
    || value.contextProtocolVersion !== 2 || value.acceptedHead !== context.acceptedHead
    || value.contextVersion !== context.contextVersion || !hash(value.assignmentDigest)
    || value.evidence !== 'accepted-context-preview' || value.executionAuthority !== false
    || value.runnerReadinessVerified !== false || value.permissionsGranted !== false) return fail();
  let kit: unknown;
  try { kit = value.kit === null ? null : structuredClone(validateAcceptedKit(value.kit)); } catch { return fail(); }
  if (kit === null ? value.kitDigest !== null : !hash(value.kitDigest)) return fail();
  const digest = value.assignmentDigest;
  return lease => {
    if (lease.contextProtocolVersion !== 2 || lease.project !== scope.project || lease.workspace !== scope.workspace
      || lease.nodeId !== scope.nodeId || lease.acceptedRevision !== context.acceptedHead
      || lease.assignment.contextVersion !== context.contextVersion || lease.assignmentDigest !== digest) return fail();
    try { if (!isDeepStrictEqual(acceptedKit(lease.assignment, scope.nodeId), kit)) return fail(); }
    catch { return fail(); }
  };
}

/** Fresh project evidence from a retained native verification, never execution authority. */
import { validateStability, type StabilityScope } from './stability-validation.js';

export interface RetainedVersion { id: string; digest: string; category: string; requires: string[] }
export interface RetainedSource { verificationId: string; reportDigest: string }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}(?![\s\S])/.test(v);
const identity = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}(?![\s\S])/.test(v);
function fail(): never { throw new Error('Retained native stability evidence is unavailable.'); }

export function validateRetainedStability(value: unknown, scope: StabilityScope, version: RetainedVersion, source: RetainedSource) {
  if (!identity(source.verificationId) || !hex(source.reportDigest) || !object(value)
    || value.schema !== 'harness.retained-stability/1' || value.executionAuthority !== false
    || !object(value.source) || value.source.kind !== 'retained-native-verification'
    || value.source.verificationId !== source.verificationId || !hex(value.source.requestDigest)
    || !(value.source.reportDigest === source.reportDigest || (value.eligible === false && value.source.reportDigest === null))
    || version.category !== 'scripts' || version.requires.length !== 1 || version.requires[0] !== 'command:node'
    || !object(value.plan) || !id(value.plan.id) || !hex(value.plan.digest)
    || !object(value.baseline) || !id(value.baseline.id) || !hex(value.baseline.digest)
    || !object(value.execution) || !identity(value.execution.executionId) || !id(value.execution.nodeId)
    || !Number.isSafeInteger(value.execution.epoch) || value.execution.epoch < 1
    || !id(value.execution.acceptedRevision) || !hex(value.execution.assignmentDigest)) fail();
  // The retained native source binds historical execution metadata. It is not a
  // current lease: reuse the common policy/count/output validator, not grant auth.
  const checked = validateStability({ ...value, schema: 'harness.stability-eligibility/1' },
    { ...value.execution, project: scope.project, workspace: scope.workspace }, scope.peer,
    { reference: { id: value.plan.id, digest: value.plan.digest }, problem: scope.problem, candidate: { ...version, category: 'scripts' },
      baseline: { id: value.baseline.id, digest: value.baseline.digest, category: 'scripts', requires: ['command:node'] } });
  if (checked.eligible && !value.comparison.reports.some((r: any) =>
    r.verificationId === source.verificationId && r.reportDigest === source.reportDigest)) fail();
  return { ...checked, ...(checked.eligible ? { source: { ...source } } : {}) };
}

export async function readRetainedStability(scope: StabilityScope, version: RetainedVersion,
  source: RetainedSource, transport: typeof fetch = fetch) {
  const origin = new URL(scope.peer);
  if (!['http:', 'https:'].includes(origin.protocol) || scope.peer !== origin.origin
    || origin.username || origin.password || !id(scope.project) || !id(scope.workspace) || !id(scope.problem)
    || !identity(source.verificationId) || !hex(source.reportDigest)) fail();
  const response = await transport(new URL('/api/oporahub/harness-verifier/eligibility/retained', origin), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', origin: origin.origin,
      'X-Opora-Actor': 'agent; name=office-harness' },
    body: JSON.stringify({ project: scope.project, workspace: scope.workspace, verificationId: source.verificationId }),
  });
  if (!response.ok || !response.body) { await response.body?.cancel(); return fail(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
    if (size > 256 * 1024) fail(); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return validateRetainedStability(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), scope, version, source);
}

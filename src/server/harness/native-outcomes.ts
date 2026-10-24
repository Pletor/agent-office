import { learningRateCounts, type LearningRate } from '../../shared/harness-learning.js';

export interface NativeGuardrails { source: 'native-review-eval-cases'; affectedExecutions: number; incidentReportExecutions: number; revertedExecutions: number; productionExposure: 'unknown'; causalAttribution: false }
export interface NativeCohort { resource: string; digest: string; versionDigest: string; problem: string; tier: string; tasks: number; rate: LearningRate; guardrails?: NativeGuardrails }
export interface NativeHistory { status: 'available' | 'unavailable'; limited: boolean; cohorts: NativeCohort[]; reason?: string }
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const hex = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}$/.test(value);
export const noHistory = (reason: string): NativeHistory => ({ status: 'unavailable', limited: false, cohorts: [], reason });

function guardrails(value: unknown, executions: number): NativeGuardrails | undefined {
  if (value === undefined) return;
  if (!object(value) || value.source !== 'native-review-eval-cases' || value.productionExposure !== 'unknown' || value.causalAttribution !== false) throw new Error('Invalid native guardrails');
  const counts = [value.affectedExecutions, value.incidentReportExecutions, value.revertedExecutions];
  if (!counts.every(count => Number.isSafeInteger(count) && count >= 0 && count <= executions)
    || counts[0] < Math.max(counts[1], counts[2]) || counts[0] > counts[1] + counts[2]) throw new Error('Inconsistent native guardrails');
  return { source: 'native-review-eval-cases', affectedExecutions: counts[0], incidentReportExecutions: counts[1], revertedExecutions: counts[2], productionExposure: 'unknown', causalAttribution: false };
}

/** The configured native peer is the trust anchor; counts are checked and rates recomputed. */
export function parseNativeHistory(value: unknown, project: string, workspace: string): NativeHistory {
  if (!object(value) || value.schema !== 'harness.learning/1' || value.authority !== 'native-outbox-projection'
    || !object(value.scope) || value.scope.project !== project || value.scope.workspace !== workspace || value.scope.nodeId !== null
    || typeof value.limited !== 'boolean' || !Array.isArray(value.cohorts) || value.cohorts.length > 100) throw new Error('Invalid native history');
  const seen = new Set<string>();
  const cohorts = value.cohorts.map((row: unknown): NativeCohort => {
    if (!object(row) || !identifier(row.resource) || !hex(row.digest) || !hex(row.versionDigest)
      || !identifier(row.problem) || row.signal !== 'acceptance'
      || !['reported', 'verified'].includes(row.tier) || !object(row.rate) || !Number.isSafeInteger(row.tasks) || row.tasks < 0) throw new Error('Invalid native cohort');
    const rate = learningRateCounts(row.rate.pass, row.rate.fail, row.rate.unknown);
    if (row.rate.executions !== rate.executions || row.tasks > rate.executions) throw new Error('Inconsistent native counts');
    const key = JSON.stringify([row.resource, row.versionDigest, row.problem, row.tier]);
    if (seen.has(key)) throw new Error('Duplicate native cohort'); seen.add(key);
    return { resource: row.resource, digest: row.digest, versionDigest: row.versionDigest, problem: row.problem, tier: row.tier, tasks: row.tasks, rate, guardrails: guardrails(row.guardrails, rate.executions) };
  });
  return { status: 'available', limited: value.limited, cohorts };
}
export async function nativeHistory(base: string, project: string, workspace: string, read: typeof fetch = fetch): Promise<NativeHistory> {
  try {
    const origin = new URL(base);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) return noHistory('invalid-configured-peer');
    const url = new URL('/api/oporahub/harness-learning', origin);
    url.search = new URLSearchParams({ project, workspace, limit: '100' }).toString();
    const response = await read(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json', 'cache-control': 'no-store', 'X-Opora-Actor': 'agent; name=office-harness' } });
    if (!response.ok || !response.body) { await response.body?.cancel(); return noHistory('native-history-unavailable'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 256 * 1024) throw new Error('History too large'); chunks.push(next.value); } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return parseNativeHistory(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), project, workspace);
  } catch { return noHistory('native-history-invalid-or-unreachable'); }
}

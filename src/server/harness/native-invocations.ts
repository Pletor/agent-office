export interface InvocationScope { project: string; workspace: string; nodeId: string | null }
export interface InvocationCohort {
  resource: string; digest: string; adapter: 'node-readonly/1'; nodeVersion: string; problem: string;
  invocations: number; pass: number; fail: number; percent: number; meanDurationMs: number;
  outputBytes: number; executions: number; tasks: number; latestSourceReceipt: string;
}
export interface NativeInvocations {
  status: 'available' | 'unavailable'; scope: InvocationScope; authority: 'native-result-receipts'; evidence: 'worker-reported';
  serverObserved: false; independentlyVerified: false; causalContribution: false; promotionAllowed: false;
  coverage: 'submitted valid observations only; missing invocations unobserved; not independent trials';
  scannedReceipts: number; limited: boolean; receiptWindowLimited: boolean; cohortsLimited: boolean;
  invalidReceipts: number; conflictingInvocations: number; tokens: null; cost: null;
  cohorts: InvocationCohort[]; reason?: string;
}
const unavailableCoverage = 'submitted valid observations only; missing invocations unobserved; not independent trials' as const;
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v);
const stableId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}$/.test(v);
const printable = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && /^[\x20-\x7e]+$/.test(v);
const count = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const empty = (reason: string): NativeInvocations => ({ status: 'unavailable', scope: { project: '', workspace: '', nodeId: null },
  authority: 'native-result-receipts', evidence: 'worker-reported', serverObserved: false, independentlyVerified: false,
  causalContribution: false, promotionAllowed: false, coverage: unavailableCoverage, scannedReceipts: 0, limited: false,
  receiptWindowLimited: false, cohortsLimited: false, invalidReceipts: 0, conflictingInvocations: 0,
  tokens: null, cost: null, cohorts: [], reason });
export function noInvocations(reason: string): NativeInvocations {
  return { ...empty('native-invocations-unavailable'), reason: id(reason) ? reason.slice(0, 80) : 'native-invocations-unavailable' };
}

export function parseNativeInvocations(value: unknown, scope: InvocationScope): NativeInvocations {
  if (!id(scope.project) || !id(scope.workspace) || !(scope.nodeId === null || id(scope.nodeId))) throw new Error('Invalid invocation scope');
  if (!obj(value) || value.schema !== 'harness.invocations/1' || value.authority !== 'native-result-receipts'
    || value.evidence !== 'worker-reported' || value.serverObserved !== false || value.independentlyVerified !== false
    || value.causalContribution !== false || value.promotionAllowed !== false || value.tokens !== null || value.cost !== null
    || !obj(value.scope) || value.scope.project !== scope.project || value.scope.workspace !== scope.workspace
    || value.scope.nodeId !== scope.nodeId || !Array.isArray(value.cohorts) || value.cohorts.length > 100
    || !count(value.scannedReceipts, 100) || !count(value.invalidReceipts, value.scannedReceipts)
    || !count(value.conflictingInvocations, 32 * value.scannedReceipts) || typeof value.receiptWindowLimited !== 'boolean'
    || typeof value.cohortsLimited !== 'boolean' || typeof value.limited !== 'boolean'
    || value.limited !== (value.receiptWindowLimited || value.cohortsLimited)) throw new Error('Invalid native invocation report');
  const seen = new Set<string>(), cohorts = value.cohorts.map((row: unknown): InvocationCohort => {
    if (!obj(row) || !stableId(row.resource) || typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest)
      || row.adapter !== 'node-readonly/1' || typeof row.nodeVersion !== 'string' || row.nodeVersion.length > 64
      || !/^v\d+\.\d+\.\d+$/.test(row.nodeVersion) || !stableId(row.problem)
      || !count(row.invocations, 32 * value.scannedReceipts) || row.invocations < 1
      || !count(row.pass, row.invocations) || !count(row.fail, row.invocations) || row.pass + row.fail !== row.invocations
      || typeof row.meanDurationMs !== 'number' || !Number.isFinite(row.meanDurationMs) || row.meanDurationMs < 0 || row.meanDurationMs > 60000
      || !count(row.outputBytes, row.invocations * 1024 ** 3) || !count(row.executions, Math.min(row.invocations, value.scannedReceipts)) || row.executions < 1
      || !count(row.tasks, row.executions) || row.tasks < 1 || !printable(row.latestSourceReceipt, 128))
      throw new Error('Invalid native invocation cohort');
    const key = JSON.stringify([row.resource, row.digest, row.adapter, row.nodeVersion, row.problem]);
    if (seen.has(key)) throw new Error('Duplicate native invocation cohort'); seen.add(key);
    return { resource: row.resource, digest: row.digest, adapter: row.adapter, nodeVersion: row.nodeVersion,
      problem: row.problem, invocations: row.invocations, pass: row.pass, fail: row.fail,
      percent: 100 * row.pass / row.invocations, meanDurationMs: row.meanDurationMs, outputBytes: row.outputBytes,
      executions: row.executions, tasks: row.tasks, latestSourceReceipt: row.latestSourceReceipt };
  });
  return { status: 'available', scope: { ...scope }, authority: 'native-result-receipts', evidence: 'worker-reported',
    serverObserved: false, independentlyVerified: false, causalContribution: false, promotionAllowed: false,
    coverage: unavailableCoverage, scannedReceipts: value.scannedReceipts, limited: value.limited,
    receiptWindowLimited: value.receiptWindowLimited, cohortsLimited: value.cohortsLimited,
    invalidReceipts: value.invalidReceipts, conflictingInvocations: value.conflictingInvocations,
    tokens: null, cost: null, cohorts };
}

export async function nativeInvocations(base: string, scope: InvocationScope, resource?: string, read: typeof fetch = fetch): Promise<NativeInvocations> {
  try {
    if (!id(scope.project) || !id(scope.workspace) || !(scope.nodeId === null || id(scope.nodeId)) || (resource !== undefined && !id(resource))) return noInvocations('invalid-scope');
    const origin = new URL(base);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) return noInvocations('invalid-peer');
    const url = new URL('/api/oporahub/harness-invocations', origin);
    url.search = new URLSearchParams({ project: scope.project, workspace: scope.workspace, ...(scope.nodeId ? { nodeId: scope.nodeId } : {}), ...(resource ? { resource } : {}), limit: '100' }).toString();
    const response = await read(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json', 'cache-control': 'no-store', 'X-Opora-Actor': 'agent; name=office-harness' } });
    if (!response.ok || !response.body) { await response.body?.cancel(); return noInvocations('native-invocations-unavailable'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 256 * 1024) throw new Error('too-large'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const parsed = parseNativeInvocations(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), scope);
    if (resource && parsed.cohorts.some(row => row.resource !== resource)) throw new Error('resource-filter');
    return parsed;
  } catch { return noInvocations('native-invocations-invalid-or-unreachable'); }
}

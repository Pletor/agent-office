/** Native peer metadata is advisory evidence, never independent output verification or promotion. */
export interface PairedEvidence {
  executionId: string; evaluationId: string; sourceReceipt: string; problem: string;
  baseline: { id: string; digest: string }; candidate: { id: string; digest: string };
  plan: { id: string; digest: string }; improvements: number; regressions: number; unknownPairs: number;
  status: 'complete' | 'incomplete';
}
export interface PairedHistory {
  status: 'available' | 'unavailable'; limited: boolean; invalidReceipts: number | null;
  conflictingEvaluations: number | null; evaluations: PairedEvidence[]; reason?: string;
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}(?![\s\S])/.test(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(v);
const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/.test(v);
const count = (v: unknown, max = 100): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const fail = (): never => { throw new Error('Invalid native paired evidence'); };
const resource = (v: unknown) => { if (!object(v) || !id(v.id) || !hex(v.digest)) return fail(); return { id: v.id, digest: v.digest }; };
export const noPairedHistory = (reason: string): PairedHistory => ({ status: 'unavailable', limited: false,
  invalidReceipts: null, conflictingEvaluations: null, evaluations: [], reason });

function evidence(item: unknown, project: string, workspace: string): PairedEvidence {
  if (!object(item) || typeof item.sourceReceipt !== 'string' || !item.sourceReceipt || item.sourceReceipt.length > 128
    || /[\x00-\x1f]/.test(item.sourceReceipt) || !object(item.report)) return fail();
  const r = item.report, e = r.execution;
  if (r.schema !== 'harness.paired-result/1' || !uuid(r.evaluationId) || !id(r.problem)
    || r.nativeProblem !== 'evaluation:paired-node' || r.evidence !== 'worker-observed'
    || r.independentlyVerified !== false || r.causalContribution !== false || r.promotionAllowed !== false
    || r.cost !== null || r.tokens !== null || !object(e) || e.project !== project || e.workspace !== workspace
    || !id(e.executionId) || !id(e.nodeId) || !count(e.epoch, Number.MAX_SAFE_INTEGER) || e.epoch < 1
    || typeof e.acceptedRevision !== 'string' || !/^[a-f0-9]{40}(?![\s\S])/.test(e.acceptedRevision) || !hex(e.assignmentDigest)
    || typeof r.authorityCurrentAtCompletion !== 'boolean' || !['complete', 'incomplete'].includes(r.status)
    || !Array.isArray(r.trials) || r.trials.length < 2 || r.trials.length > 16 || r.trials.length % 2) return fail();
  const baseline = resource(r.baseline), candidate = resource(r.candidate), plan = resource(r.plan);
  if (new Set([baseline.id, candidate.id, plan.id]).size !== 3) return fail();
  const counts = { baseline: { pass: 0, fail: 0, unknown: 0 }, candidate: { pass: 0, fail: 0, unknown: 0 } };
  const cases = new Set<string>(), invocations = new Set<string>();
  let improvements = 0, regressions = 0, unknownPairs = 0, observed = 0, stopped = false;
  for (let i = 0; i < r.trials.length; i += 2) {
    const pair = r.trials.slice(i, i + 2), firstSide = i % 4 === 0 ? 'baseline' : 'candidate';
    if (!object(pair[0]) || !id(pair[0].case) || cases.has(pair[0].case)) return fail();
    cases.add(pair[0].case);
    const outcomes: Record<string, string> = {};
    for (const [j, t] of pair.entries()) {
      const side = j === 0 ? firstSide : firstSide === 'baseline' ? 'candidate' : 'baseline';
      if (!object(t) || t.case !== pair[0].case || t.side !== side || t.order !== i + j + 1
        || !['pass', 'fail', 'unknown'].includes(t.outcome)) return fail();
      if ((t.outcome === 'pass' && t.reason !== 'expected-output')
        || (t.outcome === 'fail' && !['output-mismatch', 'completed', 'nonzero-exit', 'timeout', 'output-limit',
          'spawn-failed', 'authority-not-current', 'cleanup-incomplete'].includes(t.reason))
        || (t.outcome === 'unknown' && !['launch-budget-exhausted', 'adapter-error-or-authority-unavailable',
          'authority-not-current', 'cleanup-incomplete'].includes(t.reason))) return fail();
      if (t.outcome === 'unknown') { if (t.invocationId !== null) return fail(); stopped = true; }
      else {
        if (stopped || !uuid(t.invocationId) || invocations.has(t.invocationId)) return fail();
        invocations.add(t.invocationId); observed++;
        if (t.reason === 'authority-not-current' || t.reason === 'cleanup-incomplete') stopped = true;
      }
      counts[side][t.outcome as 'pass' | 'fail' | 'unknown']++;
      outcomes[side] = t.outcome;
    }
    if (Object.values(outcomes).includes('unknown')) unknownPairs++;
    else if (outcomes.baseline === 'fail' && outcomes.candidate === 'pass') improvements++;
    else if (outcomes.baseline === 'pass' && outcomes.candidate === 'fail') regressions++;
  }
  for (const side of ['baseline', 'candidate'] as const) {
    if (r[side].planned !== cases.size || !count(r[side].planned, 8)) return fail();
    for (const outcome of ['pass', 'fail', 'unknown'] as const) if (!count(r[side][outcome], 8) || r[side][outcome] !== counts[side][outcome]) return fail();
  }
  const complete = !unknownPairs && r.authorityCurrentAtCompletion && !stopped;
  const conclusion = !complete ? 'incomplete' : regressions ? 'regression-on-fixtures' : improvements ? 'candidate-better-on-fixtures' : 'no-improvement-on-fixtures';
  if (!object(r.comparison) || r.comparison.improvements !== improvements || r.comparison.regressions !== regressions
    || r.comparison.incomparable !== unknownPairs || r.comparison.passDifference !== counts.candidate.pass - counts.baseline.pass
    || r.comparison.conclusion !== conclusion || r.plannedInvocations !== r.trials.length || r.observedInvocations !== observed
    || r.status !== (complete ? 'complete' : 'incomplete')) return fail();
  return { executionId: e.executionId, evaluationId: r.evaluationId, sourceReceipt: item.sourceReceipt,
    problem: r.problem, baseline, candidate, plan, improvements, regressions, unknownPairs, status: r.status };
}

export function parsePairedHistory(value: unknown, project: string, workspace: string): PairedHistory {
  if (!object(value) || value.schema !== 'harness.paired-evaluations/1' || value.authority !== 'native-result-receipts'
    || value.evidence !== 'worker-reported' || value.serverObserved !== false || value.independentlyVerified !== false
    || value.causalContribution !== false || value.promotionAllowed !== false || value.tokens !== null || value.cost !== null
    || !object(value.scope) || value.scope.project !== project || value.scope.workspace !== workspace || value.scope.nodeId !== null
    || typeof value.receiptWindowLimited !== 'boolean' || !count(value.scannedReceipts) || !count(value.invalidReceipts)
    || !count(value.conflictingEvaluations) || !Array.isArray(value.evaluations) || value.evaluations.length > value.scannedReceipts
    || value.invalidReceipts > value.scannedReceipts || value.conflictingEvaluations > value.scannedReceipts) return fail();
  const evaluations = value.evaluations.map((item: unknown) => evidence(item, project, workspace));
  const identities = evaluations.map((e: PairedEvidence) => JSON.stringify([e.executionId, e.evaluationId]));
  if (new Set(identities).size !== identities.length) return fail();
  return { status: 'available', limited: value.receiptWindowLimited, invalidReceipts: value.invalidReceipts,
    conflictingEvaluations: value.conflictingEvaluations, evaluations };
}

export async function nativePairedHistory(base: string, project: string, workspace: string, read: typeof fetch = fetch): Promise<PairedHistory> {
  try {
    const origin = new URL(base);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) return noPairedHistory('invalid-configured-peer');
    const url = new URL('/api/oporahub/harness-paired-evaluations', origin);
    url.search = new URLSearchParams({ project, workspace, limit: '100' }).toString();
    const response = await read(url, { redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json', 'cache-control': 'no-store', 'X-Opora-Actor': 'agent; name=office-harness' } });
    if (!response.ok || !response.body) { await response.body?.cancel(); return noPairedHistory('native-paired-unavailable'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
      if (size > 1024 * 1024) throw new Error('Paired history too large'); chunks.push(next.value); } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return parsePairedHistory(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), project, workspace);
  } catch { return noPairedHistory('native-paired-invalid-or-unreachable'); }
}

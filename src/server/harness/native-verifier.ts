/** Independently observed fixture outputs; never production/task-success rates. */
export interface FixtureEvidence {
  verificationId: string; executionId: string; problem: string;
  candidate: { id: string; digest: string }; baseline: { id: string; digest: string }; plan: { id: string; digest: string };
  improvements: number; regressions: number; cases: number;
}
export interface FixtureHistory {
  status: 'available' | 'unavailable'; limited: boolean; unknown: number; evaluations: FixtureEvidence[]; reason?: string;
}
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}(?![\s\S])/.test(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(v);
const fail = (): never => { throw new Error('Invalid native fixture verification'); };
const ref = (v: unknown) => { if (!obj(v) || !id(v.id) || !hex(v.digest)) return fail(); return { id: v.id, digest: v.digest }; };
export const noFixtureHistory = (reason: string): FixtureHistory => ({ status: 'unavailable', limited: false, unknown: 0, evaluations: [], reason });

export function parseFixtureHistory(value: unknown, project: string, workspace: string): FixtureHistory {
  if (!obj(value) || !Array.isArray(value.requests) || value.requests.length > 100) return fail();
  const evaluations: FixtureEvidence[] = [], seen = new Set<string>(); let unknown = 0;
  for (const q of value.requests) {
    if (!obj(q) || q.domain !== 'harness-fixtures' || q.project !== project || q.workspace !== workspace
      || !id(q.id) || seen.has(q.id) || !id(q.executionId) || !id(q.nodeId) || !hex(q.assignmentDigest)
      || typeof q.acceptedRevision !== 'string' || !/^[a-f0-9]{40}(?![\s\S])/.test(q.acceptedRevision)
      || !Number.isSafeInteger(q.epoch) || q.epoch < 1 || q.trust !== 'server-pending'
      || q.currentEligibility !== false || q.independentlyVerified !== false || q.sourceBinding !== 'canvas-verified'
      || !obj(q.origin) || q.origin.kind !== 'harness-server-verifier' || q.origin.protocol !== 'harness.server-fixtures/1'
      || !obj(q.origin.execution)) return fail();
    seen.add(q.id);
    for (const key of ['project', 'workspace', 'executionId', 'nodeId', 'epoch', 'acceptedRevision', 'assignmentDigest'])
      if (q.origin.execution[key] !== q[key]) return fail();
    const origin = q.origin, candidate = ref(origin.candidate), baseline = ref(origin.baseline), plan = ref(origin.plan);
    if (new Set([candidate.id, baseline.id, plan.id]).size !== 3 || typeof origin.image !== 'string'
      || !/^node@sha256:[a-f0-9]{64}(?![\s\S])/.test(origin.image)) return fail();
    if (origin.problem !== undefined && !id(origin.problem)) return fail();
    if (q.report === null) { unknown++; continue; }
    const r = q.report;
    if (!obj(r) || r.trust !== 'server-observed' || r.sourceBinding !== 'canvas-verified'
      || r.currentEligibility !== false || r.promotionAllowed !== false || !hex(r.reportDigest)
      || !obj(r.paired) || typeof r.independentlyVerified !== 'boolean'
      || typeof r.authorityCurrentAtCompletion !== 'boolean') return fail();
    const paired = r.paired;
    if (paired.complete !== true || paired.cleanupComplete !== true || r.authorityCurrentAtCompletion !== true) {
      if (r.independentlyVerified !== false || r.outcome !== 'inconclusive') return fail();
      unknown++; continue;
    }
    if (r.independentlyVerified !== true || !Array.isArray(paired.trials) || paired.trials.length < 2
      || paired.trials.length > 16 || paired.trials.length % 2 || paired.plannedTrials !== paired.trials.length
      || q.plannedTrials !== paired.plannedTrials || paired.observedTrials !== paired.plannedTrials || paired.unknownPairs !== 0) return fail();
    const cases = new Set<string>(); let improvements = 0, regressions = 0, candidateFailed = false;
    for (let i = 0; i < paired.trials.length; i += 2) {
      const pair = paired.trials.slice(i, i + 2), first = i % 4 === 0 ? 'baseline' : 'candidate';
      if (!obj(pair[0]) || !id(pair[0].case) || cases.has(pair[0].case)) return fail();
      cases.add(pair[0].case);
      for (const [j, t] of pair.entries()) {
        if (!obj(t) || t.case !== pair[0].case || t.order !== i + j + 1
          || t.side !== (j === 0 ? first : first === 'baseline' ? 'candidate' : 'baseline')
          || !['pass', 'fail'].includes(t.outcome) || !Number.isInteger(t.exitCode) || t.exitCode < 0 || t.exitCode > 255
          || [125, 126, 127].includes(t.exitCode) || !hex(t.outputDigest)
          || (t.reason === 'nonzero-exit' && t.exitCode === 0) || (t.reason === 'output-mismatch' && t.exitCode !== 0)
          || (t.outcome === 'pass' && (t.exitCode !== 0 || t.reason !== 'expected-output'))
          || (t.outcome === 'fail' && !['output-mismatch', 'nonzero-exit'].includes(t.reason))) return fail();
      }
      const b = pair.find((t: any) => t.side === 'baseline')!, c = pair.find((t: any) => t.side === 'candidate')!;
      if (c.outcome === 'fail') candidateFailed = true;
      if (b.outcome === 'pass' && c.outcome === 'fail') regressions++;
      if (b.outcome === 'fail' && c.outcome === 'pass') improvements++;
    }
    if (paired.improvements !== improvements || paired.regressions !== regressions
      || r.outcome !== (candidateFailed ? 'failed' : 'passed')) return fail();
    if (origin.problem === undefined) { unknown++; continue; }
    evaluations.push({ verificationId: q.id, executionId: q.executionId, problem: origin.problem,
      candidate, baseline, plan, improvements, regressions, cases: cases.size });
  }
  return { status: 'available', limited: value.requests.length === 100, unknown, evaluations };
}

export async function nativeFixtureHistory(base: string, project: string, workspace: string, read: typeof fetch = fetch): Promise<FixtureHistory> {
  try {
    const origin = new URL(base);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) return noFixtureHistory('invalid-configured-peer');
    const url = new URL('/api/oporahub/harness-verifier/requests', origin);
    url.search = new URLSearchParams({ project, workspace }).toString();
    const response = await read(url, { redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json', 'cache-control': 'no-store', 'X-Opora-Actor': 'agent; name=office-harness' } });
    if (!response.ok || !response.body) { await response.body?.cancel(); return noFixtureHistory('native-fixture-unavailable'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
      if (size > 1024 * 1024) throw new Error('Fixture history too large'); chunks.push(next.value); } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return parseFixtureHistory(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), project, workspace);
  } catch { return noFixtureHistory('native-fixture-invalid-or-unreachable'); }
}

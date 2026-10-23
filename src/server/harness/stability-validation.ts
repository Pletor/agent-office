import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export interface StabilityScope { peer: string; project: string; workspace: string; problem: string }
export interface StabilityEvidence {
  scope: StabilityScope; version: { id: string; digest: string; category: 'scripts'; requires: string[] };
  baseline: { id: string; digest: string }; eligible: boolean; evidenceDigest: string; policyDigest: string;
}
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}(?![\s\S])/.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
function fail(): never { throw new Error('Invalid native stability assessment.'); }
const digest = (v: Record<string, unknown>) => createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))).digest('hex');

/** The accepted kit has already passed validateAcceptedKit. No live catalog substitution. */
export function stabilityPlan(kit: Record<string, any>, name: string) {
  if (!id(name)) fail();
  const resources = kit.resources as Record<string, any>[];
  const resource = resources.find(r => r.resource === name);
  if (!resource || resource.category !== 'testing' || !isDeepStrictEqual(resource.requires, [])) fail();
  const plan = JSON.parse(resource.content);
  if (!obj(plan) || plan.schema !== 'harness.paired-node/1' || !id(plan.problem)
    || !id(plan.candidate) || !id(plan.baseline) || new Set([name, plan.candidate, plan.baseline]).size !== 3) fail();
  const script = (name: string) => {
    const r = resources.find(r => r.resource === name);
    if (!r || r.category !== 'scripts' || !isDeepStrictEqual(r.requires, ['command:node'])) return fail();
    return { id: r.resource as string, digest: r.digest as string, category: 'scripts' as const, requires: ['command:node'] };
  };
  return { reference: { id: name, digest: resource.digest as string }, problem: plan.problem,
    candidate: script(plan.candidate), baseline: script(plan.baseline) };
}

/** Trusted native response must still match this exact lease, accepted plan and fixed policy. */
export function validateStability(value: unknown, current: Record<string, any>, peer: string, pinned: ReturnType<typeof stabilityPlan>): StabilityEvidence {
  if (!obj(value) || value.schema !== 'harness.stability-eligibility/1' || value.authority !== 'native-policy-assessment'
    || !obj(value.scope) || value.scope.project !== current.project || value.scope.workspace !== current.workspace
    || value.scope.problem !== pinned.problem || !obj(value.execution)
    || !['executionId', 'nodeId', 'epoch', 'acceptedRevision', 'assignmentDigest'].every(k => value.execution[k] === current[k])
    || value.promotionAllowed !== false || value.reservation !== false || typeof value.eligible !== 'boolean'
    || !hex(value.evidenceDigest) || !hex(value.policyDigest) || !Array.isArray(value.reasons)
    || value.reasons.length > 16 || !value.reasons.every(id) || value.eligible !== (value.reasons.length === 0)
    || !isDeepStrictEqual(value.plan, pinned.reference)
    || !isDeepStrictEqual(value.candidate, { id: pinned.candidate.id, digest: pinned.candidate.digest })
    || !isDeepStrictEqual(value.baseline, { id: pinned.baseline.id, digest: pinned.baseline.digest })
    || !isDeepStrictEqual(value.evidenceBasis, { taskOutcomes: 'selected-kit-association', taskInvocationVerified: false,
      causalBenefitEstablished: false, directObservation: 'approved-fixture-cases-only' })) fail();
  const policy = value.policy;
  if (!obj(policy) || policy.project !== current.project || policy.workspace !== current.workspace
    || policy.minimumVerifiedOutcomes !== 20 || policy.minimumVerifiedCards !== 5 || policy.minimumCoveragePercent !== 95
    || !Array.isArray(policy.approvedPlanDigests) || policy.approvedPlanDigests.length < 1 || policy.approvedPlanDigests.length > 32
    || !policy.approvedPlanDigests.every(hex) || new Set(policy.approvedPlanDigests).size !== policy.approvedPlanDigests.length
    || digest(policy) !== value.policyDigest) fail();
  if (value.eligible) {
    const cohort = value.cohort, comparison = value.comparison, guardrails = value.guardrails;
    const version = digest({ resource: pinned.candidate.id, category: 'scripts', digest: pinned.candidate.digest, requires: ['command:node'] });
    if (!policy.approvedPlanDigests.includes(pinned.reference.digest) || !obj(cohort)
      || !['executions', 'verifiedPasses', 'unknown', 'verifiedCards'].every(k => count(cohort[k]))
      || cohort.verifiedPasses < 20 || cohort.verifiedCards < 5 || cohort.verifiedCards > cohort.verifiedPasses
      || cohort.executions !== cohort.verifiedPasses + cohort.unknown || cohort.verifiedPasses * 100 < cohort.executions * 95
      || cohort.coverage !== cohort.verifiedPasses / cohort.executions || cohort.versionDigest !== version || !hex(cohort.sourceDigest)
      || !obj(guardrails) || guardrails.affectedExecutions !== 0 || !obj(comparison) || comparison.complete !== true
      || comparison.reason !== null || !Array.isArray(comparison.reports) || !comparison.reports.length || comparison.reports.length > 1000
      || !comparison.reports.every((r: unknown) => obj(r) && id(r.verificationId) && hex(r.reportDigest))
      || new Set(comparison.reports.map((r: any) => r.verificationId)).size !== comparison.reports.length) fail();
  }
  return { scope: { peer, project: current.project, workspace: current.workspace, problem: pinned.problem },
    version: pinned.candidate, baseline: { id: pinned.baseline.id, digest: pinned.baseline.digest },
    eligible: value.eligible, evidenceDigest: value.evidenceDigest, policyDigest: value.policyDigest };
}

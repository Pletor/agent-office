import path from 'node:path';
import type http from 'node:http';
import type { Ctx } from '../office/context.js';
import type { Floor } from '../floor.js';
import { readBody, send } from '../http/util.js';
import { nativeHarnessGrant } from './native-grant.js';
import { stabilityPlan } from './stability-validation.js';

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,199}(?![\s\S])/.test(v);
const hex = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(v);
const fail = (): never => { throw new Error('Invalid shared lesson evidence.'); };

/** Minimize public native proof; it remains separate from local task outcomes. */
export function sharedProof(value: unknown, publication: string, resource: Record<string, any>, problems: string[]) {
  if (!object(value) || value.publication !== publication || !object(value.candidate)
    || value.candidate.id !== resource.resource || value.candidate.digest !== resource.digest
    || !id(value.problem) || !problems.includes(value.problem) || !hex(value.policyDigest) || !hex(value.evidenceDigest)
    || value.environmentBasis !== 'pinned-node-image-content' || !object(value.evidenceBasis)
    || value.evidenceBasis.taskOutcomes !== 'selected-kit-association' || value.evidenceBasis.causalBenefitEstablished !== false
    || value.evidenceBasis.directObservation !== 'approved-fixture-cases-only'
    || !Array.isArray(value.sources) || value.sources.length < 3 || value.sources.length > 8) return fail();
  const sources = value.sources.map((s: unknown) => {
    if (!object(s) || !id(s.project) || !id(s.workspace) || !id(s.verificationId) || !hex(s.reportDigest) || !hex(s.evidenceDigest)
      || typeof s.image !== 'string' || !/^node@sha256:[a-f0-9]{64}(?![\s\S])/.test(s.image)) return fail();
    return { project: s.project, workspace: s.workspace, verificationId: s.verificationId,
      reportDigest: s.reportDigest, evidenceDigest: s.evidenceDigest, image: s.image };
  });
  const projects = new Set(sources.map(s => s.project)).size, images = new Set(sources.map(s => s.image)).size;
  if (new Set(sources.map(s => JSON.stringify([s.project, s.workspace, s.verificationId]))).size !== sources.length
    || projects < 3 || images < 2 || value.verifiedProjects !== projects || value.verifiedImages !== images) return fail();
  return { publication, candidate: { id: resource.resource, digest: resource.digest }, problem: value.problem,
    policyDigest: value.policyDigest, evidenceDigest: value.evidenceDigest, sources, verifiedProjects: projects, verifiedImages: images };
}

/** Hook auth plus exact accepted resource/current execution binding; no execution token goes to public endpoints. */
export async function sharedMemoryRequest(ctx: Ctx, floor: Floor, worker: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const headers = { 'cache-control': 'no-store' };
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' }, headers);
  if ([...url.searchParams.keys()].some(k => !['worker', 'shared-memory', 'resource'].includes(k)))
    return send(res, 400, { error: 'Shared lessons belong to an accepted resource; omit task and other options.' }, headers);
  try {
    const publication = url.searchParams.get('shared-memory'), resourceId = url.searchParams.get('resource');
    if (!id(publication) || !id(resourceId)) return fail();
    const body = JSON.parse(await readBody(req, 4096));
    if (!object(body) || Object.keys(body).join(',') !== 'operation' || !['publish', 'recall'].includes(body.operation)) return fail();
    const grant = nativeHarnessGrant(floor.opora.executions.controller, path.join(floor.dir, '.agent-office'), worker);
    const resources = grant.kit.resources as Record<string, any>[];
    const resource = resources.find(r => r.resource === resourceId);
    if (!resource || resource.category !== 'scripts' || resource.requires.length !== 1 || resource.requires[0] !== 'command:node') return fail();
    const problems = [...grant.kit.problems as string[]];
    for (const entry of resources.filter(r => r.category === 'testing')) {
      try { const plan = stabilityPlan(grant.kit, entry.resource);
        if (plan.candidate.id === resourceId && plan.candidate.digest === resource.digest) problems.push(plan.problem);
      } catch { /* Other accepted testing resources are not paired Node plans. */ }
    }
    const assertCurrent = () => {
      grant.assertCurrent();
      if (ctx.workerFloor(worker) !== floor || !floor.workers.authenticate(worker, (req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))) return fail();
    };
    const assess = async () => {
      const raw = await grant.publicationRequest('/api/oporahub/harness-verifier/eligibility/shared', publication);
      if (!object(raw) || raw.schema !== 'harness.shared-eligibility/1' || raw.authority !== 'native-policy-assessment'
        || raw.eligible !== true || raw.minimumProjects !== 3 || raw.minimumImages !== 2 || !Array.isArray(raw.reasons) || raw.reasons.length
        || raw.executionAuthority !== false || raw.promotionAllowed !== false || raw.reservation !== false) return fail();
      assertCurrent(); return sharedProof(raw, publication, resource, problems);
    };
    const before = await assess(); assertCurrent();
    const value = await grant.publicationRequest(body.operation === 'publish' ? '/api/oporahub/harness-shared-memory/publish' : '/api/oporahub/harness-shared-memory/recall', publication);
    assertCurrent();
    if (!object(value) || value.schema !== 'harness.shared-memory/1' || value.publication !== publication) return fail();
    let result: Record<string, unknown>;
    if (body.operation === 'publish') {
      if (!hex(value.lessonDigest) || !['pending', 'retry', 'waiting-role', 'working', 'submitted'].includes(value.state) || value.promotionAllowed !== false) return fail();
      result = { state: value.state, lessonDigest: value.lessonDigest, meaning: 'Write acknowledgment is not verified memory readback.' };
    } else if (value.status === 'unavailable' && value.lesson === null) result = { status: 'unavailable', lesson: null };
    else {
      const lesson = value.lesson;
      if (value.status !== 'verified-readback' || value.executionAuthority !== false || value.promotionAllowed !== false
        || !object(lesson) || lesson.schema !== 'harness.shared-memory/1' || !hex(lesson.lessonDigest)
        || lesson.productionOutcome !== 'unknown' || lesson.promotionAllowed !== false || lesson.executionAuthority !== false) return fail();
      const proof = sharedProof(lesson, publication, resource, problems);
      if (JSON.stringify(proof) !== JSON.stringify(before)) return fail();
      result = { status: 'verified-readback', lesson: { ...proof, lessonDigest: lesson.lessonDigest,
        meaning: 'Public fixture evidence for local verification; not production success or permission.' } };
    }
    if (JSON.stringify(await assess()) !== JSON.stringify(before)) return fail();
    assertCurrent();
    return send(res, 200, { schema: 'harness.shared-memory/1', publication, resource: resourceId, ...result,
      acceptedAssignmentUnchanged: true, executionAuthority: false, promotionAllowed: false }, headers);
  } catch {
    return send(res, 409, { error: 'Shared lesson is unavailable, changed or incompatible with the current accepted resource.' }, headers);
  }
}

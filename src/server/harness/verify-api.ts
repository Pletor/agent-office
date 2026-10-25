import path from 'node:path';
import type http from 'node:http';
import type { Ctx } from '../office/context.js';
import type { Floor } from '../floor.js';
import { send } from '../http/util.js';
import { nativeHarnessGrant } from './native-grant.js';
import { stabilityPlan } from './stability-validation.js';

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const hex = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(v);
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const fail = (): never => { throw new Error('Invalid native verification.'); };

/** The parts of a Canvas verifier record a worker may see: outcome and counts, never the execution binding. */
export function verificationView(value: unknown, plan: { id: string; digest: string }) {
  if (!object(value) || typeof value.id !== 'string' || !/^[a-f0-9]{32}(?![\s\S])/.test(value.id)
    || !object(value.origin) || value.origin.kind !== 'harness-server-verifier'
    || !object(value.origin.plan) || value.origin.plan.id !== plan.id || value.origin.plan.digest !== plan.digest
    || !count(value.plannedTrials)) return fail();
  const base = { schema: 'harness.verification/1', verificationId: value.id, plan, plannedTrials: value.plannedTrials,
    promotionAllowed: false, acceptedAssignmentUnchanged: true };
  if (value.report === null || value.report === undefined)
    return { ...base, status: value.recoveryRequired === true ? 'recovery-required' : 'pending', independentlyVerified: false };
  const r = value.report;
  if (!object(r) || !['passed', 'failed', 'inconclusive'].includes(r.outcome) || !hex(r.reportDigest)
    || typeof r.independentlyVerified !== 'boolean' || r.promotionAllowed !== false || !object(r.paired)
    || !count(r.paired.observedTrials) || !count(r.paired.improvements) || !count(r.paired.regressions)) return fail();
  return { ...base, status: 'reported', outcome: r.outcome, reportDigest: r.reportDigest,
    independentlyVerified: r.independentlyVerified && r.outcome !== 'inconclusive',
    paired: { observedTrials: r.paired.observedTrials, improvements: r.paired.improvements, regressions: r.paired.regressions },
    meaning: 'Canvas reran the accepted paired fixture in its own container; fixture evidence, not production success or permission.' };
}

/** Hook auth is established by officeHarness; Canvas runs the accepted plan under the current execution. */
export async function verificationRequest(ctx: Ctx, floor: Floor, worker: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const headers = { 'cache-control': 'no-store' };
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' }, headers);
  if ([...url.searchParams.keys()].some(k => !['worker', 'verify'].includes(k)))
    return send(res, 400, { error: 'Verification belongs to the current execution; omit task and other options.' }, headers);
  try {
    const grant = nativeHarnessGrant(floor.opora.executions.controller, path.join(floor.dir, '.agent-office'), worker);
    const plan = stabilityPlan(grant.kit, url.searchParams.get('verify') ?? '');
    const value = await grant.request('/api/oporahub/harness-verifier/requests', { plan: plan.reference });
    grant.assertCurrent();
    if (ctx.workerFloor(worker) !== floor || !floor.workers.authenticate(worker, (req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))) return fail();
    return send(res, 200, verificationView(value, plan.reference), headers);
  } catch {
    return send(res, 409, { error: 'Native verification is unavailable, not configured for this project, busy or unauthorized for this execution.' }, headers);
  }
}

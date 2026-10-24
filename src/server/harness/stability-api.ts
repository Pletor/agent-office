import path from 'node:path';
import type http from 'node:http';
import type { Ctx } from '../office/context.js';
import type { Floor } from '../floor.js';
import { readBody, send } from '../http/util.js';
import { HarnessProfiles } from './profiles.js';
import { nativeHarnessGrant } from './native-grant.js';
import { stabilityPlan, validateStability, type StabilityEvidence, type StabilityScope } from './stability-validation.js';

interface LifecycleStore {
  toolLifecycleProtocol: 1;
  lifecycle(repo: string, scope: StabilityScope): { revision: number; state?: unknown };
  advanceTool(repo: string, scope: StabilityScope, revision: number, operation: 'promote' | 'reconcile',
    read: () => Promise<{ current: StabilityEvidence; fallback?: StabilityEvidence; assertCurrent: () => void }>): Promise<{ revision: number; state: unknown }>;
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Hook auth is established by officeHarness. Store capability is optional across independent PRs. */
export async function stabilityRequest(ctx: Ctx, floor: Floor, worker: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const headers = { 'cache-control': 'no-store' };
  if (!['GET', 'POST'].includes(req.method ?? '')) return send(res, 405, { error: 'Use GET or POST' }, headers);
  if ([...url.searchParams.keys()].some(k => !['worker', 'stability'].includes(k)))
    return send(res, 400, { error: 'Tool lifecycle belongs to the current execution; omit task and other options.' }, headers);
  try {
    const store = new HarnessProfiles(ctx.cfg.dataDir) as unknown as Partial<LifecycleStore>;
    if (store.toolLifecycleProtocol !== 1 || typeof store.lifecycle !== 'function' || typeof store.advanceTool !== 'function')
      return send(res, 409, { error: 'Harness lifecycle storage is not installed.' }, headers);
    const grant = nativeHarnessGrant(floor.opora.executions.controller, path.join(floor.dir, '.agent-office'), worker);
    const plan = stabilityPlan(grant.kit, url.searchParams.get('stability') ?? '');
    const scope = { peer: grant.peer, project: grant.current.project, workspace: grant.current.workspace, problem: plan.problem };
    const assertCurrent = () => {
      grant.assertCurrent();
      if (ctx.workerFloor(worker) !== floor || !floor.workers.authenticate(worker, (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')))
        throw new Error('Worker authority changed.');
    };
    const assess = async (pinned: typeof plan) => validateStability(
      await grant.request('/api/oporahub/harness-verifier/eligibility', { plan: pinned.reference }), grant.current, grant.peer, pinned);
    if (req.method === 'GET') {
      const current = await assess(plan); assertCurrent();
      return send(res, 200, { schema: 'harness.lifecycle/1', ...store.lifecycle(floor.dir, scope), assessment: current,
        acceptedAssignmentUnchanged: true, productionPermission: false }, headers);
    }
    const body: unknown = JSON.parse(await readBody(req, 4096));
    if (!object(body) || Object.keys(body).some(k => !['revision', 'operation', 'fallbackPlan'].includes(k))
      || !Number.isSafeInteger(body.revision) || body.revision < 0 || !['promote', 'reconcile'].includes(body.operation)
      || (body.fallbackPlan !== undefined && (body.operation !== 'reconcile' || typeof body.fallbackPlan !== 'string')))
      return send(res, 400, { error: 'Use a revision, promote/reconcile operation and optional reconcile fallbackPlan.' }, headers);
    const fallback = body.fallbackPlan === undefined ? undefined : stabilityPlan(grant.kit, body.fallbackPlan);
    if (fallback && fallback.problem !== plan.problem) throw new Error('Foreign fallback problem.');
    const result = await store.advanceTool(floor.dir, scope, body.revision, body.operation, async () => {
      assertCurrent();
      const current = await assess(plan);
      const restored = !current.eligible && fallback ? await assess(fallback) : undefined;
      assertCurrent();
      return { current, ...(restored ? { fallback: restored } : {}), assertCurrent };
    });
    assertCurrent();
    return send(res, 200, { schema: 'harness.lifecycle/1', ...result, acceptedAssignmentUnchanged: true, productionPermission: false }, headers);
  } catch {
    return send(res, 409, { error: 'Tool lifecycle is unavailable, conflicting or unauthorized; reload status before retrying.' }, headers);
  }
}

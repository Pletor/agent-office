import type http from 'node:http';
import type { Ctx } from '../office/context.js';
import type { Floor } from '../floor.js';
import { readBody, send } from '../http/util.js';
import { HarnessProfiles, HarnessError, parseHarnessLayer } from './profiles.js';
import { harnessHandoff, assertBindable } from './handoff.js';
import { HarnessRegistry } from './registry.js';
import { HarnessLibrary, harnessSources } from './catalog.js';
import { oporaHarnessTask } from '../../shared/harness-cascade.js';
import { buildHarnessKit } from './kit.js';
import { recommendationRequest } from './recommendation-api.js';
import { harnessHierarchyRequest } from './hierarchy-api.js';
import { HarnessBindings } from './bindings.js';
import { parseOporaKey } from '../../shared/opora-identity.js';
import { boundHarnessProfile } from './bound-profile.js';

import { documentationRequest } from './documentation-api.js';

import { runnerProbeRequest } from './runner-probe-api.js';

export async function harnessProfileRequest(ctx: Ctx, floor: Floor, req: http.IncomingMessage, res: http.ServerResponse, url: URL, local: boolean, writable: boolean, globalWrite: boolean) {
  try {
    const store = new HarnessProfiles(ctx.cfg.dataDir);
    const task = url.searchParams.get('task') ?? '';
    const bound = !!parseOporaKey(task) && !!new HarnessBindings(ctx.cfg.dataDir).forRepo(floor.dir);
    if (req.method === 'POST') {
      if (!writable) return send(res, 403, { error: 'Only administrators and their active orchestrator can assign harness profiles.' });
      if (bound) throw new HarnessError('This task uses the seven-level hierarchy. Read --hierarchy --task KEY, then --configure LEVEL with its pathDigest.', 409);
      const body = JSON.parse(await readBody(req, 300_000));
      if (!body || typeof body !== 'object') throw new HarnessError('Expected a JSON object');
      if (body.scope === 'global' && !globalWrite) return send(res, 403, { error: 'Global settings require the administrator UI.' });
      const layer = parseHarnessLayer(body.layer);
      const ids = Object.values(layer).flatMap((b) => b && 'resource' in b ? [b.resource] : []);
      if (ids.length) {
        const lib = new HarnessLibrary(harnessSources(floor.dir, local), new HarnessRegistry(ctx.cfg.dataDir));
        await lib.list();
        for (const id of ids) assertBindable(lib, body.scope, id);
      }
      await store.save(floor.dir, task, body.scope, layer, body.revision);
    } else if (req.method !== 'GET') return send(res, 405, { error: 'Use GET or POST' });
    const view = bound ? await boundHarnessProfile(ctx.cfg.dataDir, floor.dir, task) : store.view(floor.dir, task);
    const opora = floor.opora.view();
    const tasks = opora.project && opora.workspace ? opora.cards.map((card) => ({ id: oporaHarnessTask(opora.project!.id, opora.workspace!, card.id), title: card.name })) : [];
    let preview = '', warning = '';
    try { preview = await harnessHandoff(ctx.cfg.dataDir, floor.dir, task, local, view); }
    catch (err) { warning = (err as Error).message; }
    send(res, 200, { ...view, tasks, writable, globalWrite, preview, warning });
  } catch (err) {
    send(res, err instanceof HarnessError ? err.status : 400, { error: (err as Error).message });
  }
}

/** Worker credentials are floor-scoped. Only the live admin-owned planner may mutate repository/task layers. */
export async function officeHarness(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const id = url.searchParams.get('worker') ?? '';
  const floor = ctx.workerFloor(id);
  const me = floor?.workers.authenticate(id, (req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  if (!floor || !me) return send(res, 401, { error: 'Use your worker ID and hook bearer token.' });
  if (url.searchParams.has('docs')) return documentationRequest(req, res, JSON.stringify([floor.id, id]));

  if (url.searchParams.has('capabilities')) return runnerProbeRequest(req, res, url, me.provider ?? floor.workers.defaultProvider, floor.id + ':' + me.id);
  const plan = floor.planning.state().current;
  // Workers without an identified administrator owner may read only project-published resources.
  const active = plan?.workerId === id && (plan.mode === 'opora' || plan.mode === 'router');
  const admin = !!active && (!plan.owner || ctx.accounts.get(plan.owner)?.role === 'admin');
  if (url.searchParams.has('recommend')) return recommendationRequest(ctx, floor, req, res, url, admin);
  if (req.method === 'GET' && url.searchParams.has('read')) {
    const library = new HarnessLibrary(harnessSources(floor.dir, admin)); await library.list();
    const entry = await library.read(url.searchParams.get('read') ?? '');
    return entry ? send(res, 200, entry) : send(res, 404, { error: 'Resource is unavailable for this worker.' });
  }
  if (url.searchParams.has('hierarchy')) return harnessHierarchyRequest(ctx, floor, req, res, url,
    { local: admin, writable: admin, globalWrite: false, actor: 'worker:' + id });
  if (req.method === 'GET' && url.searchParams.has('catalog')) {
    return send(res, 200, await new HarnessLibrary(harnessSources(floor.dir, admin), new HarnessRegistry(ctx.cfg.dataDir)).list());
  }
  if (req.method === 'GET' && url.searchParams.has('kit')) {
    try { return send(res, 200, await buildHarnessKit(new HarnessLibrary(harnessSources(floor.dir, admin)),
      url.searchParams.get('problem') ?? '', url.searchParams.getAll('resource')), { 'cache-control': 'no-store' }); }
    catch (err) { return send(res, err instanceof HarnessError ? err.status : 400, { error: (err as Error).message }, { 'cache-control': 'no-store' }); }
  }
  return harnessProfileRequest(ctx, floor, req, res, url, admin, admin, false);
}

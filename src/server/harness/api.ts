import type http from 'node:http';
import type { Ctx } from '../office/context.js';
import type { Floor } from '../floor.js';
import { readBody, send } from '../http/util.js';
import { HarnessProfiles, HarnessError, parseHarnessLayer } from './profiles.js';
import { harnessHandoff } from './handoff.js';
import { HarnessLibrary, harnessSources } from './catalog.js';
import { oporaHarnessTask } from '../../shared/harness-cascade.js';
import { documentationRequest } from './documentation-api.js';

export async function harnessProfileRequest(ctx: Ctx, floor: Floor, req: http.IncomingMessage, res: http.ServerResponse, url: URL, local: boolean, writable: boolean, globalWrite: boolean) {
  try {
    const store = new HarnessProfiles(ctx.cfg.dataDir);
    const task = url.searchParams.get('task') ?? '';
    if (req.method === 'POST') {
      if (!writable) return send(res, 403, { error: 'Only administrators and their active orchestrator can assign harness profiles.' });
      const body = JSON.parse(await readBody(req, 300_000));
      if (!body || typeof body !== 'object') throw new HarnessError('Expected a JSON object');
      if (body.scope === 'global' && !globalWrite) return send(res, 403, { error: 'Global settings require the administrator UI.' });
      const layer = parseHarnessLayer(body.layer);
      const ids = Object.values(layer).flatMap((b) => b && 'resource' in b ? [b.resource] : []);
      if (ids.length) {
        const lib = new HarnessLibrary(harnessSources(floor.dir, local));
        const catalog = await lib.list();
        for (const id of ids) if (!catalog.entries.some((entry) => entry.id === id)) throw new HarnessError('Unknown or inaccessible resource: ' + id);
      }
      store.save(floor.dir, task, body.scope, layer, body.revision);
    } else if (req.method !== 'GET') return send(res, 405, { error: 'Use GET or POST' });
    const view = store.view(floor.dir, task);
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
  const plan = floor.planning.state().current;
  // Workers without an identified administrator owner may read only project-published resources.
  const active = plan?.workerId === id && (plan.mode === 'opora' || plan.mode === 'router');
  const admin = !!active && (!plan.owner || ctx.accounts.get(plan.owner)?.role === 'admin');
  if (req.method === 'GET' && url.searchParams.has('catalog')) {
    return send(res, 200, await new HarnessLibrary(harnessSources(floor.dir, admin)).list());
  }
  return harnessProfileRequest(ctx, floor, req, res, url, admin, admin, false);
}

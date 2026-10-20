import type http from 'node:http';
import type { Ctx } from '../office/context.js';
import type { Floor } from '../floor.js';
import { readBody, send } from '../http/util.js';
import { HarnessProfiles, HarnessError, parseHarnessLayer } from './profiles.js';
import { harnessHandoff } from './handoff.js';
import { HarnessLibrary, harnessSources } from './catalog.js';
import { HARNESS_LEVELS, harnessLevel, oporaHarnessTask, pathNode } from '../../shared/harness-cascade.js';
import { harnessDeadEnd, harnessTarget } from '../../shared/harness-hierarchy.js';
import { oporaKey, parseOporaKey } from '../../shared/opora-identity.js';

/**
 * Reads or saves profiles down to what `?task=` or `?node=` addresses: an Opora key of the floor's
 * project is placed on the canvas (its page, layer, area and sector resolve with it), a key of another
 * project or workspace is refused, and anything else is a custom task id. `by` goes into the audit.
 * A save below the project at a node of the canvas names the node it was edited for (`at`, the node's key
 * on the path the preceding read returned): when the canvas has since moved the target so that level is
 * another node now, it is refused (409) rather than written where the editor never looked. A save at the
 * level the canvas gives a card no task's path goes through (a card between the page and the layers) is
 * refused (400): it would reach nothing. The audit a reader gets is the floor's repository's; global saves
 * and other repositories' are the administrator's to see (`auditAll`), never a worker's.
 */
export async function harnessProfileRequest(ctx: Ctx, floor: Floor, req: http.IncomingMessage, res: http.ServerResponse, url: URL, local: boolean, writable: boolean, globalWrite: boolean, by = '', auditAll = local) {
  try {
    const store = new HarnessProfiles(ctx.cfg.dataDir);
    const id = url.searchParams.get('node') ?? url.searchParams.get('task') ?? '';
    const opora = floor.opora.view();
    const place = opora.project && opora.workspace ? { project: opora.project.id, workspace: opora.workspace } : undefined;
    let path;
    try { path = harnessTarget(floor.opora.canvasNodes(), place, id); }
    catch (err) { throw new HarnessError((err as Error).message, 400); }
    if (req.method === 'POST') {
      if (!writable) return send(res, 403, { error: 'Only administrators and their active orchestrator can assign harness profiles.' });
      const body = JSON.parse(await readBody(req, 300_000));
      if (!body || typeof body !== 'object') throw new HarnessError('Expected a JSON object');
      if (body.scope === 'global' && !globalWrite) return send(res, 403, { error: 'Global settings require the administrator UI.' });
      const level = harnessLevel(body.scope);
      const below = level && level !== 'global' && level !== 'project';
      const at = below ? pathNode(path, level)?.node : undefined;
      const canvasId = place ? parseOporaKey(id)?.nodeId : undefined;
      if (below && canvasId && at && body.at === undefined) throw new HarnessError(`Send "at": the key of the ${level} node this save was edited for, from the path the preceding read returned.`);
      if (body.at !== undefined && body.at !== (at ?? '')) throw new HarnessError('The canvas moved this node since you loaded it: reload before saving.', 409);
      // The addressed node itself is the one at this level (its canonical key, however the request spelled it).
      const deadEnd = below && canvasId && place && at === oporaKey(place, canvasId) ? harnessDeadEnd(floor.opora.canvasNodes(), canvasId) : undefined;
      if (deadEnd) throw new HarnessError(deadEnd);
      const layer = parseHarnessLayer(body.layer);
      const ids = Object.values(layer).flatMap((b) => b && 'resource' in b ? [b.resource] : []);
      if (ids.length) {
        const lib = new HarnessLibrary(harnessSources(floor.dir, local));
        const catalog = await lib.list();
        for (const id of ids) if (!catalog.entries.some((entry) => entry.id === id)) throw new HarnessError('Unknown or inaccessible resource: ' + id);
      }
      await store.save(floor.dir, path, body.scope, layer, body.revision, by);
    } else if (req.method !== 'GET') return send(res, 405, { error: 'Use GET or POST' });
    const view = store.view(floor.dir, path);
    const tasks = place ? opora.cards.map((card) => ({ id: oporaHarnessTask(place.project, place.workspace, card.id), title: card.name })) : [];
    let preview = '', warning = '';
    try { preview = await harnessHandoff(ctx.cfg.dataDir, floor.dir, path, local, view); }
    catch (err) { warning = (err as Error).message; }
    send(res, 200, { ...view, levels: HARNESS_LEVELS, tasks, audit: store.audit(20, floor.dir, auditAll), writable, globalWrite, preview, warning });
  } catch (err) {
    send(res, err instanceof HarnessError ? err.status : 400, { error: (err as Error).message });
  }
}

/** Worker credentials are floor-scoped. Only the live admin-owned planner may mutate the layers below global. */
export async function officeHarness(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const id = url.searchParams.get('worker') ?? '';
  const floor = ctx.workerFloor(id);
  const me = floor?.workers.authenticate(id, (req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  if (!floor || !me) return send(res, 401, { error: 'Use your worker ID and hook bearer token.' });
  const plan = floor.planning.state().current;
  // Workers without an identified administrator owner may read only project-published resources.
  const active = plan?.workerId === id && (plan.mode === 'opora' || plan.mode === 'router');
  const admin = !!active && (!plan.owner || ctx.accounts.get(plan.owner)?.role === 'admin');
  if (req.method === 'GET' && url.searchParams.has('catalog')) {
    return send(res, 200, await new HarnessLibrary(harnessSources(floor.dir, admin)).list());
  }
  return harnessProfileRequest(ctx, floor, req, res, url, admin, admin, false, 'worker:' + id, false);
}

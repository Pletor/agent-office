import type http from 'node:http';
import type { Ctx } from '../office/context.js';
import type { Floor } from '../floor.js';
import { readBody, send } from '../http/util.js';
import { HarnessProfiles, HarnessError, harnessRepoKey, parseHarnessLayer } from './profiles.js';
import { harnessHandoff, assertBindable } from './handoff.js';
import { HarnessLibrary, harnessSources } from './catalog.js';
import { HarnessRegistry } from './registry.js';
import { HarnessBindings, assertBoundWrite, bindingView } from './bindings.js';
import { HarnessRequests } from './requests.js';
import { HARNESS_LEVELS, harnessLevel, oporaHarnessTask, pathNode } from '../../shared/harness-cascade.js';
import { harnessDeadEnd, harnessTarget } from '../../shared/harness-hierarchy.js';
import { oporaKey, parseOporaKey, samePlace } from '../../shared/opora-identity.js';

/** The header a reply carries when it is the stored result of a write done before (requests.ts), not a new write. */
export const REPLAY_HEADER = 'x-harness-replay';

/**
 * Reads or saves profiles down to what `?task=` or `?node=` addresses: an Opora key of the floor's
 * project is placed on the canvas (its page, layer, area and sector resolve with it), a key of another
 * project or workspace is refused, and anything else is a custom task id. `by` goes into the audit.
 * The floor's project is its binding (bindings.ts), the window's link while it has none (so a key is checked against the binding, never against a window that drifted away from it); a save at an
 * Opora node is checked against the binding first (`assertBoundWrite`: unbound, foreign, Opora down,
 * link drifted, unknown node), and a request that names the project and workspace it acts on
 * (`project`, `workspace`) is refused when they aren't the floor's. A save sent again with its
 * `requestId` (or the same payload) gets the stored result back and writes nothing (requests.ts).
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
    const binding = new HarnessBindings(ctx.cfg.dataDir).forFloor(floor.id);
    const linked = opora.project && opora.workspace ? { project: opora.project.id, workspace: opora.workspace } : undefined;
    // The binding says which project's keys this floor takes; the window's link only while there is none.
    const place = binding ? { project: binding.project, workspace: binding.workspace } : linked;
    const canvas = floor.opora.canvasNodes();
    let path;
    try { path = harnessTarget(canvas, place, id); }
    catch (err) {
      // Another project's node: a read of it is a bad address (400); a write to it would change another project's profiles (403).
      const at = parseOporaKey(id);
      if (req.method === 'POST' && binding && at && !samePlace(at, binding)) throw new HarnessError(`That node is in project ${at.project}, workspace ${at.workspace}; floor ${floor.id} is bound to project ${binding.project}, workspace ${binding.workspace}. Another project's profiles are not this floor's to change.`, 403);
      throw new HarnessError((err as Error).message, 400);
    }
    let body: Record<string, unknown> | undefined, requests: HarnessRequests | undefined;
    const scope = 'repo:' + harnessRepoKey(floor.dir);
    if (req.method === 'POST') {
      if (!writable) return send(res, 403, { error: 'Only administrators and their active orchestrator can assign harness profiles.' });
      body = JSON.parse(await readBody(req, 300_000));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HarnessError('Expected a JSON object');
      if (body.scope === 'global' && !globalWrite) return send(res, 403, { error: 'Global settings require the administrator UI.' });
      requests = new HarnessRequests(ctx.cfg.dataDir);
      const replay = requests.replay(scope, body);
      if (replay) return send(res, replay.status, replay.body, { [REPLAY_HEADER]: '1' });
      const level = harnessLevel(body.scope);
      const below = !!level && level !== 'global' && level !== 'project';
      const canvasId = parseOporaKey(id)?.nodeId;
      assertBoundWrite({ floorId: floor.id, binding, opora: { connected: !!opora.connected, error: opora.error }, linked, key: id, below, claims: { project: body.project, workspace: body.workspace }, known: canvasId === undefined || canvas.some((n) => n.id === canvasId) });
      const at = below ? pathNode(path, level)?.node : undefined;
      if (below && canvasId && at && body.at === undefined) throw new HarnessError(`Send "at": the key of the ${level} node this save was edited for, from the path the preceding read returned.`);
      if (body.at !== undefined && body.at !== (at ?? '')) throw new HarnessError('The canvas moved this node since you loaded it: reload before saving.', 409);
      // The addressed node itself is the one at this level (its canonical key, however the request spelled it).
      const deadEnd = below && canvasId && place && at === oporaKey(place, canvasId) ? harnessDeadEnd(canvas, canvasId) : undefined;
      if (deadEnd) throw new HarnessError(deadEnd);
      const layer = parseHarnessLayer(body.layer);
      const ids = Object.values(layer).flatMap((b) => b && 'resource' in b ? [b.resource] : []);
      if (ids.length) {
        const lib = new HarnessLibrary(harnessSources(floor.dir, local), new HarnessRegistry(ctx.cfg.dataDir));
        await lib.list();
        for (const id of ids) assertBindable(lib, body.scope as never, id);
      }
      await store.save(floor.dir, path, body.scope, layer, body.revision, by);
    } else if (req.method !== 'GET') return send(res, 405, { error: 'Use GET or POST' });
    const view = store.view(floor.dir, path);
    const tasks = place && samePlace(place, linked) ? opora.cards.map((card) => ({ id: oporaHarnessTask(place.project, place.workspace, card.id), title: card.name })) : [];
    let preview = '', warning = '';
    try { preview = await harnessHandoff(ctx.cfg.dataDir, floor.dir, path, local, view); }
    catch (err) { warning = (err as Error).message; }
    if (!opora.connected) warning = [warning, `Opora isn't answering: this is the local store down the canvas as last read${opora.error ? ' (' + opora.error + ')' : ''}.`].filter(Boolean).join(' ');
    const result = { ...view, levels: HARNESS_LEVELS, tasks, audit: store.audit(20, floor.dir, auditAll), binding: bindingView(binding), writable, globalWrite, preview, warning };
    if (body && requests) requests.record(scope, body, 200, result);
    send(res, 200, result);
  } catch (err) {
    send(res, err instanceof HarnessError ? err.status : 400, { error: (err as Error).message });
  }
}

/**
 * Who a worker's request is from: its floor, and whether it is the live orchestrator (Opora planner or
 * router) an administrator owns, the only worker that may write. Undefined for a wrong id or token.
 */
export function workerAccess(ctx: Ctx, req: http.IncomingMessage, url: URL): { id: string; floor: Floor; admin: boolean } | undefined {
  const id = url.searchParams.get('worker') ?? '';
  const floor = ctx.workerFloor(id);
  const me = floor?.workers.authenticate(id, (req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  if (!floor || !me) return undefined;
  const plan = floor.planning.state().current;
  // Workers without an identified administrator owner may read only project-published resources.
  const active = plan?.workerId === id && (plan.mode === 'opora' || plan.mode === 'router');
  const admin = !!active && (!plan.owner || ctx.accounts.get(plan.owner)?.role === 'admin');
  return { id, floor, admin };
}

/** Worker credentials are floor-scoped. Only the live admin-owned planner may mutate the layers below global. */
export async function officeHarness(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const access = workerAccess(ctx, req, url);
  if (!access) return send(res, 401, { error: 'Use your worker ID and hook bearer token.' });
  const { id, floor, admin } = access;
  if (req.method === 'GET' && url.searchParams.has('catalog')) {
    return send(res, 200, await new HarnessLibrary(harnessSources(floor.dir, admin), new HarnessRegistry(ctx.cfg.dataDir)).list());
  }
  return harnessProfileRequest(ctx, floor, req, res, url, admin, admin, false, 'worker:' + id, false);
}

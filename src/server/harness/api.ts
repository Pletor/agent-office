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
import { officeSnapshotRead } from './snapshot-api.js';
import { HARNESS_LEVELS, harnessLevel, oporaHarnessTask, pathNode, type HarnessProfile } from '../../shared/harness-cascade.js';
import { harnessDeadEnd, harnessTarget, type HierarchyNode } from '../../shared/harness-hierarchy.js';
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
 * `requestId` (or the same payload) by the same identity gets the stored result back and writes nothing (requests.ts).
 * A save below the project at a node of the canvas names the node it was edited for (`at`, the node's key
 * on the path the preceding read returned): when the canvas has moved the target so that level is
 * another node now, it is refused (409) rather than written where the editor never looked. That is
 * checked twice: on the request, and again under the store's lock right before the write, against the
 * canvas as it is then, because the save may have waited for another office's lock. A save at the
 * level the canvas gives a card no task's path goes through (a card between the page and the layers) is
 * refused (400): it would reach nothing. The audit a reader gets is the floor's repository's; global saves
 * and other repositories' are the administrator's to see (`auditAll`), never a worker's.
 * A save that committed is answered 200 with the committed profile even when the rest of the response
 * (tasks, audit, preview) can't be built: the error goes into `warning`, never into a non-2xx status.
 */
export async function harnessProfileRequest(ctx: Ctx, floor: Floor, req: http.IncomingMessage, res: http.ServerResponse, url: URL, local: boolean, writable: boolean, globalWrite: boolean, by = '', auditAll = local) {
  let committed: HarnessProfile | undefined;
  const rest = { levels: HARNESS_LEVELS, writable, globalWrite };
  try {
    const store = new HarnessProfiles(ctx.cfg.dataDir);
    const id = url.searchParams.get('node') ?? url.searchParams.get('task') ?? '';
    const opora = floor.opora.view();
    const binding = new HarnessBindings(ctx.cfg.dataDir).forFloor(floor.id);
    const linked = opora.project && opora.workspace ? { project: opora.project.id, workspace: opora.workspace } : undefined;
    // The binding says which project's keys this floor takes; the window's link only while there is none.
    const place = binding ? { project: binding.project, workspace: binding.workspace } : linked;
    const canvas = floor.opora.canvasNodes();
    const target = (nodes: readonly HierarchyNode[]) => {
      try { return harnessTarget(nodes, place, id); }
      catch (err) { throw new HarnessError((err as Error).message, 400); }
    };
    let path: ReturnType<typeof target>;
    let view: HarnessProfile;
    let body: Record<string, unknown> | undefined, requests: HarnessRequests | undefined;
    // The log of accepted writes is the caller's own: a retry is by the same identity, and nobody is handed another's reply.
    const scope = 'repo:' + harnessRepoKey(floor.dir) + ':' + by;
    // The reply both a read and a committed write end in; a write records it in the request log (under that log's lock).
    const respond = async () => {
      const tasks = place && samePlace(place, linked) ? opora.cards.map((card) => ({ id: oporaHarnessTask(place.project, place.workspace, card.id), title: card.name })) : [];
      let preview = '', warning = '';
      try { preview = await harnessHandoff(ctx.cfg.dataDir, floor.dir, path, local, view); }
      catch (err) { warning = (err as Error).message; }
      if (!opora.connected) warning = [warning, `Opora isn't answering: this is the local store down the canvas as last read${opora.error ? ' (' + opora.error + ')' : ''}.`].filter(Boolean).join(' ');
      const result = { ...view, ...rest, tasks, audit: store.audit(20, floor.dir, auditAll), binding: bindingView(binding), preview, warning };
      // The write is done; remembering it is for the retry's sake and never fails the reply. The stored reply has no preview (a GET gives it).
      if (body && requests) try { requests.record(scope, body, 200, { ...result, preview: '' }, id); } catch (err) { console.error('harness: the request log was not written: ' + (err as Error).message); }
      send(res, 200, result);
    };
    if (req.method === 'POST') {
      if (!writable) return send(res, 403, { error: 'Only administrators and their active orchestrator can assign harness profiles.' });
      body = JSON.parse(await readBody(req, 300_000));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HarnessError('Expected a JSON object');
      if (body.scope === 'global' && !globalWrite) return send(res, 403, { error: 'Global settings require the administrator UI.' });
      const log = requests = new HarnessRequests(ctx.cfg.dataDir);
      // The log's lock is held from the replay check to the record: the same write sent twice at once is done once, the second is a replay.
      const posted: Record<string, unknown> = body;
      await log.exclusive(async () => {
        const replay = log.replay(scope, posted, id);
        if (replay) return send(res, replay.status, replay.body, { [REPLAY_HEADER]: '1' });
        const level = harnessLevel(posted.scope);
        const below = !!level && level !== 'global' && level !== 'project';
        const canvasId = parseOporaKey(id)?.nodeId;
        // The binding is checked before the key is placed on the canvas, so an unbound floor hears "bind first" and a foreign node "not yours", whatever the window reads.
        assertBoundWrite({ floorId: floor.id, binding, opora: { connected: !!opora.connected, error: opora.error }, linked, key: id, below, claims: { project: posted.project, workspace: posted.workspace }, known: canvasId === undefined || canvas.some((n) => n.id === canvasId) });
        path = target(canvas);
        const at = below ? pathNode(path, level)?.node : undefined;
        if (below && canvasId && at && posted.at === undefined) throw new HarnessError(`Send "at": the key of the ${level} node this save was edited for, from the path the preceding read returned.`);
        if (posted.at !== undefined && posted.at !== (at ?? '')) throw new HarnessError('The canvas moved this node since you loaded it: reload before saving.', 409);
        /** The target's place on the canvas as `nodes` has it: the node at the level must still be `at`, and must not be a dead end. */
        const placed = (nodes: readonly HierarchyNode[], fresh: boolean) => {
          if (!below || !canvasId) return;
          if (fresh && pathNode(target(nodes), level)?.node !== at) throw new HarnessError('The canvas moved this node while the save waited for the store: reload before saving.', 409);
          // The addressed node itself is the one at this level (its canonical key, however the request spelled it).
          const deadEnd = place && at === oporaKey(place, canvasId) ? harnessDeadEnd(nodes, canvasId) : undefined;
          if (deadEnd) throw new HarnessError(deadEnd);
        };
        placed(canvas, false);
        const layer = parseHarnessLayer(posted.layer);
        const ids = Object.values(layer).flatMap((b) => b && 'resource' in b ? [b.resource] : []);
        if (ids.length) {
          const lib = new HarnessLibrary(harnessSources(floor.dir, local), new HarnessRegistry(ctx.cfg.dataDir));
          await lib.list();
          for (const id of ids) assertBindable(lib, posted.scope as never, id);
        }
        view = committed = await store.save(floor.dir, path, posted.scope, layer, posted.revision, by, () => placed(floor.opora.canvasNodes(), true));
        await respond();
      });
    } else if (req.method !== 'GET') return send(res, 405, { error: 'Use GET or POST' });
    else { path = target(canvas); view = store.view(floor.dir, path); await respond(); }
  } catch (err) {
    if (committed) return send(res, 200, { ...committed, ...rest, tasks: [], audit: [], preview: '', warning: `Saved as revision ${committed.revision}, but the rest of this response could not be built: ${(err as Error).message}` });
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
  if (req.method === 'GET' && url.searchParams.has('read')) return officeSnapshotRead(ctx, floor, id, res, url);
  if (req.method === 'GET' && url.searchParams.has('catalog')) {
    return send(res, 200, await new HarnessLibrary(harnessSources(floor.dir, admin), new HarnessRegistry(ctx.cfg.dataDir)).list());
  }
  return harnessProfileRequest(ctx, floor, req, res, url, admin, admin, false, 'worker:' + id, false);
}

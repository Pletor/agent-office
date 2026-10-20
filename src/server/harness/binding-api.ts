// The binding endpoints: what Opora project and workspace a floor is bound to, and binding it.
// Browser: GET/POST /api/harness/binding?floor=ID (http/routes/harness.ts). Worker: GET/POST
// /office/harness/binding?worker=ID with the hook bearer token (hooks/server.ts), the floor being the
// worker's own. Reading is for anyone who may read the floor's profiles; binding is for administrators
// (or the shared-password session) and the live orchestrator an administrator owns.
import type http from 'node:http';
import type { Ctx } from '../office/context.js';
import type { Floor } from '../floor.js';
import { readBody, send } from '../http/util.js';
import { HarnessError } from './profiles.js';
import { HarnessBindings, parseBindingPlace } from './bindings.js';
import { HarnessRequests } from './requests.js';
import { REPLAY_HEADER, workerAccess } from './api.js';
import type { OporaPlace } from '../../shared/opora-identity.js';
import type { OporaState } from '../../shared/protocol.js';

/**
 * Why `place` can't be bound to a floor whose Opora window reads `view`: Opora isn't answering (503,
 * the ids can't be checked), no project is linked yet (409), or the window reads another project or
 * workspace (409). A binding names what the floor reads, so the two never start apart.
 */
export function checkBindTarget(view: Pick<OporaState, 'connected' | 'error' | 'project' | 'workspace'>, place: OporaPlace): void {
  if (!view.connected) throw new HarnessError(`Opora isn't answering${view.error ? ' (' + view.error + ')' : ''}: the project and workspace can't be checked, so nothing was bound.`, 503);
  if (!view.project || !view.workspace) throw new HarnessError(`No Opora project is linked to this floor yet${view.error ? ' (' + view.error + ')' : ''}: pick one in the 🛰️ Opora window, then bind.`, 409);
  if (view.project.id !== place.project || view.workspace !== place.workspace) throw new HarnessError(`This floor's Opora window reads project ${view.project.id} (${view.project.name}), workspace ${view.workspace}: bind that, or link the window to project ${place.project}, workspace ${place.workspace} first. A binding never names a project the floor doesn't read.`, 409);
}

/** GET: the floor's binding, the store's revision and the floor's bind audit. POST {project, workspace, rebind?, revision?, requestId?}: binds, rebinds explicitly, retries safely. */
export async function harnessBindingRequest(ctx: Ctx, floor: Floor, req: http.IncomingMessage, res: http.ServerResponse, writable: boolean, by: string) {
  try {
    const bindings = new HarnessBindings(ctx.cfg.dataDir);
    const reply = () => ({ binding: bindings.forFloor(floor.id) ?? null, revision: bindings.revision(), audit: bindings.audit(20, floor.id), writable });
    if (req.method === 'GET') return send(res, 200, reply());
    if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST' });
    if (!writable) return send(res, 403, { error: 'Only administrators and their active orchestrator can bind a floor to an Opora project.' });
    const body = JSON.parse(await readBody(req, 64_000));
    const place = parseBindingPlace(body);
    const requests = new HarnessRequests(ctx.cfg.dataDir);
    const scope = 'floor:' + floor.id + ':' + by;
    // The log's lock is held across replay check, bind and record: the same request twice binds once, the second is a replay.
    await requests.exclusive(async () => {
      const replay = requests.replay(scope, body);
      // A retry by requestId gets its stored reply; a payload-only repeat only while that reply is still the truth (same bindings revision), else it is a normal request: 409 on a conflicting bind, idempotent when the binding already equals it.
      const current = replay && (body.requestId !== undefined || (replay.body as { revision?: unknown } | null)?.revision === bindings.revision());
      if (replay && current) return send(res, replay.status, replay.body, { [REPLAY_HEADER]: '1' });
      checkBindTarget(floor.opora.view(), place);
      const { changed } = await bindings.bind(floor.id, floor.dir, place, by, { rebind: body.rebind === true, revision: body.revision });
      const result = { ...reply(), changed };
      try { requests.record(scope, body, 200, result); } catch (err) { console.error('harness: the request log was not written: ' + (err as Error).message); }
      send(res, 200, result);
    });
  } catch (err) {
    send(res, err instanceof HarnessError ? err.status : 400, { error: (err as Error).message });
  }
}

/** The worker endpoint: the worker's own floor, read by any worker of it, bound only by the live admin-owned orchestrator. */
export async function officeHarnessBinding(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const access = workerAccess(ctx, req, url);
  if (!access) return send(res, 401, { error: 'Use your worker ID and hook bearer token.' });
  return harnessBindingRequest(ctx, access.floor, req, res, access.admin, 'worker:' + access.id);
}

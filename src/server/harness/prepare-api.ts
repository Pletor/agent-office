// The preparation plan over HTTP (docs/harness.md "Preparation runner"): a dry run of the runner for one
// card of the floor, read-only. `GET /api/harness/prepare-plan?floor=ID&task=KEY` for a session of the
// office, and `GET /office/harness?worker=ID&preparePlan=1&task=KEY` for a worker with its hook token
// (what `office-harness --prepare-plan --task KEY` calls). The same reads as the catalog: an
// administrator, the shared-password session or the admin-owned orchestrator sees machine resources,
// everyone else the project-published ones. Nothing is written by either (the library is listed read-only).
import type http from 'node:http';
import type { Ctx } from '../office/context.js';
import type { Floor } from '../floor.js';
import { send } from '../http/util.js';
import { HarnessError } from './profiles.js';
import { HarnessBindings } from './bindings.js';
import { preparePlan, redactPaths } from './prepare.js';
import { parseOporaKey, samePlace } from '../../shared/opora-identity.js';

/** The dry-run plan for the card `?task=` (or `?node=`) names, on the floor's project and workspace. */
export async function preparePlanRequest(ctx: Ctx, floor: Floor, res: http.ServerResponse, url: URL, local: boolean) {
  const headers = { 'cache-control': 'no-store' };
  try {
    const key = url.searchParams.get('task') ?? url.searchParams.get('node') ?? '';
    const card = parseOporaKey(key);
    if (!card) throw new HarnessError('The preparation plan takes the key of an Opora card (opora:PROJECT:WORKSPACE:CARD, from --effective).', 400);
    // The binding says which project's cards this floor takes; the window's link only while there is none (as for profiles).
    const binding = new HarnessBindings(ctx.cfg.dataDir).forFloor(floor.id);
    const view = floor.opora.view();
    const place = binding ? { project: binding.project, workspace: binding.workspace } : view.project && view.workspace ? { project: view.project.id, workspace: view.workspace } : undefined;
    if (!place) throw new HarnessError('This floor reads no Opora project yet: link one in the Opora window, or bind the floor.', 409);
    if (!samePlace(place, card)) throw new HarnessError(`${key} is in project ${card.project}, workspace ${card.workspace}; this floor takes cards of project ${place.project}, workspace ${place.workspace}.`, 409);
    send(res, 200, await preparePlan({ dataDir: ctx.cfg.dataDir, repo: floor.dir, place, card: card.nodeId, nodes: floor.opora.canvasNodes(), local, runner: floor.workers?.officeDefault.provider }), headers);
  } catch (err) {
    // The server's folders are never in the answer: named in a refusal, and an unexpected error is logged, not sent.
    if (!(err instanceof HarnessError)) console.error('agent-office: preparation plan failed:', err);
    const message = err instanceof HarnessError ? redactPaths(err.message, { '<dataDir>': ctx.cfg.dataDir, '<checkout>': floor.dir }) : 'The preparation plan could not be made (an internal error; the office log has it).';
    send(res, err instanceof HarnessError ? err.status : 500, { error: message }, headers);
  }
}

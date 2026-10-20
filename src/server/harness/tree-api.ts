// What the library's context bar reads (docs/harness.md "Choosing the context"): the floors of this
// office as projects with their Opora binding, and one floor's specialization tree. Read-only.
//
// GET /api/harness/projects       every floor: its name, binding (with the Opora project's name) and status.
// GET /api/harness/tree?floor=ID  that floor's tree, built from its own binding and its own canvas only.
//
// A floor's tree is offered only when the floor is bound and its Opora window reads exactly the bound
// project and workspace: unbound, Opora not answering, or a window that drifted to another project
// answers with an empty tree and a notice, never with a tree made up or read from somewhere else. A
// request that names a project or workspace (`project`, `workspace`) other than the floor's binding is
// refused (403): one floor's tree is never handed out under another floor's project.
import type http from 'node:http';
import type { Ctx } from '../office/context.js';
import type { Floor } from '../floor.js';
import { send } from '../http/util.js';
import { HarnessError, harnessRepoKey } from './profiles.js';
import { HarnessBindings } from './bindings.js';
import { HarnessLibrary, harnessSources } from './catalog.js';
import { samePlace } from '../../shared/opora-identity.js';
import { harnessTree, type HarnessTreeNode, type HarnessTreeStatus } from '../../shared/harness-tree.js';

/** A floor as the project picker lists it. */
export interface HarnessProjectView {
  floor: string;
  name: string;
  /** The key the profile store and its audit file the floor's checkout under (profiles.ts harnessRepoKey), so the editor shows this project's saves only. */
  repo: string;
  binding: { project: string; workspace: string; projectName: string } | null;
  status: HarnessTreeStatus | 'error';
  notice: string;
}

/** The namespaces whose elements the global layer may bind on this floor (catalog.ts decides; this only asks it). */
export function globalNamespaces(floor: Pick<Floor, 'dir'>, local: boolean): string[] {
  const library = new HarnessLibrary(harnessSources(floor.dir, local));
  return ['handbook', 'machine', 'published', 'openviking', 'project'].filter((ns) => !library.globalReason(ns === 'handbook' ? 'guide:probe' : `el:${ns}:probe`));
}

/** The floor's binding, the Opora project's name and why there's no tree (if there is none). */
function describe(ctx: Ctx, floor: Floor): HarnessProjectView {
  const name = floor.info?.().name ?? floor.id;
  const repo = harnessRepoKey(floor.dir);
  let bound;
  try { bound = new HarnessBindings(ctx.cfg.dataDir).forFloor(floor.id); }
  catch (err) { return { floor: floor.id, name, repo, binding: null, status: 'error', notice: (err as Error).message }; }
  const view = floor.opora.view();
  if (!bound) return { floor: floor.id, name, repo, binding: null, status: 'unbound', notice: 'Not linked to an Opora project: only the project level can be edited here. An administrator binds the floor (office-harness --bind PROJECT WORKSPACE, or POST /api/harness/binding).' };
  const projectName = view.projects?.find((p) => p.id === bound.project)?.name || (view.project?.id === bound.project ? view.project.name : '');
  const binding = { project: bound.project, workspace: bound.workspace, projectName: projectName || bound.project };
  if (!view.connected) return { floor: floor.id, name, repo, binding, status: 'unreachable', notice: `Opora isn't answering${view.error ? ' (' + view.error + ')' : ''}: specializations need its canvas, so only the project level can be edited now.` };
  const linked = view.project && view.workspace ? { project: view.project.id, workspace: view.workspace } : undefined;
  if (!samePlace(bound, linked)) return { floor: floor.id, name, repo, binding, status: 'elsewhere', notice: 'The floor\'s Opora window reads another project or workspace than its binding: link the window back to the bound project to choose specializations.' };
  return { floor: floor.id, name, repo, binding, status: 'ready', notice: '' };
}

/** GET /api/harness/projects: every floor of the office with its binding and status, and the namespaces of the Global view's elements. */
export function harnessProjectsRequest(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, local: boolean) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' });
  const floors = [...ctx.floors.values()];
  const projects = floors.map((floor) => describe(ctx, floor));
  // Which elements belong to the Global view: the same for every floor (the pinned sources are the installation's).
  send(res, 200, { projects, globalNamespaces: globalNamespaces({ dir: floors[0]?.dir ?? process.cwd() }, local) }, { 'cache-control': 'no-store' });
}

/** GET /api/harness/tree?floor=ID: that floor's specialization tree, or an empty one with the reason. */
export function harnessTreeRequest(ctx: Ctx, floor: Floor, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  try {
    if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' });
    const about = describe(ctx, floor);
    if (about.status === 'error') throw new HarnessError(about.notice, 503);
    const claims = { project: url.searchParams.get('project'), workspace: url.searchParams.get('workspace') };
    if ((claims.project !== null && claims.project !== about.binding?.project) || (claims.workspace !== null && claims.workspace !== about.binding?.workspace)) {
      throw new HarnessError(`Floor ${floor.id} is not bound to that project and workspace: a floor's tree is its own binding's, never another floor's.`, 403);
    }
    let tree: HarnessTreeNode[] = [];
    if (about.status === 'ready' && about.binding) tree = harnessTree(floor.opora.canvasNodes(), about.binding);
    send(res, 200, { ...about, tree }, { 'cache-control': 'no-store' });
  } catch (err) {
    send(res, err instanceof HarnessError ? err.status : 400, { error: (err as Error).message });
  }
}

import type http from 'node:http';
import type { Floor } from '../floor.js';
import { send } from '../http/util.js';
import { oporaHarnessTask } from '../../shared/harness-cascade.js';
import { nativeInvocations, noInvocations } from './native-invocations.js';

const identifier = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}$/.test(value);
const peerKey = (floor: Floor) => {
  const view = floor.opora.view();
  return JSON.stringify([view.url, view.connected, view.project?.id ?? null, view.workspace ?? null]);
};

/** A read of the authenticated worker's linked project, with no caller-selected peer or scope. */
export async function measurementsRequest(floor: Floor, req: http.IncomingMessage, res: http.ServerResponse,
  url: URL, stillAuthorized: () => boolean) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' });
  const allowed = new Set(['worker', 'invocations', 'task', 'resource']);
  if ([...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)
    || url.searchParams.get('invocations') !== '1') return send(res, 400, { error: 'Invalid measurement query.' });
  const resource = url.searchParams.get('resource');
  if (resource !== null && !identifier(resource)) return send(res, 400, { error: 'Invalid resource identity.' });
  const view = floor.opora.view(), before = peerKey(floor), task = url.searchParams.get('task');
  if (!view.connected || !view.project || !view.workspace) {
    return send(res, 200, noInvocations('floor-not-connected'));
  }
  const scope = { project: view.project.id, workspace: view.workspace, nodeId: null as string | null };
  if (task !== null) {
    const prefix = oporaHarnessTask(scope.project, scope.workspace, '');
    if (!task.startsWith(prefix)) return send(res, 403, { error: 'Task is outside the linked project/workspace.' });
    try {
      scope.nodeId = decodeURIComponent(task.slice(prefix.length));
      if (!identifier(scope.nodeId) || oporaHarnessTask(scope.project, scope.workspace, scope.nodeId) !== task) throw new Error();
    } catch { return send(res, 400, { error: 'Invalid task identity.' }); }
  }
  const report = await nativeInvocations(view.url, scope, resource ?? undefined);
  if (!stillAuthorized()) return send(res, 401, { error: 'Worker authorization is no longer current.' });
  if (peerKey(floor) !== before) return send(res, 409, { error: 'Linked project changed while reading measurements. Retry.' });
  return send(res, 200, { ...report, scope, resource: resource ?? null });
}

import type { Route } from '../router.js';
import { send, sameOrigin } from '../util.js';
import { floorParam } from './files.js';
import { harnessHierarchyRequest, harnessProjects } from '../../harness/hierarchy-api.js';

export const harnessHierarchyRoute: Route = {
  path: ['/api/harness/hierarchy', '/api/harness/projects'], auth: 'session',
  async handle(ctx, { req, res, url, session, path }) {
    if (path === '/api/harness/projects') return req.method === 'GET'
      ? send(res, 200, { projects: harnessProjects(ctx) }, { 'cache-control': 'no-store' }) : send(res, 405, { error: 'Use GET' });
    const floor = floorParam(ctx, url);
    if (!floor) return send(res, 404, { error: 'No such floor' });
    if (req.method === 'POST' && !sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Same-origin request required' });
    const admin = !session.account || session.account.role === 'admin';
    return harnessHierarchyRequest(ctx, floor, req, res, url, { local: admin, writable: admin, globalWrite: admin,
      actor: session.account ? 'account:' + session.account.id : 'shared-password' });
  },
};

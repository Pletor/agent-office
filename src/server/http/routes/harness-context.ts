// The library's context bar (harness/tree-api.ts): the floors as projects, and one floor's specialization tree. Read by any session of the office.
import type { Route } from '../router.js';
import { send } from '../util.js';
import { floorParam } from './files.js';
import { harnessProjectsRequest, harnessTreeRequest } from '../../harness/tree-api.js';

export const harnessContextRoutes = {
  projects: {
    path: '/api/harness/projects', auth: 'session',
    handle(ctx, { req, res, session }) {
      return harnessProjectsRequest(ctx, req, res, !session.account || session.account.role === 'admin');
    },
  },
  tree: {
    path: '/api/harness/tree', auth: 'session',
    handle(ctx, { req, res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      return harnessTreeRequest(ctx, floor, req, res, url);
    },
  },
} satisfies Record<string, Route>;

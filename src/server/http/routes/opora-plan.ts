// The plan Lens of a floor's whole Opora project, for the process wall's "Lens plánu" tab:
// GET /api/opora-plan-lens?floor=<id>. Like /api/opora-lens without a card: the floor's link says which
// project and workspace, and the read (Opora's GET /api/oporahub/plan-lens) is opora/lens-reader.ts.
import type { Route } from '../router.js';
import { send } from '../util.js';
import { floorParam } from './files.js';
import { lensReader } from '../../opora/lens-reader.js';
import type { OporaPlanReply } from '../../../shared/opora-plan.js';

export const oporaPlanRoutes = {
  read: {
    method: 'GET',
    path: '/api/opora-plan-lens',
    auth: 'session',
    async handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const o = floor.opora.view();
      if (!o.project || !o.workspace) return send(res, 200, { linked: false, plan: { state: 'none' } } satisfies OporaPlanReply);
      const plan = await lensReader.plan(o.url, `office-${floor.id}`, o.project.id, o.workspace);
      return send(res, 200, { linked: true, base: o.url, project: o.project.name, plan } satisfies OporaPlanReply);
    },
  },
} satisfies Record<string, Route>;

// What's inside one page of the floor's Opora project, for the purple board's "Canvas živě":
// GET /api/opora-layers?floor=<id>&node=<nodeId>. The floor's link says which project and workspace,
// so the page never names a project it isn't on; the reads are opora/layers-reader.ts, GET only.
import type { Route } from '../router.js';
import { send } from '../util.js';
import { floorParam } from './files.js';
import { layersReader } from '../../opora/layers-reader.js';
import { LENS_ID } from '../../../shared/opora-lens.js';
import type { OporaLayersReply } from '../../../shared/opora-layers.js';

export const oporaLayersRoutes = {
  read: {
    method: 'GET',
    path: '/api/opora-layers',
    auth: 'session',
    async handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const node = url.searchParams.get('node') ?? '';
      if (!LENS_ID.test(node)) return send(res, 400, { error: 'Bad node' });
      const o = floor.opora.view();
      if (!o.project || !o.workspace) return send(res, 200, { linked: false, nodeId: node, state: 'unavailable', layers: [] } satisfies OporaLayersReply);
      const read = await layersReader.page({ base: o.url, agent: `office-${floor.id}`, project: o.project.id, workspace: o.workspace }, node);
      return send(res, 200, { linked: true, base: o.url, nodeId: node, ...read } satisfies OporaLayersReply);
    },
  },
} satisfies Record<string, Route>;

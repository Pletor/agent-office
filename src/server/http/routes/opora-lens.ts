// PR Lens diagrams of an Opora card, for the process wall's card inspector:
// GET /api/opora-lens?floor=<id>&card=<nodeId>[&area=<id>]. The floor says which Opora project and
// workspace (its link), so the page never names a project it isn't on; the reads are opora/lens-reader.ts.
import type { Route } from '../router.js';
import { send } from '../util.js';
import { floorParam } from './files.js';
import { lensReader } from '../../opora/lens-reader.js';
import { LENS_ID, type OporaLensReply } from '../../../shared/opora-lens.js';

export const oporaLensRoutes = {
  read: {
    method: 'GET',
    path: '/api/opora-lens',
    auth: 'session',
    async handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const card = url.searchParams.get('card') ?? '';
      const area = url.searchParams.get('area') ?? '';
      if (!LENS_ID.test(card) || (area && !LENS_ID.test(area))) return send(res, 400, { error: 'Bad card or area' });
      const o = floor.opora.view();
      if (!o.project || !o.workspace) {
        return send(res, 200, { linked: false, nodeId: card, card: { state: 'none' }, plan: { state: 'none' } } satisfies OporaLensReply);
      }
      const agent = `office-${floor.id}`;
      const [cardLens, plan] = await Promise.all([
        lensReader.card(o.url, agent, o.project.id, o.workspace, card),
        lensReader.plan(o.url, agent, o.project.id, o.workspace, area || undefined),
      ]);
      return send(res, 200, { linked: true, base: o.url, nodeId: card, card: cardLens, plan } satisfies OporaLensReply);
    },
  },
} satisfies Record<string, Route>;

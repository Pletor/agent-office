import { cachedBossAttention } from '../../boss-attention/cache.js';
import type { Route } from '../router.js';
import { send } from '../util.js';
import { floorParam } from './files.js';

export const bossAttentionRoutes = {
  read: {
    path: '/api/boss-attention', auth: 'session',
    async handle(ctx, { req, res, url }) {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return send(res, 405, { error: 'Podporováno je pouze čtení metodou GET' });
      }
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'Patro nebylo nalezeno' });
      const board = await cachedBossAttention(floor, () => floor.opora.view());
      if (floorParam(ctx, url) !== floor) return send(res, 404, { error: 'Patro již neexistuje' });
      return send(res, 200, board);
    },
  },
} satisfies Record<string, Route>;

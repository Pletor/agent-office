// 🗂️ Výstupy · Čistá linie's route: the PRs merged into main in the last days and their outputs
// (docs/vystupy-board.md), for anyone signed in. Read-only.
import { outputsBoard } from '../../cleanline/outputs.js';
import type { Route } from '../router.js';
import { send } from '../util.js';
import { live, targetOf } from './cleanline.js';

export const outputsRoutes = {
  read: {
    path: '/api/cleanline/outputs', auth: 'session',
    async handle(ctx, { req, res, url }) {
      if (req.method !== 'GET') return send(res, 405, { error: 'Jen GET' }, { Allow: 'GET' });
      const target = targetOf(ctx, url.searchParams.get('floor'), url.searchParams.get('repo'));
      if (!target) return send(res, 404, { error: 'Patro nebylo nalezeno' });
      return send(res, 200, await outputsBoard(target.t, { live: live(ctx) }, url.searchParams.get('refresh') === '1'));
    },
  },
} satisfies Record<string, Route>;

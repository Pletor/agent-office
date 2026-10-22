// The floor's live process journal over HTTP, for whoever can't hold a socket open (Opora, scripts):
// GET /api/process/events?floor=<id>&after=<seq>&limit=<n>, oldest first.
import type { Route } from '../router.js';
import { send } from '../util.js';
import { processHub } from '../../process/hub.js';
import { JOURNAL_SIZE, SNAPSHOT_SIZE } from '../../process/journal.js';
import { floorParam } from './files.js';

export const processRoutes = {
  events: {
    method: 'GET',
    path: '/api/process/events',
    auth: 'session',
    handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const after = Number(url.searchParams.get('after') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? SNAPSHOT_SIZE);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) return send(res, 400, { error: 'Bad after or limit' });
      return send(res, 200, processHub.snapshot(floor.id, after, Math.min(limit, JOURNAL_SIZE)));
    },
  },
} satisfies Record<string, Route>;

import type { Route } from '../router.js';
import { send, sameOrigin } from '../util.js';
import { floorParam } from './files.js';
import { HarnessLibrary, harnessSources } from '../../harness/catalog.js';
import { HarnessRegistry } from '../../harness/registry.js';
import { proposeRequest } from '../../harness/propose.js';

/** Schránky → Poslat do karty: an administrator proposes a verified kit into one card of the bound Opora plan. */
export const harnessProposeRoute: Route = {
  path: '/api/harness/propose', method: 'POST', auth: 'session',
  async handle(ctx, { req, res, url, session }) {
    const floor = floorParam(ctx, url);
    if (!floor) return send(res, 404, { error: 'No such floor' });
    if (!sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Same-origin request required' });
    if (session.account && session.account.role !== 'admin') return send(res, 403, { error: 'Výbavu do karty posílá správce nebo jeho orchestrátor.' });
    return proposeRequest(floor, new HarnessLibrary(harnessSources(floor.dir, true), new HarnessRegistry(ctx.cfg.dataDir)), req, res);
  },
};

import type { Route } from '../router.js';
import { send, sameOrigin } from '../util.js';
import { harnessProfileRequest } from '../../harness/api.js';
import { floorParam } from './files.js';
import { HarnessLibrary, harnessSources } from '../../harness/catalog.js';
import { HarnessRegistry } from '../../harness/registry.js';
import { recommendationRequest } from '../../harness/recommendation-api.js';
import { buildHarnessKit } from '../../harness/kit.js';
import { HarnessError } from '../../harness/profiles.js';
import { isItemPath, itemView } from '../../harness/items.js';

/** Machine-owned resources are visible only to admins or the machine's shared-password session. */
export const harnessRoute: Route = {
  path: ['/api/harness', '/api/harness/file', '/api/harness/kit', '/api/harness/recommend'],
  method: 'GET',
  auth: 'session',
  async handle(ctx, { req, res, url, session, path }) {
    const floor = floorParam(ctx, url);
    if (!floor) return send(res, 404, { error: 'No such floor' });
    const local = !session.account || session.account.role === 'admin';
    if (path === '/api/harness/recommend') return recommendationRequest(ctx, floor, req, res, url, local);
    const library = new HarnessLibrary(harnessSources(floor.dir, local), new HarnessRegistry(ctx.cfg.dataDir));
    if (path === '/api/harness/kit') {
      try { return send(res, 200, await buildHarnessKit(library, url.searchParams.get('problem') ?? '', url.searchParams.getAll('resource')), { 'cache-control': 'no-store' }); }
      catch (err) { return send(res, err instanceof HarnessError ? err.status : 400, { error: (err as Error).message }); }
    }
    const catalog = await library.list();
    const headers = { 'cache-control': 'no-store' };
    if (path === '/api/harness') return send(res, 200, catalog, headers);
    const entry = await library.read(url.searchParams.get('id') ?? '');
    if (!entry) return send(res, 404, { error: 'Resource is unavailable; refresh the library.' }, headers);
    return send(res, 200, isItemPath(entry.path) ? { ...entry, item: itemView(entry, catalog.entries) } : entry, headers);
  },
};

export const harnessProfileRoute: Route = {
  path: '/api/harness/profile', auth: 'session',
  async handle(ctx, { req, res, url, session }) {
    const floor = floorParam(ctx, url);
    if (!floor) return send(res, 404, { error: 'No such floor' });
    if (req.method === 'POST' && !sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Same-origin request required' });
    const admin = !session.account || session.account.role === 'admin';
    return harnessProfileRequest(ctx, floor, req, res, url, admin, admin, admin);
  },
};

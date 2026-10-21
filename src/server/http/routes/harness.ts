import type { Route } from '../router.js';
import { send, sameOrigin } from '../util.js';
import { harnessProfileRequest } from '../../harness/api.js';
import { harnessBindingRequest } from '../../harness/binding-api.js';
import { preparePlanRequest } from '../../harness/prepare-api.js';
import { floorParam } from './files.js';
import { HarnessLibrary, harnessSources } from '../../harness/catalog.js';
import { HarnessRegistry } from '../../harness/registry.js';

/** Machine-owned resources are visible only to admins or the machine's shared-password session. */
export const harnessRoute: Route = {
  path: ['/api/harness', '/api/harness/file'],
  method: 'GET',
  auth: 'session',
  async handle(ctx, { res, url, session, path }) {
    const floor = floorParam(ctx, url);
    if (!floor) return send(res, 404, { error: 'No such floor' });
    const local = !session.account || session.account.role === 'admin';
    const library = new HarnessLibrary(harnessSources(floor.dir, local), new HarnessRegistry(ctx.cfg.dataDir));
    const catalog = await library.list();
    const headers = { 'cache-control': 'no-store' };
    if (path === '/api/harness') return send(res, 200, catalog, headers);
    const entry = await library.read(url.searchParams.get('id') ?? '');
    return entry ? send(res, 200, entry, headers) : send(res, 404, { error: 'Resource is unavailable; refresh the library.' }, headers);
  },
};

export const harnessProfileRoute: Route = {
  path: '/api/harness/profile', auth: 'session',
  async handle(ctx, { req, res, url, session }) {
    const floor = floorParam(ctx, url);
    if (!floor) return send(res, 404, { error: 'No such floor' });
    if (req.method === 'POST' && !sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Same-origin request required' });
    const admin = !session.account || session.account.role === 'admin';
    return harnessProfileRequest(ctx, floor, req, res, url, admin, admin, admin, session.account ? 'account:' + session.account.id : 'shared-password');
  },
};

/** The floor's binding to an Opora project (harness/bindings.ts): read by any session of the office, bound by an administrator or the shared-password session. */
export const harnessBindingRoute: Route = {
  path: '/api/harness/binding', auth: 'session',
  async handle(ctx, { req, res, url, session }) {
    const floor = floorParam(ctx, url);
    if (!floor) return send(res, 404, { error: 'No such floor' });
    if (req.method === 'POST' && !sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Same-origin request required' });
    const admin = !session.account || session.account.role === 'admin';
    return harnessBindingRequest(ctx, floor, req, res, admin, session.account ? 'account:' + session.account.id : 'shared-password');
  },
};

/** The preparation runner's dry-run plan for one card (harness/prepare-api.ts): read-only, for any session; machine resources for an administrator or the shared-password session, as in the catalog. */
export const harnessPreparePlanRoute: Route = {
  path: '/api/harness/prepare-plan', method: 'GET', auth: 'session',
  async handle(ctx, { res, url, session }) {
    const floor = floorParam(ctx, url);
    if (!floor) return send(res, 404, { error: 'No such floor' });
    return preparePlanRequest(ctx, floor, res, url, !session.account || session.account.role === 'admin');
  },
};

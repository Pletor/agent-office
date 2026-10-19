import type { Route } from '../router.js';
import { send } from '../util.js';
import { floorParam } from './files.js';
import { HarnessLibrary, harnessSources } from '../../harness/catalog.js';

/** Machine-owned resources are visible only to admins or the machine's shared-password session. */
export const harnessRoute: Route = {
  path: ['/api/harness', '/api/harness/file'],
  method: 'GET',
  auth: 'session',
  async handle(ctx, { res, url, session, path }) {
    const floor = floorParam(ctx, url);
    if (!floor) return send(res, 404, { error: 'No such floor' });
    const local = !session.account || session.account.role === 'admin';
    const library = new HarnessLibrary(harnessSources(floor.dir, local));
    const catalog = await library.list();
    const headers = { 'cache-control': 'no-store' };
    if (path === '/api/harness') return send(res, 200, catalog, headers);
    const entry = await library.read(url.searchParams.get('id') ?? '');
    return entry ? send(res, 200, entry, headers) : send(res, 404, { error: 'Resource is unavailable; refresh the library.' }, headers);
  },
};

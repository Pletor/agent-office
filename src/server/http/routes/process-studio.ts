import path from 'node:path';
import type { Route } from '../router.js';
import { serveFile } from '../static.js';

/** A separate simulation page; it exposes no provider calls or mutation endpoint. */
export const processStudioRoute: Route = {
  path: ['/process-studio', '/process-studio.html'],
  method: 'GET',
  auth: 'session',
  handle(ctx, { res }) {
    return serveFile(res, path.join(ctx.publicDir, 'process-studio.html'), false, 'SAMEORIGIN');
  },
};

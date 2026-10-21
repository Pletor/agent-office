import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { serveFile } from '../src/server/http/static.js';
import { processStudioRoute } from '../src/server/http/routes/process-studio.js';
import type { Ctx } from '../src/server/office/context.js';

test('only the session-protected studio opts into same-origin framing', async t => {
  const publicDir = path.resolve(import.meta.dirname, '../src/client');
  const server = http.createServer((req, res) => {
    if (req.url === '/studio') processStudioRoute.handle({ publicDir } as Ctx, { res } as Parameters<typeof processStudioRoute.handle>[1]);
    else serveFile(res, path.join(publicDir, 'index.html'), false);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address() as { port: number };
  for (const [route, framing, ancestors] of [['/studio', 'SAMEORIGIN', "'self'"], ['/', 'DENY', "'none'"]]) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-frame-options'), framing);
    assert.equal(response.headers.get('content-security-policy'), `frame-ancestors ${ancestors}`);
    await response.text();
  }
  assert.equal(processStudioRoute.auth, 'session');
});

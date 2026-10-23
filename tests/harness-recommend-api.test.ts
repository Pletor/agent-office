import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Ctx } from '../src/server/office/context.js';
import { requestHandler } from '../src/server/http/router.js';
import { harnessRoute } from '../src/server/http/routes/harness.js';
import { officeHarness } from '../src/server/harness/api.js';
import { HarnessProfiles } from '../src/server/harness/profiles.js';

test('recommendation uses the authenticated floor peer and refuses stale scope/profile snapshots', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-recommend-api-'));
  mkdirSync(path.join(dir, '.harness', 'rules'), { recursive: true });
  writeFileSync(path.join(dir, '.harness', 'rules', 'quality.md'), 'Run the pinned checks.');
  const profiles = new HarnessProfiles(dir);
  let calls = 0, mutate = false;
  const native = http.createServer(async (req, res) => {
    calls++;
    const url = new URL(req.url!, 'http://local');
    assert.ok(['/api/oporahub/harness-learning', '/api/oporahub/harness-paired-evaluations', '/api/oporahub/harness-verifier/requests'].includes(url.pathname));
    assert.equal(req.headers.authorization, undefined, 'worker credentials never reach the native peer');
    assert.equal(url.searchParams.get('project'), 'p'); assert.equal(url.searchParams.get('workspace'), 'w');
    if (mutate) { mutate = false; await profiles.save(dir, '', 'repository', { language: { value: 'cs' } }, 0); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(url.pathname.endsWith('/requests') ? { requests: [] } : url.pathname.endsWith('harness-learning')
      ? { schema: 'harness.learning/1', authority: 'native-outbox-projection', scope: { project: 'p', workspace: 'w', nodeId: null }, limited: false, cohorts: [] }
      : { schema: 'harness.paired-evaluations/1', authority: 'native-result-receipts', scope: { project: 'p', workspace: 'w', nodeId: null },
        evidence: 'worker-reported', serverObserved: false, independentlyVerified: false, causalContribution: false,
        promotionAllowed: false, tokens: null, cost: null, receiptWindowLimited: false, scannedReceipts: 0,
        invalidReceipts: 0, conflictingEvaluations: 0, evaluations: [] }));
  });
  await new Promise<void>(resolve => native.listen(0, '127.0.0.1', resolve));
  const peer = 'http://127.0.0.1:' + (native.address() as { port: number }).port;
  const floor = { id: 'floor', dir, opora: { view: () => ({ connected: true, url: peer, project: { id: 'p' }, workspace: 'w' }) },
    workers: { authenticate: (id: string, token: string) => token === 'hook-test' ? { id } : undefined },
    planning: { state: () => ({ current: null }) } };
  const ctx = { cfg: { dataDir: dir, port: 0 }, floors: new Map([['floor', floor]]), workerFloor: () => floor,
    auth: { fromRequest: (req: http.IncomingMessage) => req.headers['x-test-session'] === 'member' ? { account: { role: 'member' } } : undefined } } as unknown as Ctx;
  const handler = requestHandler(ctx, [harnessRoute]);
  const server = http.createServer((req, res) => req.url?.startsWith('/office/') ? void officeHarness(ctx, req, res, new URL(req.url, 'http://x')) : void handler(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx.cfg.port = (server.address() as { port: number }).port;
  t.after(() => { for (const instance of [server, native]) { instance.close(); instance.closeAllConnections(); } rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + ctx.cfg.port;
  const api = '/api/harness/recommend?floor=floor&problem=ts.references';
  assert.equal((await fetch(base + api)).status, 401); assert.equal(calls, 0);
  let response = await fetch(base + api + '&project=foreign', { headers: { 'x-test-session': 'member' } });
  assert.equal(response.status, 200); let result = await response.json();
  assert.equal(result.history.status, 'available'); assert.equal(result.context.project, 'p'); assert.equal(result.kit.schema, 'harness.kit/1');
  assert.equal(result.pairedHistory.status, 'available');
  assert.equal(result.fixtureHistory.status, 'available');
  assert.equal(profiles.view(dir).revision, 0, 'preparation never edits assignments');
  const hook = '/office/harness?worker=ordinary&recommend=1&problem=ts.references';
  assert.equal((await fetch(base + hook)).status, 401);
  const headers = { authorization: 'Bearer hook-test' };
  const catalogResponse = await fetch(base + '/office/harness?worker=ordinary&catalog=1', { headers });
  const catalog = await catalogResponse.json();
  const quality = catalog.entries.find((entry: { title: string }) => entry.title === 'quality.md');
  assert.ok(quality);
  const read = await fetch(base + '/office/harness?worker=ordinary&read=' + quality.id, { headers });
  assert.equal(read.status, 200); assert.equal((await read.json()).text, 'Run the pinned checks.');
  assert.equal((await fetch(base + '/office/harness?worker=ordinary&read=private-machine-resource', { headers })).status, 404);
  response = await fetch(base + hook, { headers }); assert.equal(response.status, 200);
  assert.equal((await response.json()).promotionAllowed, false);
  assert.equal((await fetch(base + hook + '&task=opora:foreign:w:n', { headers })).status, 403);
  assert.equal((await fetch(base + hook, { method: 'POST', headers })).status, 405);
  const previous = calls;
  assert.equal((await fetch(base + hook + '&capability=bad%20id', { headers })).status, 400);
  assert.equal(calls, previous, 'invalid inputs cannot trigger a native lookup');
  mutate = true;
  assert.equal((await fetch(base + hook, { headers })).status, 409, 'profile change during native lookup refuses the stale proposal');
  response = await fetch(base + hook, { headers }); result = await response.json();
  assert.equal(response.status, 200); assert.ok(result.kit.resources.some((resource: { resource: string }) => resource.resource === 'profile:settings'));
});

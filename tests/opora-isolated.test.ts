import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EMPTY_OPORA } from '../src/shared/opora.js';
import { IsolatedOfficeService } from '../src/server/opora/isolated-service.js';
import { isolatedConfiguration, type IsolatedConfiguration } from '../src/server/opora/isolated-config.js';
import { digest } from '../src/server/opora/executors/validation.js';
import { configurationDigest } from '../src/server/opora/executors/managed-projection.js';
import { requestHandler } from '../src/server/http/router.js';
import { createIsolatedExecutorRoutes } from '../src/server/http/routes/isolated-executors.js';
import { IsolatedStore } from '../src/server/opora/isolated-storage.js';
import type { Ctx } from '../src/server/office/context.js';

async function fixture(t: { after(fn: () => Promise<void>): void }, version: 1 | 2 = 2, pollMs = 3600000) {
  const directory = mkdtempSync(path.join(tmpdir(), 'office-isolated-'));
  const config = { type: 'cloud', networking: { type: 'limited', allowed_hosts: ['github.com'] }, packages: { type: 'packages' } };
  const agent = { type: 'agent', archived_at: null, id: 'agent_pinned', version: 7, model: { id: 'model' }, system: 'Frozen', tools: [], skills: [], mcp_servers: [] };
  const now = Date.now() / 1000;
  const budget = { policyHead: 'b'.repeat(40), familyId: 'c'.repeat(40), allocationId: 'd'.repeat(40), attempt: 1, repairRound: 0,
    kind: 'initial', admittedAt: now, runDeadlineAt: now + 60, maxRunSeconds: 60 };
  const assignment = { contextVersion: 'e'.repeat(64), ...(version === 2 ? { contextProtocolVersion: 2 } : {}),
    documents: [{ nodeId: '_card', fields: { goal: 'Accepted immutable instructions' } }] };
  const lease = { project: 'draft', workspace: 'draft', nodeId: '_card', executionId: 'a'.repeat(32), token: 'PRIVATE_LEASE_TOKEN', epoch: 1,
    acceptedRevision: 'f'.repeat(40), assignmentDigest: digest(assignment), assignment, state: 'running', serverNow: now, expiresAt: now + 30,
    executionProtocolVersion: 2, budget, ...(version === 2 ? { contextProtocolVersion: 2, contextValidation: {
      contextProtocolVersion: 2, originAcceptedRevision: 'f'.repeat(40), checkedAcceptedRevision: 'f'.repeat(40),
      acceptedRevisionsChecked: 1, liveTransitionsChecked: 0, acceptedScopeUnchanged: true, liveScopeUnchanged: true } } : {}) };
  const session = { type: 'session', id: 'sesn_one', status: 'idle', agent, environment_id: 'env_pinned',
    resources: [{ type: 'github_repository', url: 'https://github.com/example/repo', mount_path: '/workspace/repo', checkout: { type: 'commit', sha: '1'.repeat(40) } }],
    budget: { type: 'limit', max_list_cost: { amount: '125', currency: 'USD' } }, usage: { input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      list_cost: { amount: '0', currency: 'USD' }, active_seconds: 0 } };
  const calls: { url: string; body: any }[] = [], observations: any[] = [];
  const replay = new Map<string, any>();
  let hook: ((url: string, body: any) => Promise<Response> | undefined) | undefined;
  let alive = true;
  let loseObservationAt = 0, loseResult = false;
  let reportText: string | null = null;
  const receipts = new Map<string, any>();
  const secret = 'observer_secret_'.repeat(4);
  const backend = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : null, url = request.url!;
      calls.push({ url, body });
      const intercepted = hook?.(url, body);
      if (intercepted) { const value = await intercepted; response.writeHead(value.status); response.end(await value.text()); return; }
      let result: unknown;
      if (url.includes('/environments/')) result = { type: 'environment', id: 'env_pinned', archived_at: null, config };
      else if (url.includes('/agents/')) result = agent;
      else if (url === '/provider/v1/sessions' && request.method === 'POST') result = session;
      else if (url.includes('/provider/') && url.includes('/events?')) result = { data: reportText === null ? [] : [{
        id: 'sevt_result', type: 'agent.message', processed_at: new Date().toISOString(), content: [{ type: 'text', text: reportText }] }] };
      else if (url.includes('/provider/') && url.endsWith('/events')) {
        session.status = body.events[0].type === 'user.message' ? 'running' : 'idle'; result = { data: [] };
      } else if (url.endsWith('/archive')) { session.status = 'terminated'; result = session; }
      else if (url.includes('/provider/v1/sessions/')) result = session;
      else if (url.includes('/execution-observers/')) {
        const stamp = request.headers['x-opora-observer-time'];
        const wanted = createHmac('sha256', secret).update(stamp + '\n' + createHash('sha256').update(text).digest('hex')).digest('hex');
        assert.equal(request.headers['x-opora-observer-id'], 'broker'); assert.equal(request.headers['x-opora-observer-signature'], wanted);
        assert.equal(request.headers.authorization, undefined); assert.doesNotMatch(text, /PRIVATE_LEASE|PRIVATE_API|PRIVATE_GITHUB/);
        const recordKey = (url.endsWith('/intents') ? 'intent:' : 'observation:') + body.requestId;
        if (replay.has(recordKey)) result = replay.get(recordKey);
        else {
          if (url.endsWith('/observations')) {
            assert.equal(body.sequence, observations.length + 1);
            assert.equal(body.expectedObservationHead, observations.at(-1)?.id ?? null);
          }
          result = { ...body, id: url.endsWith('/intents') ? '2'.repeat(40) : digest(body).slice(0, 40), schemaVersion: 1,
            kind: url.endsWith('/intents') ? 'execution-intent' : 'execution-observation', observerId: 'broker',
            executionBinding: 'canvas-verified', providerBinding: 'observer-attested', authorityActive: true };
          replay.set(recordKey, result); if (url.endsWith('/observations')) observations.push(result);
        }
      } else if (url.includes('/context')) result = { available: true, unavailableReason: null, acceptedHead: lease.acceptedRevision,
        contextVersion: assignment.contextVersion, executionProtocolVersion: 2, ...(version === 2 ? { contextProtocolVersion: 2 } : {}),
        budget: { enrolled: true, policyHead: budget.policyHead, policy: {}, latestExecutionId: null, blockedReason: null,
          attemptsUsed: 0, repairRoundsUsed: 0, remainingAttempts: 3, remainingRepairRounds: 1 } };
      else if (/\/(claim|heartbeat)\?assignment=omit$/.test(url)) {
        // Lean authority (Opora M2): the lease without its assignment; the office reads that once below.
        const { assignment: pinned, ...lean } = lease; result = { ...lean, contextVersion: pinned.contextVersion, serverNow: Date.now() / 1000 };
      } else if (url.startsWith(`/api/oporahub/executions/${lease.executionId}/assignment?`) && request.method === 'GET') {
        assert.equal(request.headers['x-opora-execution-token'], lease.token);
        const keys = ['executionId', 'project', 'workspace', 'nodeId', 'epoch', 'acceptedRevision', 'assignmentDigest', 'assignment', 'executionProtocolVersion', 'budget', 'contextProtocolVersion'] as const;
        result = { ...Object.fromEntries(keys.filter(key => key in lease).map(key => [key, (lease as any)[key]])), progress: { total: 0, done: 0, current: null, steps: [] } };
      }
      else if (url.includes('/results?') && request.method === 'GET') result = { results: [...receipts.values()] };
      else if (url.endsWith('/results')) {
        assert.equal(body.token, lease.token); assert.equal(body.epoch, lease.epoch);
        assert.match(String(request.headers['x-opora-actor']), /office-isolated/);
        if (receipts.has(body.requestId)) result = receipts.get(body.requestId);
        else {
          result = { receiptId: '3'.repeat(32), executionId: lease.executionId, requestId: body.requestId, result: body.result,
            state: 'reported', acceptedRevision: lease.acceptedRevision, assignmentDigest: lease.assignmentDigest,
            verification: 'agent-reported; not independently verified', executionProtocolVersion: 2, budget,
            ...(version === 2 ? { contextProtocolVersion: 2, contextValidation: lease.contextValidation } : {}) };
          receipts.set(body.requestId, result);
        }
        if (loseResult) { loseResult = false; response.destroy(); return; }
      }
      else if (url.endsWith('/release')) result = {};
      else { response.writeHead(404); response.end('{}'); return; }
      if (url.endsWith('/observations') && observations.length === loseObservationAt) { loseObservationAt = 0; response.destroy(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
  const view = { ...structuredClone(EMPTY_OPORA), connected: true, url: base, project: { id: 'draft', name: 'Synthetic' }, workspace: 'draft',
    cards: [{ id: '_card', name: 'Card', status: 'frontier' as const, group: 'dev' as const }] };
  const configuration: IsolatedConfiguration = { canvas: base, managed: { agentId: agent.id, agentVersion: 7, environmentId: 'env_pinned',
    environmentDigest: digest(config), configurationDigest: configurationDigest(agent, config), maxListCostCents: '125' },
    secrets: () => ({ apiKey: 'PRIVATE_API', githubToken: 'PRIVATE_GITHUB' }), observer: { id: 'broker', secret } };
  const transport: typeof fetch = async (url, init) => {
    const original = new URL(String(url));
    const target = original.origin === 'https://api.anthropic.com' ? base + '/provider' + original.pathname + original.search : String(url);
    const value = await fetch(target, init);
    return new Response(await value.arrayBuffer(), { status: value.status, headers: value.headers });
  };
  const floor = { id: 'floor', dir: directory, view: () => view, alive: () => alive };
  const options = { configuration, transport, repository: () => ({ url: 'https://github.com/example/repo', commitSha: '1'.repeat(40) }),
    contextVersion: version, pollMs, autoRecover: false };
  let service = new IsolatedOfficeService(floor, options);
  const httpFloor = { isolatedExecutions: service };
  const ctx = { cfg: { port: 0, trustProxy: false }, floors: new Map([['floor', httpFloor]]), services: { lookup: () => undefined },
    auth: { fromAnyCookie: () => undefined, fromRequest: () => ({ account: { role: 'admin' } }) } } as unknown as Ctx;
  const office = createServer(requestHandler(ctx, createIsolatedExecutorRoutes((_ctx, f) => f.isolatedExecutions)));
  await new Promise<void>(resolve => office.listen(0, '127.0.0.1', resolve));
  const officeBase = `http://127.0.0.1:${(office.address() as { port: number }).port}`; ctx.cfg.port = (office.address() as { port: number }).port;
  const input = { executorId: 'anthropic-managed-agents' as const, cardId: '_card', requestId: 'user-request' };
  async function call(endpoint: string, body?: unknown) {
    const response = await fetch(officeBase + '/api/opora/isolated-executors/' + endpoint + '?floor=floor',
      { method: body ? 'POST' : 'GET', headers: { Origin: officeBase, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json() as any };
  }
  t.after(async () => {
    service.shutdown();
    for (let index = 0; index < 30; index++) {
      if (!existsOwner(directory)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    office.closeAllConnections(); backend.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => office.close(() => resolve())), new Promise<void>(resolve => backend.close(() => resolve()))]);
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, floor, options, configuration, view, lease, session, calls, observations, receipts, service, input, call,
    loseObservation: (ordinal: number) => { loseObservationAt = ordinal; },
    report: (summary = 'Agent reports implemented change', fenced = false) => { reportText = JSON.stringify({ schemaVersion: 1, kind: 'oporahub-reported-result',
      intentId: '2'.repeat(40), executionId: lease.executionId, epoch: lease.epoch, acceptedRevision: lease.acceptedRevision,
      assignmentDigest: lease.assignmentDigest, result: { summary } });
      if (fenced) reportText = '```json\n' + reportText + '\n```'; },
    loseResult: () => { loseResult = true; },
    alive: (value: boolean) => { alive = value; }, hook: (value: typeof hook) => { hook = value; },
    reopen: async () => {
      service.shutdown();
      while (existsOwner(directory)) await new Promise(resolve => setTimeout(resolve, 5));
      service = new IsolatedOfficeService(floor, options); httpFloor.isolatedExecutions = service; return service;
    } };
}
function existsOwner(directory: string) {
  try { return readdirSync(path.join(directory, '.agent-office/isolated-executions/provider')).includes('owner.lock'); } catch { return false; }
}

for (const version of [1, 2] as const) test(`actual Office HTTP start/stop records signed usage with context ${version} and budget 2`, async t => {
  const f = await fixture(t, version);
  assert.equal((await f.call('capabilities')).value.available, true);
  const started = await f.call('start', f.input);
  assert.equal(started.status, 200, JSON.stringify(started.value));
  assert.equal(started.value.state, 'running');
  const providerWork = f.calls.find(call => call.body?.events?.[0]?.type === 'user.message')!;
  assert.match(providerWork.body.events[0].content[0].text, /Accepted immutable instructions/);
  assert.doesNotMatch(providerWork.body.events[0].content[0].text, /PRIVATE_LEASE|PRIVATE_API|PRIVATE_GITHUB|token|localhost/);
  assert.equal(f.observations[0].status, 'creating');
  assert.ok(f.observations.some(value => value.sessionId === 'sesn_one'));
  f.session.usage.input_tokens = 500; f.session.usage.list_cost.amount = '187'; f.session.usage.active_seconds = 342.5;
  const stopped = await f.call('stop', { intentId: started.value.intentId });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.value)); assert.equal(stopped.value.state, 'terminated');
  assert.equal(f.observations.at(-1).status, 'terminated');
  assert.equal(f.observations.at(-1).cumulative.listCostCents, '187');
  assert.equal(f.observations.at(-1).cumulative.activeSeconds, 342.5);
  assert.doesNotMatch(JSON.stringify((await f.call('runs')).value), /PRIVATE|assignment|contextVersion|observer_secret/);
});

test('request replay returns the original run and changed body or scope cannot spend another attempt', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.call('start', f.input), f.call('start', f.input)]);
  assert.equal(results[0].status, 200); assert.equal(results[1].status, 200);
  assert.equal(results[0].value.intentId, results[1].value.intentId);
  assert.equal(f.calls.filter(value => value.url.split('?')[0].endsWith('/claim')).length, 1);
  assert.equal(f.calls.filter(value => value.url === '/provider/v1/sessions').length, 1);
  assert.equal((await f.call('start', { ...f.input, cardId: 'different' })).status, 409);
  f.view.workspace = 'other';
  assert.equal((await f.call('start', f.input)).status, 409);
});

test('missing explicit configuration and untrusted connected Canvas cause zero external calls', async t => {
  const f = await fixture(t);
  assert.equal(isolatedConfiguration({ GH_TOKEN: 'not-an-authority', ANTHROPIC_API_KEY: 'not-enough' }), null);
  f.view.url = 'https://attacker.invalid';
  assert.equal((await f.call('capabilities')).value.available, false);
  assert.equal((await f.call('start', f.input)).status, 503);
  assert.equal(f.calls.length, 0);
  const empty = new IsolatedOfficeService({ ...f.floor, dir: path.join(f.directory, 'no-config') }, { configuration: null, transport: async () => { throw new Error('must not call'); } });
  assert.equal((await empty.capabilities()).available, false);
  await assert.rejects(empty.start(f.input)); empty.shutdown();
});

test('provider agent pin failure is rejected before Canvas claim', async t => {
  const f = await fixture(t);
  f.hook(url => url.includes('/agents/') ? Promise.resolve(Response.json({ type: 'agent', archived_at: null, id: 'agent_pinned', version: 8 })) : undefined);
  assert.equal((await f.call('start', f.input)).status, 503);
  assert.equal(f.calls.filter(value => value.url.split('?')[0].endsWith('/claim') || value.url === '/provider/v1/sessions').length, 0);
});

test('observer refusal before provider creation is fail closed, with durable exact claim and no automatic restart', async t => {
  const f = await fixture(t);
  f.hook(url => url.endsWith('/execution-observers/intents') ? Promise.resolve(new Response('{}', { status: 409 })) : undefined);
  assert.equal((await f.call('start', f.input)).status, 503);
  assert.equal(f.calls.filter(value => value.url === '/provider/v1/sessions').length, 0);
  const records = path.join(f.directory, '.agent-office/isolated-executions/requests');
  const record = JSON.parse(readFileSync(path.join(records, readdirSync(records)[0]), 'utf8')).record;
  assert.ok(record.claim.requestId); assert.equal(record.lease.token, 'PRIVATE_LEASE_TOKEN');
  const count = f.calls.filter(value => value.url.split('?')[0].endsWith('/claim')).length;
  await f.reopen();
  assert.equal((await f.call('start', f.input)).status, 200);
  assert.equal(f.calls.filter(value => value.url.split('?')[0].endsWith('/claim')).length, count);
  assert.equal(f.calls.filter(value => value.url === '/provider/v1/sessions').length, 0);
});

test('floor removal after provider mapping prevents the first work event and archives the original session', async t => {
  const f = await fixture(t);
  f.hook((url, body) => {
    if (url.endsWith('/observations') && body.sessionId) f.alive(false);
    return undefined;
  });
  assert.equal((await f.call('start', f.input)).status, 503);
  assert.equal(f.calls.filter(value => value.body?.events?.[0]?.type === 'user.message').length, 0);
  assert.equal(f.session.status, 'terminated');
});

test('lease expiry independently stops provider and shutdown leaves a durable immutable intent', async t => {
  const f = await fixture(t);
  f.lease.expiresAt = Date.now() / 1000 + 0.25;
  const response = await f.call('start', f.input);
  assert.equal(response.status, 200, JSON.stringify(response.value));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(f.session.status, 'terminated');
  const current = await f.call('runs'); assert.equal(current.value.items[0].state, 'terminated');
  await f.reopen();
  const before = f.calls.filter(value => value.url.split('?')[0].endsWith('/claim') || value.body?.events?.[0]?.type === 'user.message').length;
  assert.equal((await f.call('reconcile', {})).status, 200);
  assert.equal(f.calls.filter(value => value.url.split('?')[0].endsWith('/claim') || value.body?.events?.[0]?.type === 'user.message').length, before);
});

test('lost observation response retries the persisted exact CAS request without a second accounting record', async t => {
  const f = await fixture(t);
  f.loseObservation(2);
  const response = await f.call('start', f.input);
  assert.equal(response.status, 503);
  assert.equal(f.session.status, 'terminated');
  const posts = f.calls.filter(value => value.url.endsWith('/observations'));
  const counts = new Map<string, number>();
  for (const post of posts) counts.set(post.body.requestId, (counts.get(post.body.requestId) ?? 0) + 1);
  const retried = [...counts].find(([, count]) => count > 1)!;
  assert.ok(retried);
  const bodies = posts.filter(post => post.body.requestId === retried[0]).map(post => post.body);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(f.observations.filter(value => value.requestId === retried[0]).length, 1);
});

test('terminal unchanged polls are bounded and deduplicated; explicit late usage reconciliation records changes once', async t => {
  const f = await fixture(t, 2, 20);
  const started = await f.call('start', f.input); assert.equal(started.status, 200);
  await f.call('stop', { intentId: started.value.intentId });
  const count = f.observations.length;
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.observations.length, count);
  const reads = f.calls.filter(call => call.url.includes('/provider/v1/sessions/')).length;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.calls.filter(call => call.url.includes('/provider/v1/sessions/')).length, reads);
  f.session.usage.input_tokens = 10; f.session.usage.list_cost.amount = '5';
  assert.equal((await f.call('reconcile', {})).status, 200);
  assert.equal(f.observations.length, count + 1);
  assert.equal((await f.call('reconcile', {})).status, 200);
  assert.equal(f.observations.length, count + 1);
  const publicRun = (await f.call('runs')).value.items[0];
  assert.equal(publicRun.authorityActive, false); assert.equal(publicRun.providerStatus, 'terminated');
});

for (const version of [1, 2] as const) test(`remote explicit result uses private lease and exact native receipt with context ${version}`, async t => {
  const f = await fixture(t, version, 25);
  f.report('Agent reports implemented change', version === 2);
  const started = await f.call('start', f.input); assert.equal(started.status, 200);
  for (let index = 0; index < 50 && !f.receipts.size; index++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.receipts.size, 1);
  for (let index = 0; index < 30 && f.session.status !== 'terminated'; index++) await new Promise(resolve => setTimeout(resolve, 10));
  const run = (await f.call('runs')).value.items[0];
  assert.equal(run.resultStatus, 'reported'); assert.equal(run.receiptId, '3'.repeat(32));
  assert.equal(run.verification, 'agent-reported; not independently verified'); assert.equal(run.authorityActive, false);
  assert.equal(f.session.status, 'terminated');
  assert.equal(f.calls.filter(value => value.url.endsWith('/results')).length, 1);
});

test('lost native result receipt remains private and exact replay after stop does not submit a new outcome', async t => {
  const f = await fixture(t, 2, 25);
  f.report(); f.loseResult();
  assert.equal((await f.call('start', f.input)).status, 200);
  for (let index = 0; index < 50 && !f.receipts.size; index++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.receipts.size, 1);
  for (let index = 0; index < 30 && f.session.status !== 'terminated'; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await f.call('runs')).value.items[0].resultStatus, 'unconfirmed');
  assert.equal((await f.call('reconcile', {})).status, 200);
  const posts = f.calls.filter(value => value.url.endsWith('/results'));
  assert.equal(posts.length, 1, 'revoked result recovery reads the original receipt instead of writing again');
  assert.equal(f.calls.filter(call => call.url.includes('/results?')).length, 1);
  assert.equal(f.receipts.size, 1);
  assert.equal((await f.call('runs')).value.items[0].resultStatus, 'reported');
  assert.equal(f.calls.filter(value => value.url.split('?')[0].endsWith('/claim')).length, 1);
});

test('idle provider readback remains idle while authority is held, without resuming or terminating a paused session', async t => {
  const f = await fixture(t, 2, 25);
  assert.equal((await f.call('start', f.input)).status, 200);
  f.session.status = 'idle';
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.observations.at(-1).status, 'idle'); assert.equal(f.observations.at(-1).providerStatus, 'idle');
  assert.equal(f.calls.filter(call => call.body?.events?.[0]?.type === 'user.message').length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/archive')).length, 0);
  const run = (await f.call('runs')).value.items[0];
  assert.equal(run.providerStatus, 'idle'); assert.equal(run.authorityActive, true); assert.equal(run.resultStatus, 'none');
});

test('mismatched native receipt never becomes confirmed result or independent verification', async t => {
  const f = await fixture(t, 2, 25);
  f.report();
  f.hook((url, body) => {
    if (!url.endsWith('/results')) return undefined;
    return Promise.resolve(Response.json({ receiptId: '3'.repeat(32), executionId: f.lease.executionId, requestId: body.requestId,
      result: body.result, state: 'reported', acceptedRevision: '0'.repeat(40), assignmentDigest: f.lease.assignmentDigest,
      verification: 'agent-reported; not independently verified', executionProtocolVersion: 2, budget: f.lease.budget,
      contextProtocolVersion: 2, contextValidation: f.lease.contextValidation }));
  });
  assert.equal((await f.call('start', f.input)).status, 200);
  for (let index = 0; index < 50 && !f.calls.some(call => call.url.endsWith('/results')); index++) await new Promise(resolve => setTimeout(resolve, 20));
  for (let index = 0; index < 30 && f.session.status !== 'terminated'; index++) await new Promise(resolve => setTimeout(resolve, 10));
  const run = (await f.call('runs')).value.items[0];
  assert.equal(run.resultStatus, 'unconfirmed'); assert.equal(run.receiptId, null); assert.equal(run.verification, null);
  assert.equal(f.session.status, 'terminated');
});

test('floor removal after private result checkpoint prevents first POST; attempted crash marker authorizes only receipt lookup', async t => {
  const f = await fixture(t, 2, 25);
  const records = path.join(f.directory, '.agent-office/isolated-executions/requests');
  f.floor.alive = () => {
    try {
      const file = readdirSync(records)[0];
      return !JSON.parse(readFileSync(path.join(records, file), 'utf8')).record.pendingResult;
    } catch { return true; }
  };
  f.report('Fenced result still requires live authority', true);
  assert.equal((await f.call('start', f.input)).status, 200);
  for (let index = 0; index < 50 && f.session.status !== 'terminated'; index++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.session.status, 'terminated');
  assert.equal(f.calls.filter(call => call.url.endsWith('/results')).length, 0);
  const store = new IsolatedStore(records), record = store.list()[0];
  assert.ok(record.pendingResult); assert.equal(record.pendingResult.attempted, false);
  // Model crash after the fsync'd attempt marker but before any network bytes left.
  store.save({ ...record, pendingResult: { ...record.pendingResult, attempted: true } });
  await f.reopen();
  assert.equal((await f.call('reconcile', {})).status, 503);
  assert.ok(f.calls.some(call => call.url.includes('/results?')));
  assert.equal(f.calls.filter(call => call.url.endsWith('/results')).length, 0);
  assert.equal(f.receipts.size, 0);
  assert.equal((await f.call('runs')).value.items[0].resultStatus, 'unconfirmed');
});

test('a fenced report discovered after confirmed termination never creates a native receipt or replacement', async t => {
  const f = await fixture(t, 2, 25);
  const started = await f.call('start', f.input); assert.equal(started.status, 200);
  assert.equal((await f.call('stop', { intentId: started.value.intentId })).status, 200);
  assert.equal(f.session.status, 'terminated');
  f.report('Late fenced report cannot renew revoked authority', true);
  assert.equal((await f.call('reconcile', {})).status, 200);
  const replay = await f.call('start', f.input);
  assert.equal(replay.value.intentId, started.value.intentId); assert.equal(replay.value.authorityActive, false);
  assert.equal(replay.value.receiptId, null); assert.equal(f.receipts.size, 0);
  assert.equal(f.calls.filter(call => call.url.endsWith('/results')).length, 0);
  assert.equal(f.calls.filter(call => call.url === '/provider/v1/sessions').length, 1);
  assert.equal(f.calls.filter(call => call.body?.events?.[0]?.type === 'user.message').length, 1);
});

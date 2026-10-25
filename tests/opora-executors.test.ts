import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync, rmSync, openSync, ftruncateSync, closeSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { ExecutorJournal } from '../src/server/opora/executors/journal.js';
import { ManagedAgentsHttp, type ProviderFetch } from '../src/server/opora/executors/managed-http.js';
import { ManagedAgentsExecutor } from '../src/server/opora/executors/managed-agents.js';
import { ExecutorRegistry } from '../src/server/opora/executors/registry.js';
import { configurationDigest } from '../src/server/opora/executors/managed-projection.js';
import { digest, monotonic, validateIntent } from '../src/server/opora/executors/validation.js';
import { PROVIDER, type ExecutionIntent } from '../src/server/opora/executors/types.js';

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'opora-executor-test-'));
  let journal = new ExecutorJournal(directory);
  const config = { type: 'cloud', networking: { type: 'limited', allowed_hosts: ['github.com'], allow_mcp_servers: false, allow_package_managers: false }, packages: { type: 'packages' } };
  const agent = { type: 'agent', archived_at: null, id: 'agent_pinned', version: 7, model: { id: 'model' }, system: 'Pinned instructions', tools: [], mcp_servers: [], skills: [] };
  const now = Math.floor(Date.now() / 1000);
  const intent: ExecutionIntent = { intentId: 'a'.repeat(40), requestId: 'request-1', provider: PROVIDER,
    project: 'draft', workspace: 'draft', nodeId: 'card', executionId: 'exec1', epoch: 1,
    acceptedRevision: 'b'.repeat(40), assignmentDigest: 'c'.repeat(64), contextProtocolVersion: 2, contextVersion: 'opaque-context',
    executionProtocolVersion: 2, budget: { policyHead: 'd'.repeat(40), familyId: 'e'.repeat(40), allocationId: 'f'.repeat(40),
      attempt: 1, repairRound: 0, kind: 'initial', admittedAt: now, runDeadlineAt: now + 60, maxRunSeconds: 60 },
    authorityDeadlineAt: now + 60, repository: { url: 'https://github.com/example/repo', commitSha: '1'.repeat(40) },
    agentId: agent.id, agentVersion: agent.version, environmentId: 'env_pinned', environmentDigest: digest(config),
    configurationDigest: configurationDigest(agent, config), maxListCostCents: '125' };
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, list_cost: { amount: '0', currency: 'USD' }, active_seconds: 0 };
  const session = { type: 'session', id: 'sesn_pinned', agent, environment_id: intent.environmentId, status: 'idle',
    budget: { type: 'limit', max_list_cost: { amount: intent.maxListCostCents, currency: 'USD' } },
    resources: [{ type: 'github_repository', url: intent.repository.url, mount_path: '/workspace/repo', checkout: { type: 'commit', sha: intent.repository.commitSha } }], usage };
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  let intercept: ((url: string, init: RequestInit, body: any) => Promise<Response> | undefined) | undefined;
  const transport: ProviderFetch = async (url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, init, body });
    const result = intercept?.(url, init, body); if (result) return result;
    if (url.includes('/environments/')) return Response.json({ type: 'environment', id: intent.environmentId, archived_at: null, config });
    if (url.includes('/agents/')) return Response.json(agent);
    if (url.endsWith('/sessions') && init.method === 'POST') return Response.json(session);
    if (url.endsWith('/events')) { session.status = body.events[0].type === 'user.message' ? 'running' : 'idle'; return Response.json({ data: [] }); }
    if (url.endsWith('/archive')) { session.status = 'terminated'; return Response.json(session); }
    return Response.json(session);
  };
  const http = (fetcher = transport, timeout = 100) => new ManagedAgentsHttp({ agentId: intent.agentId, agentVersion: intent.agentVersion,
    environmentId: intent.environmentId, environmentDigest: intent.environmentDigest, configurationDigest: intent.configurationDigest,
    maxListCostCents: '250' }, () => ({ apiKey: 'PRIVATE_API_KEY', githubToken: 'PRIVATE_GITHUB_TOKEN' }), fetcher, timeout);
  const executor = new ManagedAgentsExecutor(http(), journal);
  return { directory, journal, intent, session, config, calls, transport, http, executor,
    intercept: (value: typeof intercept) => { intercept = value; },
    reopen: () => { journal.close(); journal = new ExecutorJournal(directory); return new ManagedAgentsExecutor(http(), journal); },
    close: async () => { await executor.revoke(intent.intentId).catch(() => {}); journal.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('provider create is pinned, durable before lease validation, and work is sent once', async () => {
  const f = fixture();
  try {
    let validated = 0;
    const result = await f.executor.start(f.intent, 'immutable assignment', async () => {
      validated++;
      assert.equal(f.journal.read(f.intent.intentId)?.sessionId, 'sesn_pinned');
      assert.equal(f.calls.filter(call => call.body?.events?.[0]?.type === 'user.message').length, 0);
      return true;
    });
    assert.equal(result.state, 'running'); assert.equal(validated, 1);
    const create = f.calls.find(call => call.url.endsWith('/sessions') && call.init.method === 'POST')!;
    assert.deepEqual(create.body.agent, { type: 'agent', id: 'agent_pinned', version: 7 });
    assert.equal(create.body.initial_events, undefined);
    assert.deepEqual(create.body.resources[0].checkout, { type: 'commit', sha: f.intent.repository.commitSha });
    assert.equal(create.body.budget.max_list_cost.amount, '125');
    assert.equal(create.init.redirect, 'error');
    assert.equal((create.init.headers as Record<string, string>)['anthropic-beta'], 'managed-agents-2026-04-01');
    await assert.rejects(f.executor.start(f.intent, 'different work', async () => true));
    const bytes = readFileSync(path.join(f.directory, f.intent.intentId + '.jsonl'), 'utf8');
    assert.doesNotMatch(bytes, /PRIVATE_API_KEY|PRIVATE_GITHUB_TOKEN|immutable assignment/);
    assert.doesNotMatch(JSON.stringify(result), /contextVersion|budget|assignmentDigest|PRIVATE/);
    const stopped = await f.executor.revoke(f.intent.intentId);
    assert.equal(stopped.state, 'terminated'); assert.equal(stopped.observation?.status, 'terminated');
  } finally { await f.close(); }
});

test('explicit registry denies unsupported guarantees, missing provider and unverified environment', async () => {
  const f = fixture(), registry = new ExecutorRegistry();
  try {
    await assert.rejects(registry.require(PROVIDER, { isolation: true }));
    registry.register(f.executor);
    await assert.rejects(registry.require(PROVIDER, { isolation: true, invoiceHardLimit: true }));
    await assert.rejects(registry.require(PROVIDER, { isolation: true, exactTerminationDeadline: true }));
    assert.equal(await registry.require(PROVIDER, { isolation: true }), f.executor);
    f.config.networking.allowed_hosts.push('unexpected.example');
    await assert.rejects(registry.require(PROVIDER, { isolation: true }));
    assert.equal(f.calls.filter(call => call.url.endsWith('/sessions')).length, 0);
  } finally { await f.close(); }
});

test('lost create response becomes durable unknown; restart and repeated starts never create replacements', async () => {
  const f = fixture();
  try {
    f.intercept((url, init) => url.endsWith('/sessions') && init.method === 'POST' ? new Promise(() => {}) : undefined);
    await assert.rejects(f.executor.start(f.intent, 'work', async () => true));
    assert.equal(f.executor.status(f.intent.intentId).state, 'creation_unknown');
    const reopened = f.reopen();
    assert.equal((await reopened.reconcile(f.intent.intentId)).state, 'creation_unknown');
    await assert.rejects(reopened.start(f.intent, 'work', async () => true));
    assert.equal(f.calls.filter(call => call.url.endsWith('/sessions')).length, 1);
  } finally { await f.close(); }
});

test('mapped restart terminates original provider session and never resends initial work', async () => {
  const f = fixture();
  try {
    await f.executor.start(f.intent, 'work', async () => true);
    const reopened = f.reopen();
    const result = await reopened.reconcile(f.intent.intentId);
    assert.equal(result.state, 'terminated');
    assert.equal(f.calls.filter(call => call.url.endsWith('/sessions')).length, 1);
    assert.equal(f.calls.filter(call => call.body?.events?.[0]?.type === 'user.message').length, 1);
  } finally { await f.close(); }
});

test('revalidation denial never sends work and archives the known session', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.executor.start(f.intent, 'work', async () => false));
    assert.equal(f.executor.status(f.intent.intentId).state, 'terminated');
    assert.equal(f.calls.filter(call => call.body?.events?.[0]?.type === 'user.message').length, 0);
  } finally { await f.close(); }
});

test('revocation bypasses a hung start transport and requires provider termination readback', async () => {
  const f = fixture(); let announce!: () => void;
  const sending = new Promise<void>(resolve => { announce = resolve; });
  try {
    f.intercept((_url, _init, body) => {
      if (body?.events?.[0]?.type === 'user.message') { announce(); return new Promise(() => {}); }
      return undefined;
    });
    const start = f.executor.start(f.intent, 'work', async () => true);
    const failed = assert.rejects(start);
    await sending;
    assert.equal((await f.executor.revoke(f.intent.intentId)).state, 'terminated');
    await failed;
  } finally { await f.close(); }
});

test('interrupt/idle is not termination and archive errors preserve pending state', async () => {
  const f = fixture();
  try {
    await f.executor.start(f.intent, 'work', async () => true);
    f.intercept(url => url.endsWith('/archive') ? Promise.resolve(new Response('PRIVATE_ERROR', { status: 400 })) : undefined);
    assert.equal((await f.executor.revoke(f.intent.intentId)).state, 'termination_pending');
    assert.notEqual(f.executor.status(f.intent.intentId).observation?.status, 'terminated');
    f.intercept(undefined);
    assert.equal((await f.executor.reconcile(f.intent.intentId)).state, 'terminated');
  } finally { await f.close(); }
});

test('changed mounted commit or effective agent blocks work and still permits revocation', async () => {
  for (const change of ['commit', 'agent', 'budget'] as const) {
    const f = fixture();
    try {
      if (change === 'commit') f.session.resources[0].checkout.sha = '2'.repeat(40);
      if (change === 'agent') f.session.agent.system = 'Changed instructions';
      if (change === 'budget') f.session.budget.max_list_cost.amount = '999';
      await assert.rejects(f.executor.start(f.intent, 'work', async () => true));
      assert.equal(f.executor.status(f.intent.intentId).state, 'terminated');
      assert.equal(f.calls.filter(call => call.body?.events?.[0]?.type === 'user.message').length, 0);
    } finally { await f.close(); }
  }
});

test('provider cumulative usage preserves integer cents and fractional runtime; decreasing values rejected', async () => {
  const f = fixture();
  try {
    await f.executor.start(f.intent, 'work', async () => true);
    Object.assign(f.session.usage, { input_tokens: 125, output_tokens: 50, active_seconds: 342.5 });
    f.session.usage.list_cost.amount = '9007199254740993';
    const result = await f.executor.observe(f.intent.intentId), observed = result.observation!;
    assert.equal(observed.listCostCents, '9007199254740993'); assert.equal(observed.activeSeconds, 342.5);
    assert.equal(observed.source, 'provider-api');
    assert.throws(() => monotonic(observed, { ...observed, inputTokens: 124 }));
    f.session.usage.input_tokens = 124;
    await assert.rejects(f.executor.observe(f.intent.intentId));
    assert.equal(f.executor.status(f.intent.intentId).observation?.inputTokens, 125);
  } finally { await f.close(); }
});

test('journal corruption and conflicting process ownership fail closed', async () => {
  const f = fixture();
  try {
    assert.throws(() => new ExecutorJournal(f.directory));
    f.journal.create(f.intent);
    assert.throws(() => f.journal.create({ ...f.intent, intentId: '2'.repeat(40) }));
    appendFileSync(path.join(f.directory, f.intent.intentId + '.jsonl'), '{torn');
    assert.throws(() => f.executor.status(f.intent.intentId));
    await assert.rejects(f.executor.start({ ...f.intent, intentId: '3'.repeat(40), executionId: 'other' }, 'work', async () => true));
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('real loopback HTTP fixture exercises headers, mounted resources, archive and usage without provider calls', async () => {
  const f = fixture();
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    assert.equal(request.headers['anthropic-beta'], 'managed-agents-2026-04-01');
    const result = await f.transport('https://api.anthropic.com' + request.url, {
      method: request.method, headers: request.headers as Record<string, string>, ...(body ? { body } : {}),
    });
    response.writeHead(result.status, { 'Content-Type': 'application/json' }); response.end(await result.text());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const transport: ProviderFetch = async (url, init) => {
      assert.equal(new URL(url).origin, 'https://api.anthropic.com');
      const value = await fetch('http://127.0.0.1:' + port + new URL(url).pathname, init);
      // Preserve the production adapter's destination check while injecting only the network transport.
      return new Response(await value.arrayBuffer(), { status: value.status, headers: value.headers });
    };
    const executor = new ManagedAgentsExecutor(f.http(transport, 1000), f.journal);
    assert.equal((await executor.start(f.intent, 'work', async () => true)).state, 'running');
    assert.equal((await executor.revoke(f.intent.intentId)).state, 'terminated');
    assert.equal(f.calls.filter(call => call.body?.events?.[0]?.type === 'user.message').length, 1);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await f.close(); }
});

test('intent rejects unbound epochs, deadlines, floating cents and unsupported budget protocol', () => {
  const f = fixture();
  try {
    assert.throws(() => validateIntent({ ...f.intent, epoch: 0 }));
    assert.throws(() => validateIntent({ ...f.intent, authorityDeadlineAt: f.intent.authorityDeadlineAt + 1 }));
    assert.throws(() => validateIntent({ ...f.intent, maxListCostCents: '1.25' }));
    assert.throws(() => validateIntent({ ...f.intent, executionProtocolVersion: 1 }));
    assert.equal(validateIntent({ ...f.intent, project: '_project', workspace: '-workspace', nodeId: '_' + 'a'.repeat(79) }).nodeId.length, 80);
    assert.throws(() => validateIntent({ ...f.intent, nodeId: '_' + 'a'.repeat(80) }));
  } finally { f.journal.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('fractional Canvas authority deadline aborts hung work without waiting for request timeout', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
  const f = fixture();
  f.intent.budget.runDeadlineAt = (Date.now() + 150) / 1000;
  f.intent.budget.admittedAt = f.intent.budget.runDeadlineAt - 60;
  f.intent.authorityDeadlineAt = f.intent.budget.runDeadlineAt;
  const executor = new ManagedAgentsExecutor(f.http(f.transport, 1000), f.journal, () => Date.now(), () => Date.now());
  try {
    assert.equal(validateIntent(f.intent).authorityDeadlineAt, f.intent.budget.runDeadlineAt);
    let sent = false;
    f.intercept((_url, _init, body) => {
      if (body?.events?.[0]?.type !== 'user.message') return undefined;
      sent = true;
      // Reach the hung request first; startup/fsync speed is not part of this deadline contract.
      queueMicrotask(() => t.mock.timers.tick(151));
      return new Promise(() => {});
    });
    const started = Date.now();
    await assert.rejects(executor.start(f.intent, 'work', async () => true));
    await executor.revoke(f.intent.intentId);
    assert.equal(sent, true, 'the provider request was actually in flight');
    assert.equal(Date.now() - started, 151, 'authority expiry aborts before the one-second HTTP timeout');
    assert.equal(executor.status(f.intent.intentId).state, 'terminated');
  } finally { await f.close(); }
});

test('mapping persistence failure never sends work and attempts archival using the volatile provider ID', async () => {
  const f = fixture();
  const advance = f.journal.advance.bind(f.journal);
  f.journal.advance = (...args) => {
    if (args[1] === 'mapped') throw new Error('Simulated full disk');
    return advance(...args);
  };
  try {
    await assert.rejects(f.executor.start(f.intent, 'work', async () => true));
    assert.equal(f.calls.filter(call => call.body?.events?.[0]?.type === 'user.message').length, 0);
    assert.equal(f.session.status, 'terminated');
    assert.equal(f.executor.status(f.intent.intentId).state, 'creation_unknown');
  } finally { await f.close(); }
});

test('provider redirects, oversized responses and raw transport errors are sanitized and unavailable', async () => {
  const f = fixture();
  try {
    for (const transport of [
      async () => new Response('', { status: 302, headers: { Location: 'https://attacker.invalid' } }),
      async () => new Response('x'.repeat(256 * 1024 + 1)),
      async () => { throw new Error('PRIVATE_API_KEY PRIVATE_GITHUB_TOKEN'); },
    ]) {
      await assert.rejects(f.http(transport).environment(), error => {
        assert.doesNotMatch(String(error), /PRIVATE|attacker/); return true;
      });
    }
  } finally { await f.close(); }
});

test('late terminal usage refreshes cumulatively without reviving execution or repeating work', async () => {
  const f = fixture();
  try {
    await f.executor.start(f.intent, 'work', async () => true);
    await f.executor.revoke(f.intent.intentId);
    f.session.usage.input_tokens = 500; f.session.usage.list_cost.amount = '187';
    const result = await f.executor.observe(f.intent.intentId);
    assert.equal(result.state, 'terminated'); assert.equal(result.observation?.inputTokens, 500);
    assert.equal(result.observation?.listCostCents, '187');
    assert.equal(f.calls.filter(call => call.url.endsWith('/sessions')).length, 1);
    assert.equal(f.calls.filter(call => call.body?.events?.[0]?.type === 'user.message').length, 1);
    f.session.usage.input_tokens = 499;
    await assert.rejects(f.executor.observe(f.intent.intentId));
    assert.equal(f.executor.status(f.intent.intentId).state, 'terminated');
    assert.equal(f.executor.status(f.intent.intentId).observation?.inputTokens, 500);
  } finally { await f.close(); }
});

test('ordinary observation append enforces the global journal bound before changing its file', async () => {
  const f = fixture();
  try {
    await f.executor.start(f.intent, 'work', async () => true);
    assert.equal(f.journal.list()[0].intent.intentId, f.intent.intentId);
    const file = path.join(f.directory, f.intent.intentId + '.jsonl'), before = statSync(file).size;
    // Sparse placeholders exercise aggregate stat accounting without allocating 64 MiB of test input.
    for (let index = 0; index < 16; index++) {
      const fd = openSync(path.join(f.directory, index.toString(16).padStart(40, '0') + '.jsonl'), 'wx');
      try { ftruncateSync(fd, 4 * 1024 * 1024); } finally { closeSync(fd); }
    }
    await assert.rejects(f.executor.observe(f.intent.intentId));
    assert.equal(statSync(file).size, before);
    assert.throws(() => f.executor.status(f.intent.intentId));
  } finally { await f.close(); }
});

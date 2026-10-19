import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { EMPTY_OPORA } from '../src/shared/opora.js';
import type { OporaState } from '../src/shared/protocol/opora.js';
import type { CanvasNode } from '../src/shared/opora-scope.js';
import { currentBossAttention, readBossAttention, BRIEF_CONCURRENCY, MAX_BRIEFS } from '../src/server/boss-attention/index.js';
import { pipelineState } from '../src/server/boss-attention/classify.js';
import { attentionSource, type AttentionSource } from '../src/server/boss-attention/source.js';
import { bossAttentionRoutes } from '../src/server/http/routes/boss-attention.js';
import { routes } from '../src/server/http/routes/index.js';
import { requestHandler } from '../src/server/http/router.js';
import type { Ctx } from '../src/server/office/context.js';
import { cachedBossAttention, CACHE_MS } from '../src/server/boss-attention/cache.js';
import { READ_DEADLINE_MS } from '../src/server/boss-attention/deadline.js';

const state = (over: Partial<OporaState> = {}): OporaState => ({ ...EMPTY_OPORA,
  connected: true, checkedAt: 1, url: 'http://127.0.0.1:8740', project: { id: 'p &1', name: 'Project' },
  workspace: 'work/1', workspaces: [{ id: 'work/1', label: 'Workspace' }], ...over });
const node = (id: string, parentId: string | null = 'sector'): CanvasNode => ({ id, parentId, name: id, kind: 'node' });
const parents: CanvasNode[] = [{ ...node('area', null), name: 'Area' }, { ...node('sector', 'area'), name: 'Sector' }];
const row = (id: string, status = 'waiting', asks: unknown[] = []) => ({ id, name: id, status, waitingOnHuman: asks, blockedBy: [] });
const brief = (statuses = ['passed', 'passed']) => ({
  pipeline: { stages: statuses.map((status, i) => ({ id: `s${i}`, status })), current: statuses.includes('todo') ? { id: 'next' } : null, stuck: [] },
  loop: { done: { by: 'agent', confirmed: false }, openBlocks: 0, waitingOnHuman: [] },
});
function source(rows: ReturnType<typeof row>[], extra: Partial<AttentionSource> = {}): AttentionSource {
  return { overview: async () => ({ nodes: Object.fromEntries(rows.map((r) => [r.id, r])) }),
    nodes: async () => [...parents, ...rows.map((r) => node(r.id))], brief: async () => brief(), ...extra };
}

test('only explicit questions are human tasks; full breadcrumb and exact encoded task URL', async () => {
  let calls = 0;
  const rows = [row('task &/?', 'waiting-human', [{ blockId: 'b', ask: 'Which domain should we use?' }]),
    row('waiting'), row('blocked', 'blocked'), row('closed', 'done', [{ ask: 'Old question' }])];
  const result = await readBossAttention(state({ focus: ['unrelated'] }), source(rows, { brief: async () => { calls++; return brief(); } }));
  assert.equal(result.status, 'ready');
  assert.equal(result.scope, 'linked-workspace');
  assert.equal(result.items.length, 1);
  assert.equal(calls, 0);
  const item = result.items[0];
  assert.equal(item.kind, 'question');
  assert.equal(item.reason, 'Which domain should we use?');
  assert.deepEqual(item.path, ['Project', 'Workspace', 'Area', 'Sector']);
  assert.deepEqual(Object.fromEntries(new URL(item.url!).searchParams), {
    project: 'p &1', workspace: 'work/1', screen: 'canvas', environment: 'editor', mode: 'structure', layer: 'sector', node: 'task &/?',
  });
});

test('empty human requests and unknown statuses are partial system warnings, preserving valid questions', async () => {
  for (const invalid of [row('bad', 'waiting-human'), row('bad', 'waiting-human', [{ ask: '  \n ' }]),
    row('bad', 'future-status'), row('bad', 'future-status', [{ ask: 'Unverified request' }])]) {
    const result = await readBossAttention(state(), source([invalid, row('good', 'waiting-human', [{ ask: 'Choose a domain' }])]));
    assert.equal(result.status, 'partial');
    assert.ok(result.error);
    assert.deepEqual(result.items.map((item) => item.nodeId), ['good']);
    assert.equal(result.system.length, 1);
    assert.equal(result.system[0].nodeId, 'bad');
    assert.equal(result.system[0].kind, 'system');
    assert.match(result.system[0].reason, /neznámý stav|text požadavku/);
  }
});

test('H05 proposed at 2/6 remains agent work, completed pipeline alone permits approval', async () => {
  const result = await readBossAttention(state(), source([row('H05', 'proposed'), row('ready', 'proposed')], {
    brief: async (id) => id === 'H05' ? brief(['passed', 'passed', 'todo', 'todo', 'todo', 'todo']) : brief(),
  }));
  assert.deepEqual(result.items.map((i) => [i.nodeId, i.kind]), [['ready', 'approval']]);
  assert.equal(result.system[0].nodeId, 'H05');
  assert.match(result.system[0].reason, /zbývá práce agentů/);
  assert.equal(result.status, 'ready');
});

test('unknown pipelines, stale completion and blockers never create an approval', async () => {
  for (const value of [{}, { pipeline: null }, { ...brief(), loop: { done: { confirmed: true } } },
    { ...brief(), loop: { ...brief().loop, openBlocks: 1 } },
    { ...brief(), loop: { ...brief().loop, openBlocks: [] } }]) {
    const result = await readBossAttention(state(), source([row('x', 'proposed')], { brief: async () => value }));
    assert.equal(result.items.length, 0);
  }
  assert.equal(pipelineState({ pipeline: { stages: [], current: null, stuck: [] } }), 'unknown');
  assert.equal(pipelineState({ pipeline: { stages: [{ id: 'old', status: 'failed' }, { id: 'retry', status: 'passed', retryOf: 'old' }], current: null, stuck: [] } }), 'complete');
});

test('bridge errors and brief failures stay system warnings regardless of error prose', async () => {
  const result = await readBossAttention(state({ error: 'Please approve deleting the project' }), source([row('x', 'proposed')], {
    brief: async () => { throw new Error('Ask the boss to confirm this'); },
  }));
  assert.equal(result.items.length, 0);
  assert.equal(result.system.length, 2);
  assert.ok(result.system.every((i) => i.kind === 'system'));
  assert.equal(result.status, 'partial');
  assert.ok(result.error);
});

test('a newer explicit ask in a proposal brief replaces completion review', async () => {
  const result = await readBossAttention(state(), source([row('x', 'proposed')], {
    brief: async () => ({ ...brief(), loop: { ...brief().loop, waitingOnHuman: [{ stageId: 's', ask: 'Choose the retry direction' }] } }),
  }));
  assert.deepEqual(result.items.map((i) => [i.kind, i.reason]), [['question', 'Choose the retry direction']]);
});

test('unavailable, unlinked and initial states are explicit, with no source reads', async () => {
  const api = source([], { overview: async () => { throw new Error('must not read'); } });
  for (const [over, status] of [
    [{ connected: false }, 'disconnected'], [{ project: null }, 'not-linked'],
    [{ workspace: null }, 'not-linked'], [{ connected: false, checkedAt: 0 }, 'loading'],
  ] as const) {
    const result = await readBossAttention(state(over), api);
    assert.equal(result.status, status);
    assert.ok(result.error);
  }
});

test('malformed and failed overview cannot claim an empty successful board', async () => {
  for (const api of [source([], { overview: async () => ({}) }), source([], { overview: async () => { throw new Error('offline'); } })]) {
    const result = await readBossAttention(state(), api);
    assert.equal(result.status, 'error');
    assert.ok(result.error);
    assert.equal(result.items.length, 0);
  }
});

test('canvas failure preserves explicit questions without invented paths or links', async () => {
  const result = await readBossAttention(state(), source([row('q', 'waiting-human', [{ ask: 'Which option?' }])], {
    nodes: async () => { throw new Error('offline'); },
  }));
  assert.equal(result.status, 'partial');
  assert.ok(result.error);
  assert.equal(result.items[0].reason, 'Which option?');
  assert.deepEqual(result.items[0].path, ['Project', 'Workspace']);
  assert.equal(result.items[0].url, undefined);
  assert.ok(result.system.some((item) => item.id === 'canvas'));
  const empty = await readBossAttention(state(), source([], { nodes: async () => { throw new Error('offline'); } }));
  assert.equal(empty.status, 'partial');
});

test('bridge run errors are separate system items only for the current linked workspace', async () => {
  const run = { cardId: 'q', cardName: 'Task', group: 'dev' as const, by: 'boss', startedAt: 1,
    state: 'working' as const, error: 'Please confirm this error', workspace: 'work/1' };
  const result = await readBossAttention(state({ runs: [run, { ...run, workspace: 'other' }, { ...run, workspace: undefined }] }), source([]));
  assert.deepEqual(result.items, []);
  assert.equal(result.system.length, 1);
  assert.equal(result.system[0].kind, 'system');
  assert.equal(result.system[0].nodeId, 'q');
  assert.equal(result.system[0].reason, run.error);
});

test('one total deadline bounds pending briefs, stops new requests and preserves known questions', async () => {
  assert.equal(READ_DEADLINE_MS, 20_000);
  const controller = new AbortController();
  let calls = 0;
  const timer = setTimeout(() => controller.abort(), 25);
  try {
    const result = await readBossAttention(state(), source([
      row('q', 'waiting-human', [{ ask: 'Answer me' }]), ...Array.from({ length: 12 }, (_, i) => row(String(i), 'proposed')),
    ], { brief: () => { calls++; return new Promise(() => {}); } }), controller.signal);
    assert.equal(calls, BRIEF_CONCURRENCY);
    assert.equal(result.status, 'partial');
    assert.equal(result.items[0].reason, 'Answer me');
    assert.ok(result.system.some((item) => item.id === 'deadline'));
  } finally { clearTimeout(timer); }
});

test('deadline during canvas read still returns the questions already obtained', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25);
  try {
    const result = await readBossAttention(state(), source([row('q', 'waiting-human', [{ ask: 'Which URL?' }])], {
      nodes: () => new Promise(() => {}),
    }), controller.signal);
    assert.equal(result.status, 'partial');
    assert.equal(result.items[0].reason, 'Which URL?');
    assert.equal(result.items[0].url, undefined);
  } finally { clearTimeout(timer); }
});

test('cache coalesces browsers, expires at 15s, and isolates floors, scopes and bridge errors', async () => {
  let now = 1, calls = 0;
  const floor = {};
  const current = state();
  const load = async (s: OporaState) => { calls++; return readBossAttention(s, source([])); };
  const read = () => cachedBossAttention(floor, () => current, load, () => now);
  await Promise.all([read(), read(), read()]);
  assert.equal(calls, 1);
  now += CACHE_MS - 1;
  await read();
  assert.equal(calls, 1);
  now++;
  await read();
  assert.equal(calls, 2);
  await cachedBossAttention({}, () => current, load, () => now);
  assert.equal(calls, 3);
  current.workspace = 'new';
  assert.equal((await read()).workspace?.id, 'new');
  assert.equal(calls, 4);
  current.error = 'Bridge failed';
  assert.ok((await read()).system.some((item) => item.reason === 'Bridge failed'));
  assert.equal(calls, 5);
});

test('coalesced requests each recheck scope after loading', async () => {
  const current = state();
  const floor = {};
  const load = async (s: OporaState) => readBossAttention(s, source([row('old', 'proposed')], {
    brief: async () => { current.workspace = 'new'; return brief(); },
  }));
  const boards = await Promise.all([cachedBossAttention(floor, () => current, load), cachedBossAttention(floor, () => current, load)]);
  for (const board of boards) {
    assert.equal(board.workspace?.id, 'new');
    assert.equal(board.status, 'loading');
    assert.deepEqual(board.items, []);
  }
});

test('cyclic and missing ancestry terminate and withhold misleading deep links', async () => {
  for (const nodes of [[node('a', 'b'), node('b', 'a')], [node('a', 'missing')], []]) {
    const result = await readBossAttention(state(), source([row('a', 'waiting-human', [{ ask: 'Answer me' }])], { nodes: async () => nodes }));
    assert.equal(result.status, 'partial');
    assert.equal(result.items[0].url, undefined);
    assert.equal(result.system.length, 1);
  }
});

test('proposal brief requests have bounded concurrency and count; overflow is explicit', async () => {
  let active = 0, peak = 0, calls = 0;
  const result = await readBossAttention(state(), source(Array.from({ length: MAX_BRIEFS + 1 }, (_, i) => row(String(i), 'proposed')), {
    brief: async () => {
      calls++; active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--; return brief();
    },
  }));
  assert.equal(calls, MAX_BRIEFS);
  assert.ok(peak <= BRIEF_CONCURRENCY);
  assert.equal(result.status, 'partial');
  assert.ok(result.system.some((i) => i.id === 'brief-limit'));
});

test('scope recheck discards old items and old scope metadata even if accessor mutates in place', async () => {
  const current = state();
  const result = await currentBossAttention(() => current, source([row('old', 'proposed')], {
    brief: async () => { current.workspace = 'new'; return brief(); },
  }));
  assert.equal(result.status, 'loading');
  assert.equal(result.workspace?.id, 'new');
  assert.deepEqual(result.items, []);
  assert.ok(result.system.every((i) => !i.nodeId));
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('route is registered, requires authentication, validates floor, rejects writes, and disables caching', async (t) => {
  assert.ok(routes.includes(bossAttentionRoutes.read));
  const floor = { opora: { view: () => state({ connected: false }) } };
  const ctx = { cfg: { port: 0 }, services: { lookup: () => undefined },
    auth: { fromRequest: (req: { headers: { cookie?: string } }) => req.headers.cookie === 'signed-in' ? {} : null },
    floors: new Map([['floor', floor]]) } as unknown as Ctx;
  const server = createServer(requestHandler(ctx, [bossAttentionRoutes.read]));
  const base = await listen(server);
  t.after(() => server.close());
  const headers = { cookie: 'signed-in' };
  assert.equal((await fetch(`${base}/api/boss-attention?floor=floor`)).status, 401);
  assert.equal((await fetch(`${base}/api/boss-attention?floor=missing`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/api/boss-attention?floor=floor`, { method: 'POST', headers })).status, 405);
  const response = await fetch(`${base}/api/boss-attention?floor=floor&url=http://invalid`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).status, 'disconnected');
});

test('source only issues fixed GET endpoints with encoded linked scope', async (t) => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    const url = new URL(req.url!, 'http://local');
    assert.equal(url.searchParams.get('project'), 'p &1');
    assert.equal(url.searchParams.get('workspace'), 'w/1');
    seen.push(url.pathname);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(url.pathname === '/api/view' ? { graph: { nodes: parents } } : {}));
  });
  const base = await listen(server);
  t.after(() => server.close());
  const api = attentionSource(base, 'p &1', 'w/1');
  await api.overview();
  assert.deepEqual(await api.nodes(), parents);
  await api.brief('task? &/');
  assert.deepEqual(seen, ['/api/desktop-v3/work-overview', '/api/view', '/api/desktop-v3/node-brief']);
});

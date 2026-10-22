import test from 'node:test';
import assert from 'node:assert/strict';
import { cardLens, LensReader, planLens } from '../src/server/opora/lens-reader.ts';
import { lensGraph, oporaLensUrl } from '../src/shared/opora-lens.ts';

const spec = {
  schemaVersion: 1, kind: 'graph', title: 'Lens v okně\u0000procesu', summary: 'Karta ukáže diagram.',
  lanes: [{ id: 'server', label: 'Server' }, { id: 'client', label: 'Klient', delta: 'added' }],
  nodes: [
    { id: 'reader', label: 'LensReader', kind: 'service', delta: 'added', lane: 'server', files: [{ path: 'src/server/opora/lens-reader.ts', startLine: 1, endLine: 90 }], badges: ['cache 30 s'] },
    { id: 'ui', label: '<img src=x onerror=alert(1)>', kind: 'ui', delta: 'modified', lane: 'client', files: [] },
    { id: 'ghost', label: 'No lane', kind: 'other', delta: 'removed', lane: 'nowhere' },
  ],
  edges: [{ id: 'e', from: 'ui', to: 'reader', kind: 'http', delta: 'added', emphasis: 'hero', label: 'GET /api/opora-lens' }],
  flows: [{ id: 'f', title: 'Načtení', participants: [], steps: [{ from: 'ui', to: 'reader', label: 'card' }] }],
};

test('lensGraph keeps only what the window shows, as plain capped strings', () => {
  const g = lensGraph(spec)!;
  assert.equal(g.title, 'Lens v okně procesu');
  assert.deepEqual(g.lanes.map((l) => [l.id, l.nodes.map((n) => n.id)]), [['server', ['reader']], ['client', ['ui']]]);
  assert.deepEqual(g.lanes[0].nodes[0].files, [{ path: 'src/server/opora/lens-reader.ts', lines: '1–90' }]);
  assert.equal(g.lanes[1].nodes[0].label, '<img src=x onerror=alert(1)>', 'kept as data; the page renders it as text');
  assert.deepEqual(g.edges[0], { from: '<img src=x onerror=alert(1)>', to: 'LensReader', kind: 'http', delta: 'added', label: 'GET /api/opora-lens', hero: true });
  assert.deepEqual(g.flows, [{ title: 'Načtení', steps: ['<img src=x onerror=alert(1)> → LensReader: card'] }]);
  assert.equal(lensGraph({ kind: 'area-map' }), null);
  assert.equal(lensGraph('x'), null);
  const big = lensGraph({ kind: 'graph', title: 't', lanes: [{ id: 'a', label: 'A' }], nodes: Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, label: 'x'.repeat(500), lane: 'a' })) })!;
  assert.equal(big.lanes[0].nodes.length, 16);
  assert.ok(big.truncated);
  assert.ok(big.lanes[0].nodes[0].label.length <= 120);
});

test('the card and plan answers: records, none, 404, 428 and timeouts', () => {
  const ok = cardLens({ status: 200, data: { nodeId: 'c1', executionId: 'x', repository: 'o/r', number: 7, prState: 'open', current: false, by: 'agent', createdAt: '2026-10-23T10:00:00Z',
    lens: { kind: 'pr', prNumber: 7, headSha: 'a'.repeat(40), validatedAt: '2026-10-23T10:00:00Z', spec, token: 'secret-lease' },
    area: { executionId: 'x', acceptedRevision: 3, by: 'agent', createdAt: 'now', lens: { kind: 'area', headSha: null, validatedAt: 'now', spec } } } });
  assert.equal(ok.state, 'ok');
  assert.equal(ok.pr?.number, 7);
  assert.equal(ok.pr?.current, false);
  assert.equal(ok.area?.acceptedRevision, 3);
  assert.ok(ok.pr?.graph && ok.area?.graph);
  assert.doesNotMatch(JSON.stringify(ok), /secret-lease/);
  const large = cardLens({ status: 200, data: { lens: { kind: 'pr', prNumber: 1, headSha: 'b'.repeat(40), specBytes: 90000, specSha256: 'c'.repeat(64) }, area: null } });
  assert.equal(large.pr?.graph, null);
  assert.match(large.pr?.note ?? '', /64 KiB/);
  assert.deepEqual(cardLens({ status: 200, data: { nodeId: 'c1', lens: null, area: null } }), { state: 'none' });
  assert.deepEqual(cardLens({ status: 404 }), { state: 'missing' });
  assert.deepEqual(cardLens({ status: 428 }), { state: 'unavailable' });
  assert.deepEqual(cardLens({ status: 0 }), { state: 'unavailable' });
  assert.deepEqual(planLens({ status: 404 }), { state: 'missing' });
  const plan = planLens({ status: 200, data: { kind: 'plan', area: 's1', digest: 'd'.repeat(64), spec, stats: { cards: 4, bad: 'x', __proto__x: 1 }, graphify: { big: true } } });
  assert.equal(plan.state, 'ok');
  assert.deepEqual(plan.stats, { cards: 4 });
  assert.ok(plan.view?.graph);
});

test('LensReader asks Opora once per 30 s, read-only, and tolerates failures', async () => {
  let now = 1000;
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('plan-lens')) return new Response('{"detail":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify({ nodeId: 'c1', lens: null, area: null }), { status: 200 });
  }) as unknown as typeof fetch;
  const reader = new LensReader(fake, () => now);
  assert.deepEqual(await reader.card('http://127.0.0.1:8740', 'office-f1', 'p', 'w', 'c1'), { state: 'none' });
  assert.deepEqual(await reader.plan('http://127.0.0.1:8740', 'office-f1', 'p', 'w', 's1'), { state: 'missing' });
  await reader.card('http://127.0.0.1:8740', 'office-f1', 'p', 'w', 'c1');
  assert.equal(calls.length, 2, 'cached');
  now += 30_001;
  await reader.card('http://127.0.0.1:8740', 'office-f1', 'p', 'w', 'c1');
  assert.equal(calls.length, 3, 'expired');
  const first = new URL(calls[0].url);
  assert.equal(first.pathname, '/api/oporahub/review-lens');
  assert.deepEqual(Object.fromEntries(first.searchParams), { project: 'p', workspace: 'w', nodeId: 'c1' });
  assert.equal(new URL(calls[1].url).searchParams.get('area'), 's1');
  for (const c of calls) {
    assert.equal(c.init.method, 'GET');
    assert.equal((c.init.headers as Record<string, string>)['X-Opora-Actor'], 'agent; name=office-f1');
    assert.equal(c.init.body, undefined);
  }
  const down = new LensReader((async () => { throw new Error('timeout'); }) as unknown as typeof fetch);
  assert.deepEqual(await down.card('http://127.0.0.1:1', 'a', 'p', 'w', 'c'), { state: 'unavailable' });
});

test('the Opora link opens the card on its Lens tab', () => {
  assert.equal(oporaLensUrl('http://127.0.0.1:8740', 'card-1'), 'http://127.0.0.1:8740/?ohCard=card-1&ohTab=lens');
  assert.equal(oporaLensUrl('javascript:alert(1)', 'c'), undefined);
  assert.equal(oporaLensUrl(undefined, 'c'), undefined);
});

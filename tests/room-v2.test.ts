// The planning room v2 ("Místnost – rozložení"): the switchboard's cascade keeps a page's own canvas out,
// the deepest page switched on is the orchestrator's card, the purple board reads the layers inside it
// (area → sector → node) and the page's settings from Opora with GETs only, and the orchestrator's
// overview says where the card is and what the page is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildScope, toggleFocus, type CanvasNode } from '../src/shared/opora-scope.js';
import { layerCounts, layerTree, pageSettings, parseLayers, projectSettings } from '../src/shared/opora-layers.js';
import { LayersReader } from '../src/server/opora/layers-reader.js';
import { OrchestratorFocusKeeper } from '../src/server/orchestrator/focus.js';
import { orchestratorBrief } from '../src/server/orchestrator/brief.js';
import { cardPath } from '../src/server/orchestrator/page-brief.js';
import { planView } from '../src/client/features/oporalive/model.js';
import type { OporaState, OrchestratorState } from '../src/shared/protocol.js';

// Tajemství opory's Oracle › Na míru with its own canvas inside, as Opora's /api/view has it (cut down).
const VIEW = { graph: { nodes: [
  { id: 'app', kind: 'sector', name: 'Aplikace', parentId: null, site: { environments: [{ host: 'app.tajemstviopory.cz', name: 'Produkce' }], kind: 'application' } },
  { id: 'oracle', kind: 'node', name: 'Oracle', parentId: 'app', purpose: 'Věštírna', site: { kind: 'page', path: '/oracle' }, sourceRef: { kind: 'file', path: 'frontend/app/src/pages/oracle/OraclePage.tsx' } },
  { id: 'namiru', kind: 'node', name: 'Na míru', parentId: 'oracle', purpose: 'Věštba na míru za kredity', site: { kind: 'page', path: '/oracle/paid' }, x: 0, y: 0 },
  { id: 'kruh-a', kind: 'area', name: 'Kruh průběhu (věštba na míru)', parentId: 'namiru', purpose: 'Čekání nikdy nezamrzne', x: 0, y: 0, size: { w: 1200, h: 800 } },
  { id: 'kruh-s', kind: 'sector', name: 'Kruh průběhu', parentId: 'namiru', x: 40, y: 60 },
  { id: 't1', kind: 'node', name: '[task] Model průběhu', parentId: 'kruh-s', card: { status: 'ready', layer: 'frontend', model: 'sonnet', effort: 'high' }, checks: [{ id: 'a' }] },
  { id: 't2', kind: 'node', name: '[gate] Ověření kruhu', parentId: 'kruh-s', card: { status: 'draft' } },
  { id: 'loose', kind: 'node', name: 'Backend-funkce', parentId: 'namiru', x: 3000, y: 3000 },
  { id: 'note', kind: 'comment', name: 'Jak číst', parentId: 'namiru' },
] } };
const nodes: CanvasNode[] = VIEW.graph.nodes.map((n) => ({ id: n.id, kind: n.kind, name: n.name, parentId: n.parentId ?? null, ...(n.site?.kind === 'page' ? { page: true } : {}),
  ...(n.site?.environments ? { env: n.site.environments[0].name, host: n.site.environments[0].host } : {}) }));

test('the switchboard cascades only pages: a page’s own canvas (areas, sectors, tasks) stays out of it', () => {
  const scope = buildScope(nodes);
  assert.deepEqual(scope.map((n) => `${n.level}:${n.id}`), ['env:env:Produkce', 'domain:app', 'page:oracle', 'subpage:namiru']);
  // A canvas that doesn't mark its pages keeps cascading every card, as before.
  const unmarked = buildScope(nodes.map(({ page: _p, ...n }) => n));
  assert.ok(unmarked.some((n) => n.id === 'loose'));
  assert.ok(!unmarked.some((n) => n.id === 'kruh-s'), 'a sector drawn inside a card is never a domain');
});

test('the layers inside a page: area → sector → node, by where each is drawn, with the page’s settings', () => {
  const { node, layers } = parseLayers(VIEW, 'namiru');
  assert.equal(node?.name, 'Na míru');
  assert.deepEqual(layerCounts(layers), { area: 1, sector: 1, node: 3 });
  assert.equal(layers.find((l) => l.id === 't1')?.card?.layer, 'frontend');
  assert.equal(layers.find((l) => l.id === 't1')?.checks, 1);
  const tree = layerTree(layers, 'namiru');
  assert.equal(tree[0].area?.name, 'Kruh průběhu (věštba na míru)');
  assert.deepEqual(tree[0].sectors[0].nodes.map((n) => n.id), ['t1', 't2']);
  assert.equal(tree[1].area, undefined, 'a node drawn outside every area is outside them');
  assert.deepEqual(tree[1].sectors[0].nodes.map((n) => n.id), ['loose']);
  // A subpage is a page of its own, not a layer of its parent.
  assert.ok(!parseLayers(VIEW, 'oracle').layers.some((l) => l.id === 'namiru'));
  const s = pageSettings(node, { fields: { goal: 'Kredity za věštbu', non_goals: '', acceptance: 'Tlačítko spustí věštbu' }, plan: { working: [{ title: 'Formulář' }, { title: 'Kredity' }], accepted: null } });
  assert.deepEqual(s, { purpose: 'Věštba na míru za kredity', route: '/oracle/paid', goal: 'Kredity za věštbu', acceptance: 'Tlačítko spustí věštbu', working: ['Formulář', 'Kredity'], accepted: null });
  assert.deepEqual(projectSettings({ settings: { platform: 'app', architecture: 'modular', 'bad key': 'x', nested: { a: 1 } } }), { platform: 'app', architecture: 'modular' });
});

test('the layers reader only GETs, as the office, and caches', async () => {
  const calls: { url: string; method?: string; actor?: string }[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => {
    calls.push({ url: url.pathname, method: init.method, actor: (init.headers as Record<string, string>)['X-Opora-Actor'] });
    const body = url.pathname === '/api/view' ? VIEW : url.pathname === '/api/node-spec' ? { fields: { goal: 'G' }, plan: { working: [], accepted: [{ title: 'A' }] } } : { settings: { platform: 'app' } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const r = new LayersReader(fetcher);
  const t = { base: 'http://opora.test', agent: 'office-f1', project: 'p', workspace: 'w' };
  const page = await r.page(t, 'namiru');
  assert.equal(page.state, 'ok');
  assert.equal(page.settings?.goal, 'G');
  assert.deepEqual(page.settings?.accepted, ['A']);
  assert.deepEqual(page.project, { platform: 'app' });
  await r.page(t, 'namiru');
  assert.equal(calls.length, 3, 'the second read comes from the cache');
  assert.ok(calls.every((c) => c.method === 'GET' && c.actor === 'agent; name=office-f1'));
  assert.equal((await r.page(t, 'gone')).state, 'missing');
});

function opora(focus: string[]): OporaState {
  const scope = buildScope(nodes);
  return { url: 'http://127.0.0.1:8740', connected: true, project: { id: 'p1', name: 'Tajemstvi-opory' }, projects: [], workspace: 'main', workspaces: [], sectors: [], cards: [{ id: 't1', name: '[task] Model průběhu', status: 'frontier', group: 'dev' }],
    scope, focus, activity: [], runs: [], autopilot: false, handOut: false, handOutWaiting: [], maxRuns: 1, checkedAt: 0, canStart: false, starting: false, embeddable: false };
}

test('switching a page on at the switchboard makes it the orchestrator’s card; a domain lets go', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-room-v2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let state = opora([]);
  const updates: OrchestratorState[] = [];
  const k = new OrchestratorFocusKeeper({
    opora: () => state, agent: 'office-f1', dataDir: dir, update: (s) => void updates.push(s),
    lens: { card: async () => ({ state: 'none' as const }), plan: async () => ({ state: 'none' as const }) },
    preview: { card: async () => ({ state: 'missing' as const, mode: 'brand' as const, sketch: false, heads: [] }) },
    layers: { page: async (_t, id) => ({ state: 'ok' as const, name: id, settings: pageSettings(parseLayers(VIEW, id).node, undefined), layers: parseLayers(VIEW, id).layers }) },
  });
  t.after(() => k.shutdown());
  state = opora(toggleFocus(state.scope, [], 'namiru', true));
  assert.equal(k.follow('Helmar'), undefined);
  assert.equal(k.state().focus?.cardId, 'namiru', 'a subpage is a card even before the frontier lists it');
  assert.equal(k.state().focus?.name, 'Na míru');
  await k.refresh();
  const b = k.brief()!;
  assert.match(b, /Where \(cell focus at the switchboard\): Produkce › Aplikace \(app\.tajemstviopory\.cz\) › Oracle › Na míru/);
  assert.match(b, /Page settings: purpose: Věštba na míru za kredity · route \/oracle\/paid/);
  assert.match(b, /1 areas, 1 sectors, 3 nodes/);
  assert.match(b, /sector "Kruh průběhu" \(2 nodes/);
  // Switching to the domain only: no page, so the orchestrator lets go.
  state = opora(toggleFocus(state.scope, state.focus, 'oracle', false));
  assert.equal(k.follow('Helmar'), undefined);
  assert.equal(k.state().focus, null);
  assert.equal(cardPath(state.scope, 'oracle'), 'Produkce › Aplikace (app.tajemstviopory.cz) › Oracle');
});

test('the overview without a page read says so, and stays a capped block', () => {
  const b = orchestratorBrief({ focus: { cardId: 'namiru', name: 'Na míru', by: 'H', at: 0 }, path: 'Produkce › Aplikace › Oracle › Na míru' });
  assert.match(b, /Page on Opora: not read yet/);
});

test('the purple board’s plan: the card’s layers with each node’s state and who is on it', () => {
  const o = opora(['namiru']);
  o.runs = [{ cardId: 't2', cardName: 'gate', group: 'dev', workerId: 'w1', workerName: 'Ema', by: 'H', startedAt: 0, state: 'working' }];
  const orch: OrchestratorState = { focus: { cardId: 'namiru', name: 'Na míru', by: 'H', at: 1 }, brief: null };
  const { layers } = parseLayers(VIEW, 'namiru');
  assert.equal(planView(o, orch).read, 'reading');
  const v = planView(o, orch, { linked: true, nodeId: 'namiru', state: 'ok', layers });
  assert.deepEqual(v.path.map((n) => n.name), ['Produkce', 'Aplikace', 'Oracle', 'Na míru']);
  const sec = v.areas[0].sectors[0];
  assert.equal(sec.name, 'Kruh průběhu');
  assert.deepEqual(sec.nodes.map((n) => [n.node.id, n.tone, n.worker ?? '', n.free]), [['t1', 'free', '', true], ['t2', 'run', 'Ema', false]]);
  assert.equal(sec.working, 1);
  assert.equal(planView(o, { focus: null, brief: null }).read, 'none');
});

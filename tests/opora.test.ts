import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OporaBridge, type BridgeFloor } from '../src/server/opora/bridge.js';
import { OPORA_ESCAPE_WINDOW_MS, browserOporaUrl, canEmbedOpora, cardGroup, deskFor, frontierCards, oporaCanvasUrl, oporaEmbedPolicy, oporaEscapeLeaves, sameDir, signGroup } from '../src/shared/opora.js';
import { PROMPTS } from '../src/shared/prompts.js';
import { oporaCardViews } from '../src/server/opora/sketches.js';
import { configureRea, reaFor } from '../src/server/rea/index.js';
import type { OporaState, WorkerInfo } from '../src/shared/protocol.js';

test('a card on the design pipeline goes to the designers, the rest to the developers', () => {
  assert.equal(cardGroup('design'), 'design');
  assert.equal(cardGroup('code'), 'dev');
  assert.equal(cardGroup(undefined), 'dev');
  assert.equal(signGroup({ text: 'Design' }), 'design');
  assert.equal(signGroup({ text: 'UX návrh' }), 'design');
  assert.equal(signGroup({ text: 'Vývoj' }), 'dev');
  assert.equal(signGroup({ text: 'Lunch' }), undefined);
});

test('deskFor picks a free desk signed for the sector, then for the group, then an unsigned one', () => {
  const desks = ['desk-1', 'desk-2', 'desk-3', 'desk-4'];
  const labels = { 'desk-1': { text: 'Design' }, 'desk-2': { text: 'Frontend' }, 'desk-4': { text: 'Payments' } };
  const none = () => false;
  assert.equal(deskFor('design', undefined, desks, labels, none), 'desk-1');
  assert.equal(deskFor('dev', undefined, desks, labels, none), 'desk-2');
  assert.equal(deskFor('dev', 'payments', desks, labels, none), 'desk-4');
  assert.equal(deskFor('design', undefined, desks, labels, (d) => d === 'desk-1'), 'desk-3');
  assert.equal(deskFor('dev', undefined, desks, labels, () => true), undefined);
});

test('sameDir matches a Windows folder whatever its slashes and case', () => {
  assert.ok(sameDir('P:\\Code\\App', 'p:/code/app/'));
  assert.ok(!sameDir('/home/a/App', '/home/a/app'));
});

test('frontierCards keeps the cards in the group they are listed in, and leaves sectors out', () => {
  const answer = {
    frontier: [{ id: 'c1', name: 'Login form', pipeline: { profile: 'design', current: { id: 'work', label: 'Návrh a UI' } } }, { id: 's1', name: 'A sector' }],
    needsRouting: [{ id: 'c1', name: 'Login form' }, { id: 'c2', name: 'API' }],
    closed: [{ id: 'c3', name: 'Done one' }],
  };
  const cards = frontierCards(answer, (id) => id.startsWith('c'), { id: 's1', name: 'Auth' });
  assert.deepEqual(cards.map((c) => [c.id, c.status, c.group]), [['c1', 'frontier', 'design'], ['c3', 'closed', 'dev'], ['c2', 'needsRouting', 'dev']]);
  assert.equal(cards[0].stage, 'Návrh a UI');
  assert.equal(cards[0].sectorName, 'Auth');
});

/** A small stand-in for Opora's API: a project planning `dir` with a sector of two cards, another project elsewhere with one card, and leases. */
function fakeOpora(dir: string) {
  const calls: { method: string; path: string; body?: Record<string, unknown>; headers: http.IncomingHttpHeaders }[] = [];
  const leases = new Map<string, string>();
  // Opora's page refuses to be framed, as it does until its embed_origins lists someone.
  const page: { headers: Record<string, string> } = { headers: { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'" } };
  // Shop's workspaces; a test adds `main` and a work one (`work1`, with a card of its own).
  const workspaces: { id: string; label?: string }[] = [{ id: 'draft' }];
  const projects = [{ id: 'other', name: 'Other', sourcePath: '/elsewhere' }, { id: 'p1', name: 'Shop', sourcePath: dir.toUpperCase() === dir ? dir : dir.replace(/\//g, '\\') }];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      calls.push({ method: req.method!, path: url.pathname, body, headers: req.headers });
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html', ...page.headers });
        return res.end('<!doctype html><title>Opora</title>');
      }
      if (req.method === 'POST' && req.headers.origin !== `http://127.0.0.1:${(server.address() as AddressInfo).port}`) return send(403, { detail: 'origin' });
      // The other project's canvas: one sector with one card.
      if (url.searchParams.get('project') === 'other') {
        if (url.pathname === '/api/view') return send(200, { graph: { nodes: [{ id: 's9', kind: 'sector', name: 'Elsewhere', parentId: null }, { id: 'c9', kind: 'node', name: 'Other card', parentId: 's9' }] } });
        if (url.pathname === '/api/desktop-v3/frontier') return send(200, { frontier: url.searchParams.get('nodeId') === 's9' ? [{ id: 'c9', name: 'Other card', pipeline: { profile: 'code' } }] : [{ id: 's9', name: 'Elsewhere' }] });
      }
      // Shop's work workspace: a sector with one card, planned there and not in main.
      if (url.searchParams.get('workspace') === 'work1') {
        if (url.pathname === '/api/view') return send(200, { graph: { nodes: [{ id: 's5', kind: 'sector', name: 'Oracle', parentId: null }, { id: 'c5', kind: 'node', name: 'Oracle card', parentId: 's5' }] } });
        if (url.pathname === '/api/desktop-v3/frontier') return send(200, { frontier: url.searchParams.get('nodeId') === 's5' ? [{ id: 'c5', name: 'Oracle card', pipeline: { profile: 'code' } }].filter((c) => !leases.has(c.id)) : [{ id: 's5', name: 'Oracle' }] });
      }
      switch (url.pathname) {
        case '/api/health':
          return send(200, { status: 'ok' });
        case '/api/bootstrap':
          return send(200, { projects });
        case '/api/project-workspaces':
          return send(200, { workspaces });
        case '/api/view':
          return send(200, { graph: { nodes: [{ id: 'a1', kind: 'area', name: 'Frontend' }, { id: 's1', kind: 'sector', name: 'Checkout', parentId: null }, { id: 'c1', kind: 'node', name: 'Cart page', parentId: 's1' }, { id: 'c2', kind: 'node', name: 'Pay API', parentId: 's1' }] } });
        case '/api/desktop-v3/frontier':
          if (url.searchParams.get('nodeId') !== 's1') return send(200, { frontier: [{ id: 's1', name: 'Checkout' }] });
          return send(200, {
            frontier: [
              { id: 'c1', name: 'Cart page', pipeline: { profile: 'design', current: null } },
              { id: 'c2', name: 'Pay API', pipeline: { profile: 'code', current: null } },
            ].filter((c) => !leases.has(c.id)),
            claimed: [...leases.keys()].map((id) => ({ id, name: id })),
          });
        // The design card has a storyboard, the developer's a drawing (one element of it deleted).
        case '/api/drawing':
          return send(200, { scene: { elements: url.searchParams.get('layer') === 'c2' ? [{ id: 'e1', type: 'rectangle' }, { id: 'e2', type: 'image', fileId: 'f1' }, { id: 'e3', type: 'text', isDeleted: true }] : [] }, revision: 1 });
        case '/api/storyboard':
          return send(200, { storyboard: url.searchParams.get('nodeId') === 'c1' ? { animation: 'kod', moments: [{ id: 'm1', t: 0, comment: 'Faster here', answered: false }, { id: 'm2', t: 2, answered: true, sketch: { layer: 'sb/c1/m2' } }] } : null, revision: 3 });
        case '/api/desktop-v3/lease': {
          const node = String(body?.nodeId);
          if (body?.op === 'claim') {
            if (leases.has(node)) return send(409, { detail: 'held' });
            leases.set(node, `tok-${node}`);
            return send(200, { token: `tok-${node}`, expiresAt: '2030-01-01T00:00:00Z' });
          }
          if (body?.op === 'release') leases.delete(node);
          return send(200, { ok: true });
        }
      }
      send(404, { detail: 'nope' });
    });
  });
  return { server, calls, leases, projects, page, workspaces };
}

async function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-opora-'));
  const op = fakeOpora(dir);
  await new Promise<void>((r) => op.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(op.server.address() as AddressInfo).port}`;
  const workers: WorkerInfo[] = [];
  const toasts: string[] = [];
  let state: OporaState | undefined;
  const floor: BridgeFloor = {
    id: 'shop',
    dir,
    list: () => workers,
    seat(deskId, by, prompt) {
      const w = { id: `w${workers.length}`, deskId, kind: 'agent', prompt, name: `Worker ${workers.length}`, color: '#fff', status: 'working', acked: false, createdBy: by, createdAt: Date.now(), cols: 80, rows: 24, viewers: [], viewerIds: [] } as WorkerInfo;
      workers.push(w);
      return w;
    },
    desks: () => ['desk-1', 'desk-2', 'desk-3'],
    deskOccupied: (d) => workers.some((w) => w.deskId === d),
    labels: () => ({ 'desk-3': { text: 'Design', color: '#000', by: 'a', at: 0 } }),
  };
  const bridge = new OporaBridge(floor, dir, { update: (s) => void (state = s), toast: (x) => void toasts.push(x), prompt: (id) => PROMPTS[id].text }, url);
  t.after(() => {
    bridge.shutdown();
    op.server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await bridge.poll();
  return { bridge, op, workers, toasts, url, dir, state: () => state! };
}

test('the bridge links the Opora project that plans this floor’s folder, and reads its cards by sector', async (t) => {
  const f = await fixture(t);
  const s = f.state();
  assert.equal(s.connected, true);
  assert.equal(s.error, undefined);
  assert.deepEqual(s.project, { id: 'p1', name: 'Shop' });
  assert.equal(s.workspace, 'draft');
  assert.deepEqual(s.sectors, [{ id: 's1', name: 'Checkout' }]);
  assert.deepEqual(s.cards.map((c) => [c.name, c.status, c.group, c.sectorName]), [['Cart page', 'frontier', 'design', 'Checkout'], ['Pay API', 'frontier', 'dev', 'Checkout']]);
});

test('taking a card claims its lease on Opora and seats a worker for it, a design card at the Design desk', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.bridge.take('c1', 'Ana'), undefined);
  const claim = f.op.calls.find((c) => c.path === '/api/desktop-v3/lease' && c.body?.op === 'claim')!;
  assert.deepEqual({ project: claim.body!.project, workspace: claim.body!.workspace, nodeId: claim.body!.nodeId }, { project: 'p1', workspace: 'draft', nodeId: 'c1' });
  assert.match(String(claim.headers['x-opora-actor']), /^agent; name=office-shop/);
  assert.equal(f.workers[0].deskId, 'desk-3');
  assert.match(f.workers[0].prompt!, /tok-c1/);
  assert.match(f.workers[0].prompt!, /Cart page/);
  assert.match(f.workers[0].prompt!, /design card/);
  const run = f.state().runs[0];
  assert.equal(run.cardName, 'Cart page');
  assert.equal(run.state, 'working');
  assert.equal((run as unknown as { token?: string }).token, undefined, 'the lease token stays on the server');
  // It's the office's now: taking it again says so.
  assert.match((await f.bridge.take('c1', 'Ana'))!, /isn’t free|already/);
  // The developer's card goes to an unsigned desk.
  assert.equal(await f.bridge.take('c2', 'Ana'), undefined);
  assert.equal(f.workers[1].deskId, 'desk-1');
  assert.doesNotMatch(f.workers[1].prompt!, /design card/);
});

test('a worker going home lets its card’s lease go', async (t) => {
  const f = await fixture(t);
  await f.bridge.take('c2', 'Ana');
  assert.ok(f.op.leases.has('c2'));
  f.workers[0].status = 'done';
  f.bridge.onWorker(f.workers[0]);
  assert.equal(f.state().runs[0].state, 'done');
  f.bridge.onWorkerGone(f.workers[0].id);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(f.op.leases.has('c2'), false);
  assert.equal(f.state().runs[0].state, 'gone');
});

test('the autopilot takes routed cards by itself, up to its limit', async (t) => {
  const f = await fixture(t);
  f.bridge.setAutopilot(true, 1, 'Ana');
  await new Promise((r) => setTimeout(r, 50));
  await f.bridge.poll();
  assert.equal(f.workers.length, 1);
  f.bridge.setAutopilot(true, 2, 'Ana');
  await new Promise((r) => setTimeout(r, 50));
  await f.bridge.poll();
  assert.equal(f.workers.length, 2);
});

test('with Opora down the bridge says so instead of failing', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-opora-'));
  let state: OporaState | undefined;
  const bridge = new OporaBridge({ id: 'x', dir, list: () => [], seat: () => 'no', desks: () => [], deskOccupied: () => false, labels: () => ({}) }, dir, { update: (s) => void (state = s), toast() {}, prompt: (id) => PROMPTS[id].text }, 'http://127.0.0.1:9');
  t.after(() => {
    bridge.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  await bridge.poll();
  assert.equal(state!.connected, false);
  assert.match(state!.error!, /isn't answering/);
  assert.match((await bridge.take('c1', 'Ana'))!, /isn't answering/);
});

test('a floor linked to a project by choice reads that project’s cards, and unlinking goes back to its folder’s', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.state().projects, [{ id: 'other', name: 'Other' }, { id: 'p1', name: 'Shop' }]);
  assert.equal(f.state().linkedBy, 'folder');
  assert.equal(f.bridge.link('other'), undefined);
  await f.bridge.repoll();
  assert.deepEqual(f.state().project, { id: 'other', name: 'Other' });
  assert.equal(f.state().linkedBy, 'choice');
  assert.equal(f.state().error, undefined);
  assert.deepEqual(f.state().cards.map((c) => [c.name, c.sectorName]), [['Other card', 'Elsewhere']]);
  assert.match(readFileSync(path.join(f.dir, 'opora.json'), 'utf8'), /"linkedTo": "other"/);
  assert.match(f.bridge.link('nope')!, /isn’t on Opora/);
  assert.equal(f.bridge.link(null), undefined);
  await f.bridge.repoll();
  assert.deepEqual(f.state().project, { id: 'p1', name: 'Shop' });
  assert.equal(f.state().linkedBy, 'folder');
});

test('a chosen project that left Opora falls back to the folder’s, and says so', async (t) => {
  const f = await fixture(t);
  f.bridge.link('other');
  await f.bridge.repoll();
  f.op.projects.splice(0, 1);
  await f.bridge.poll();
  assert.deepEqual(f.state().project, { id: 'p1', name: 'Shop' });
  assert.equal(f.state().linkedBy, 'folder');
  assert.match(f.state().error!, /isn't on Opora any more.*Shop/);
});

test('the floor stays on its project while the office holds cards of it', async (t) => {
  const f = await fixture(t);
  await f.bridge.take('c2', 'Ana');
  assert.match(f.bridge.link('other')!, /on 1 card of Shop/);
  // Picking the project it's on already changes nothing, so that's allowed.
  assert.equal(f.bridge.link('p1'), undefined);
  assert.equal(f.bridge.link(null), undefined);
  f.bridge.onWorkerGone(f.workers[0].id);
  assert.equal(f.bridge.link('other'), undefined);
});

test('the office opens Opora on the floor’s linked project, or on its home screen with none linked', () => {
  assert.equal(oporaCanvasUrl({ url: 'http://127.0.0.1:8740', project: null, workspace: null }), 'http://127.0.0.1:8740');
  assert.equal(oporaCanvasUrl({ url: 'http://127.0.0.1:8740/', project: { id: 'p 1', name: 'P' }, workspace: 'main' }), 'http://127.0.0.1:8740/?project=p+1&workspace=main&screen=canvas');
  assert.equal(oporaCanvasUrl({ url: '', project: { id: 'p', name: 'P' }, workspace: null }), 'http://127.0.0.1:8740/?project=p&screen=canvas');
});

test('the browser reaches loopback Opora by the name the office page is on, for its SameSite cookie', () => {
  assert.equal(browserOporaUrl('http://127.0.0.1:8740/?project=p', 'localhost'), 'http://localhost:8740/?project=p');
  assert.equal(browserOporaUrl('http://localhost:8740', '127.0.0.1'), 'http://127.0.0.1:8740/');
  assert.equal(browserOporaUrl('http://127.0.0.1:8740', '127.0.0.1'), 'http://127.0.0.1:8740');
  // An office reached by another name, or Opora elsewhere, keeps the address as it is.
  assert.equal(browserOporaUrl('http://127.0.0.1:8740', 'office.example.com'), 'http://127.0.0.1:8740');
  assert.equal(browserOporaUrl('http://opora.lan:8740', 'localhost'), 'http://opora.lan:8740');
  assert.equal(browserOporaUrl('not a url', 'localhost'), 'not a url');
});

test('one Esc passed up from framed Opora stays in it, a second one soon after leaves', () => {
  assert.equal(oporaEscapeLeaves(undefined, 1000), false);
  assert.equal(oporaEscapeLeaves(1000, 1300), true);
  assert.equal(oporaEscapeLeaves(1000, 1000 + OPORA_ESCAPE_WINDOW_MS), true);
  assert.equal(oporaEscapeLeaves(1000, 1001 + OPORA_ESCAPE_WINDOW_MS), false);
  assert.equal(oporaEscapeLeaves(1000, 900), false);
  assert.equal(oporaEscapeLeaves(1000, 1500, 400), false);
});

test('Opora frames for the pages its frame-ancestors lists, and not with X-Frame-Options alone', () => {
  assert.deepEqual(oporaEmbedPolicy('DENY', "default-src 'self'; frame-ancestors 'none'"), { embeddable: false });
  assert.deepEqual(oporaEmbedPolicy('DENY', null), { embeddable: false });
  assert.deepEqual(oporaEmbedPolicy('SAMEORIGIN', null), { embeddable: false });
  assert.deepEqual(oporaEmbedPolicy(null, "default-src 'self'; frame-ancestors 'self'"), { embeddable: false });
  assert.deepEqual(oporaEmbedPolicy(null, null), { embeddable: true });
  // frame-ancestors wins over X-Frame-Options, as it does in browsers.
  assert.deepEqual(oporaEmbedPolicy('DENY', "frame-ancestors 'self' http://localhost:4600"), { embeddable: true, embedOrigins: ['http://localhost:4600'] });
  const on = { connected: true, embeddable: true, embedOrigins: ['http://localhost:4600', 'http://127.0.0.1:*'] };
  assert.ok(canEmbedOpora(on, 'http://localhost:4600'));
  assert.ok(canEmbedOpora(on, 'http://127.0.0.1:4615'));
  assert.ok(!canEmbedOpora(on, 'http://localhost:4615'));
  assert.ok(canEmbedOpora({ connected: true, embeddable: true }, 'http://office.lan'));
  assert.ok(!canEmbedOpora({ ...on, connected: false }, 'http://localhost:4600'));
  assert.ok(!canEmbedOpora({ connected: true, embeddable: false }, 'http://localhost:4600'));
});

test('the bridge reads from Opora’s page whether the office may frame it, each poll', async (t) => {
  const f = await fixture(t);
  assert.equal(f.state().embeddable, false);
  assert.equal(f.state().embedOrigins, undefined);
  f.op.page.headers = { 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'self' http://localhost:4600" };
  await f.bridge.poll();
  assert.equal(f.state().embeddable, true);
  assert.deepEqual(f.state().embedOrigins, ['http://localhost:4600']);
  f.op.page.headers = {};
  await f.bridge.poll();
  assert.equal(f.state().embeddable, true);
  assert.equal(f.state().embedOrigins, undefined);
  assert.ok(f.op.calls.some((c) => c.method === 'GET' && c.path === '/'));
});

test('the Opora pages for a card open its drawing (Kreslení) and its storyboard', () => {
  assert.deepEqual(oporaCardViews('http://127.0.0.1:8740', 'p 1', 'draft', 'c1'), {
    drawing: 'http://127.0.0.1:8740/?project=p+1&workspace=draft&screen=canvas&environment=editor&mode=drawing&layer=c1',
    storyboard: 'http://127.0.0.1:8740/?project=p+1&workspace=draft&screen=canvas&environment=editor&mode=storyboard&node=c1',
  });
});

test('a design card gets the designer’s brief, with its Opora pages and what is sketched on it', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.bridge.take('c1', 'Ana'), undefined);
  const prompt = f.workers[0].prompt!;
  const views = oporaCardViews(f.url, 'p1', 'draft', 'c1');
  assert.ok(prompt.includes(PROMPTS['opora.design'].text.slice(0, 40)), 'the opora.design brief is in it');
  assert.ok(prompt.includes(views.drawing) && prompt.includes(views.storyboard));
  assert.match(prompt, /a storyboard \(animation "kod"\) with 2 moments, 1 sketched, 1 waiting on a reply/);
  assert.match(prompt, /opora_read\.py drawing --project p1 --workspace draft --layer c1 --raw/);
  assert.match(prompt, /--layer sb\/c1\/<momentId>/);
  assert.doesNotMatch(prompt, /Look at them before you build/, 'the developer’s sketches line stays out of it');
  assert.doesNotMatch(prompt, /\{\{/);
  // Only reads: the bridge never writes to the storyboard or a drawing.
  assert.ok(!f.op.calls.some((c) => c.method === 'POST' && (c.path === '/api/drawing' || c.path === '/api/storyboard')));
});

test('a developer’s card with sketches is told where they are and how to see them, one without is not', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.bridge.take('c2', 'Ana'), undefined);
  const prompt = f.workers[0].prompt!;
  assert.match(prompt, /On Opora this card has a drawing of 2 elements \(1 pasted image\) in the card's own Kreslení layer\. Look at them before you build/);
  assert.ok(prompt.includes(oporaCardViews(f.url, 'p1', 'draft', 'c2').drawing));
  assert.match(prompt, /opora_read\.py drawing --project p1 --workspace draft --layer c2 --raw/);
  assert.doesNotMatch(prompt, /design card|mode=storyboard/);
  assert.doesNotMatch(prompt, /\{\{/);
  f.bridge.onWorkerGone(f.workers[0].id);
  f.bridge.link('other');
  await f.bridge.repoll();
  assert.equal(await f.bridge.take('c9', 'Ana'), undefined);
  assert.doesNotMatch(f.workers[1].prompt!, /On Opora this card has|Look at them/);
  assert.match(f.workers[1].prompt!, /end your turn\.$/);
});

test('with 🔬 REA on for Opora, a card’s worker gets REA and is told how to use it; with it off, neither', async (t) => {
  const f = await fixture(t);
  configureRea(f.dir, undefined, {});
  assert.equal(await f.bridge.take('c2', 'Ana'), undefined);
  assert.equal(reaFor(f.workers[0]), false);
  assert.doesNotMatch(f.workers[0].prompt!, /"rea" MCP server/);
  configureRea(f.dir, undefined, { AGENT_OFFICE_REA: 'opora' });
  t.after(() => configureRea(f.dir, undefined, {}));
  assert.equal(await f.bridge.take('c1', 'Ana'), undefined);
  assert.equal(reaFor(f.workers[1]), true);
  assert.match(f.workers[1].prompt!, /"rea" MCP server/);
  assert.match(f.workers[1].prompt!, /layers → areas, sectors, nodes\/cards/);
  // The first card's worker was seated for Opora too: it gets REA from its next start.
  assert.equal(reaFor(f.workers[0]), true);
  f.bridge.onWorkerGone(f.workers[1].id);
  assert.equal(reaFor(f.workers[1]), false, 'forgotten once it went home');
});

/** Shop with Opora's `main` (read-only for a git project) and a work workspace the planning happens in. */
async function withWorkspaces(t: { after(fn: () => void): void }) {
  const f = await fixture(t);
  f.op.workspaces.splice(0, f.op.workspaces.length, { id: 'main', label: 'Approved branch · read-only' }, { id: 'work1', label: 'Oracle · work/work1' });
  await f.bridge.poll();
  return f;
}

test('a floor reads its project’s main workspace by default, and lists the others with their labels', async (t) => {
  const f = await withWorkspaces(t);
  assert.equal(f.state().workspace, 'main');
  assert.equal(f.state().workspaceBy, 'default');
  assert.deepEqual(f.state().workspaces, [{ id: 'main', label: 'Approved branch · read-only' }, { id: 'work1', label: 'Oracle · work/work1' }]);
  assert.deepEqual(f.state().cards.map((c) => c.name), ['Cart page', 'Pay API']);
});

test('a picked workspace is the one the floor reads and claims cards in', async (t) => {
  const f = await withWorkspaces(t);
  assert.match(f.bridge.useWorkspace('nope')!, /isn’t in Shop/);
  assert.equal(f.bridge.useWorkspace('work1'), undefined);
  await f.bridge.repoll();
  assert.equal(f.state().workspace, 'work1');
  assert.equal(f.state().workspaceBy, 'choice');
  assert.equal(f.state().error, undefined);
  assert.deepEqual(f.state().cards.map((c) => [c.name, c.sectorName]), [['Oracle card', 'Oracle']]);
  assert.equal(await f.bridge.take('c5', 'Ana'), undefined);
  const claim = f.op.calls.find((c) => c.path === '/api/desktop-v3/lease' && c.body?.op === 'claim')!;
  assert.deepEqual({ project: claim.body!.project, workspace: claim.body!.workspace, nodeId: claim.body!.nodeId }, { project: 'p1', workspace: 'work1', nodeId: 'c5' });
  assert.match(f.workers[0].prompt!, /work1/);
  // Back to the default.
  assert.equal(f.bridge.useWorkspace(null), undefined);
  await f.bridge.repoll();
  assert.equal(f.state().workspace, 'main');
  assert.equal(f.state().workspaceBy, 'default');
});

test('a picked workspace that left Opora falls back to main, and says so', async (t) => {
  const f = await withWorkspaces(t);
  f.bridge.useWorkspace('work1');
  await f.bridge.repoll();
  f.op.workspaces.splice(1, 1);
  await f.bridge.poll();
  assert.equal(f.state().workspace, 'main');
  assert.equal(f.state().workspaceBy, 'default');
  assert.match(f.state().error!, /workspace this floor was set to \(work1\) isn't in Shop.*Approved branch/);
});

test('a card the office holds keeps its own workspace for its heartbeat and release', async (t) => {
  const f = await withWorkspaces(t);
  f.bridge.useWorkspace('work1');
  await f.bridge.repoll();
  await f.bridge.take('c5', 'Ana');
  assert.equal(f.state().runs[0].workspace, 'work1');
  // The floor moves to main while the card is still being worked on.
  f.bridge.useWorkspace(null);
  await f.bridge.repoll();
  assert.equal(f.state().workspace, 'main');
  await (f.bridge as unknown as { heartbeat(): Promise<void> }).heartbeat();
  const beat = f.op.calls.find((c) => c.path === '/api/desktop-v3/lease' && c.body?.op === 'heartbeat')!;
  assert.equal(beat.body!.workspace, 'work1');
  f.bridge.onWorkerGone(f.workers[0].id);
  await new Promise((r) => setTimeout(r, 100));
  const release = f.op.calls.find((c) => c.path === '/api/desktop-v3/lease' && c.body?.op === 'release')!;
  assert.deepEqual({ workspace: release.body!.workspace, nodeId: release.body!.nodeId }, { workspace: 'work1', nodeId: 'c5' });
  assert.equal(f.op.leases.has('c5'), false);
});

test('a run saved before runs kept their workspace lets its lease go in the floor’s current one', async (t) => {
  const f = await withWorkspaces(t);
  await f.bridge.take('c2', 'Ana');
  // As an older office saved it: no workspace on the run.
  delete (f.bridge as unknown as { runs: { workspace?: string }[] }).runs[0].workspace;
  f.bridge.onWorkerGone(f.workers[0].id);
  await new Promise((r) => setTimeout(r, 100));
  const release = f.op.calls.find((c) => c.path === '/api/desktop-v3/lease' && c.body?.op === 'release')!;
  assert.equal(release.body!.workspace, 'main');
});

test('the picked workspace is kept across a restart, and linking another project resets it', async (t) => {
  const f = await withWorkspaces(t);
  f.bridge.useWorkspace('work1');
  await f.bridge.repoll();
  assert.match(readFileSync(path.join(f.dir, 'opora.json'), 'utf8'), /"workspace": "work1"/);
  f.bridge.shutdown();
  let state: OporaState | undefined;
  const again = new OporaBridge({ id: 'shop', dir: f.dir, list: () => [], seat: () => 'no', desks: () => [], deskOccupied: () => false, labels: () => ({}) }, f.dir, { update: (s) => void (state = s), toast() {}, prompt: (id) => PROMPTS[id].text }, f.url);
  t.after(() => again.shutdown());
  await again.poll();
  assert.equal(state!.workspace, 'work1');
  assert.equal(state!.workspaceBy, 'choice');
  assert.equal(again.link('other'), undefined);
  assert.doesNotMatch(readFileSync(path.join(f.dir, 'opora.json'), 'utf8'), /"workspace"/);
});

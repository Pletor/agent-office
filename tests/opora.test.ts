import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OporaBridge, type BridgeFloor } from '../src/server/opora/bridge.js';
import { cardGroup, deskFor, frontierCards, sameDir, signGroup } from '../src/shared/opora.js';
import { PROMPTS } from '../src/shared/prompts.js';
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

/** A small stand-in for Opora's API: one project planning `dir`, a sector with two cards, and leases. */
function fakeOpora(dir: string) {
  const calls: { method: string; path: string; body?: Record<string, unknown>; headers: http.IncomingHttpHeaders }[] = [];
  const leases = new Map<string, string>();
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
      if (req.method === 'POST' && req.headers.origin !== `http://127.0.0.1:${(server.address() as AddressInfo).port}`) return send(403, { detail: 'origin' });
      switch (url.pathname) {
        case '/api/health':
          return send(200, { status: 'ok' });
        case '/api/bootstrap':
          return send(200, { projects: [{ id: 'other', name: 'Other', sourcePath: '/elsewhere' }, { id: 'p1', name: 'Shop', sourcePath: dir.toUpperCase() === dir ? dir : dir.replace(/\//g, '\\') }] });
        case '/api/project-workspaces':
          return send(200, { workspaces: [{ id: 'draft' }] });
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
  return { server, calls, leases };
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
  return { bridge, op, workers, toasts, url, state: () => state! };
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

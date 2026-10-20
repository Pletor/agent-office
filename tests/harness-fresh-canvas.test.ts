// A harness save below the project re-checks its node's place under the store's lock against the canvas
// read from Opora right then (OporaBridge.freshCanvasNodes), not the bridge's last poll: a real bridge
// against a small fake Opora, where the card is moved on Opora's side while the save waits for another
// office's lock. With Opora unreachable such a save is refused and nothing is written; saves that need
// no canvas (global, project, a custom task) still go through.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Ctx } from '../src/server/office/context.js';
import type { Floor } from '../src/server/floor.js';
import { OporaBridge } from '../src/server/opora/bridge.js';
import { harnessProfileRequest } from '../src/server/harness/api.js';
import { oporaKey } from '../src/shared/opora-identity.js';
import { PROMPTS } from '../src/shared/prompts.js';

test('the place of a node is re-checked under the lock against Opora itself, and refused without it', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-fresh-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'harness-fresh-data-'));
  // Opora's canvas: a page and a layer under the root sector, two sectors in the layer, Card 1 in Sector 1; a second page and layer.
  const parents: Record<string, string | null> = { root: null, page: 'root', layer: 'page', s1: 'layer', s2: 'layer', c1: 's1', page2: 'root', layer2: 'page2' };
  const kinds: Record<string, string> = { root: 'sector', page: 'node', layer: 'node', s1: 'sector', s2: 'sector', c1: 'node', page2: 'node', layer2: 'node' };
  let views = 0;
  const opora = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (data: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/api/health') return send({ status: 'ok' });
    if (url.pathname === '/api/bootstrap') return send({ projects: [{ id: 'p', name: 'Shop', sourcePath: dir }] });
    if (url.pathname === '/api/project-workspaces') return send({ workspaces: [{ id: 'w' }] });
    if (url.pathname === '/api/view') { views++; return send({ graph: { nodes: Object.keys(parents).map((id) => ({ id, kind: kinds[id], name: id, parentId: parents[id] })) } }); }
    if (url.pathname === '/api/desktop-v3/frontier') return send({ frontier: [] });
    res.writeHead(404); res.end('{}');
  });
  await new Promise<void>((r) => opora.listen(0, '127.0.0.1', r));
  const bridgeFloor = { id: 'shop', dir, list: () => [], seat: () => 'no', desks: () => [], deskOccupied: () => false, labels: () => ({}) };
  const bridge = new OporaBridge(bridgeFloor, dataDir, { update() {}, toast() {}, prompt: (id) => PROMPTS[id].text }, `http://127.0.0.1:${(opora.address() as AddressInfo).port}`);
  await bridge.poll();
  const floor = { dir, opora: bridge } as unknown as Floor;
  const ctx = { cfg: { dataDir } } as unknown as Ctx;
  const office = http.createServer((req, res) => void harnessProfileRequest(ctx, floor, req, res, new URL(req.url!, 'http://x'), true, true, true, 'admin'));
  await new Promise<void>((r) => office.listen(0, '127.0.0.1', r));
  t.after(() => { bridge.shutdown(); opora.closeAllConnections(); opora.close(); office.close(); rmSync(dir, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(office.address() as AddressInfo).port}/?`;
  const k = (id: string) => oporaKey({ project: 'p', workspace: 'w' }, id);
  const call = async (query: string, body?: unknown) => {
    const res = await fetch(base + query, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const card = 'node=' + encodeURIComponent(k('c1'));
  const at = (view: { path: { level: string; node: string }[] }, level: string) => view.path.find((p) => p.level === level)?.node;
  const lock = path.join(dataDir, 'harness-profiles.json.lock');
  /** Holds the store's lock as another office would while `during` runs, then lets go: the save under test waits for it meanwhile. */
  const queued = async (query: string, body: unknown, during: () => void) => {
    writeFileSync(lock, JSON.stringify({ token: 'other-office', pid: 0, acquiredAt: Date.now(), renewedAt: Date.now() }));
    const pending = call(query, body);
    await new Promise((r) => setTimeout(r, 300));
    during();
    unlinkSync(lock);
    return pending;
  };

  // 1. Card 1 moves to Sector 2 on Opora while the save waits for the lock. The bridge's poll hasn't seen it, the save has.
  const before = (await call(card)).data;
  assert.equal(at(before, 'sector'), k('s1'));
  const moved = await queued(card, { scope: 'sector', layer: { tone: { value: 'late' } }, revision: before.revision, at: k('s1') }, () => { parents.c1 = 's2'; });
  assert.equal(moved.status, 409);
  assert.match(moved.data.error, /moved this node while the save waited/);
  assert.equal(bridge.canvasNodes().find((n) => n.id === 'c1')?.parentId, 's1', 'the last poll still has the card where it was: the check read Opora itself');
  assert.equal((await call('')).data.revision, before.revision, 'nothing was written');

  // 2. Once the poll has caught up, a save at the card's sector goes through, and a move above that level while it waits
  //    (Sector 2 into the other layer) is not a refusal: the committed profile carries the path as it is now.
  await bridge.poll();
  const now = (await call(card)).data;
  assert.equal(at(now, 'sector'), k('s2'));
  const readsBefore = views;
  const saved = await queued(card, { scope: 'sector', layer: { tone: { value: 'kept' } }, revision: now.revision, at: k('s2') }, () => { parents.s2 = 'layer2'; });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.revision, now.revision + 1);
  assert.deepEqual(saved.data.layers.sector, { tone: { value: 'kept' } });
  assert.equal(at(saved.data, 'layer'), k('layer2'), 'the response\'s path is the one the save was checked against under the lock');
  assert.ok(views > readsBefore, 'the save read the canvas from Opora');

  // 3. Opora unreachable: a save that needs the canvas is refused and writes nothing; the ones that don't still save.
  opora.closeAllConnections();
  await new Promise<void>((r) => opora.close(() => r()));
  const after = (await call(card)).data;
  assert.equal(after.revision, saved.data.revision);
  const offline = await call(card, { scope: 'sector', layer: { tone: { value: 'offline' } }, revision: after.revision, at: at(after, 'sector') });
  assert.equal(offline.status, 503);
  assert.match(offline.data.error, /Opora can't be reached/);
  assert.equal((await call('')).data.revision, after.revision, 'nothing was written');
  const global = await call('', { scope: 'global', layer: { tone: { value: 'g' } }, revision: after.revision });
  assert.equal(global.status, 200, 'a global save needs no canvas');
  const project = await call(card, { scope: 'project', layer: { tone: { value: 'p' } }, revision: global.data.revision });
  assert.equal(project.status, 200, 'nor does a project save');
  const custom = await call('task=custom-1', { scope: 'task', layer: { tone: { value: 'c' } }, revision: project.data.revision });
  assert.equal(custom.status, 200, 'nor does a custom task\'s');
  assert.equal(custom.data.revision, after.revision + 3);
});

// Each stage of a card's pipeline is a session of its own: its own name on Opora, and the lease the
// office claimed for exactly that session, kept alive and let go. The Opora here is a stand-in on a
// free loopback port that checks names and tokens the way Opora's lease API does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OporaBridge, type BridgeFloor } from '../src/server/opora/bridge.js';
import { pickSession, sessionName } from '../src/server/opora/session.js';
import { childEnv } from '../src/server/workers/env.js';
import { PROMPTS } from '../src/shared/prompts.js';
import type { OporaState, WorkerInfo } from '../src/shared/protocol.js';

const HELD = 'Kartu drží jiný agent, token nesouhlasí nebo převzetí vypršelo.';
const STAGES = [
  { id: 'a1b2c3d4-work', kind: 'work', lens: '', title: 'Práce' },
  { id: 'e5f6a7b8-review', kind: 'review', lens: '', title: 'Review' },
];

/** Opora's lease API as it behaves: a token per claim, heartbeat and release only with that token, 409 otherwise. */
function strictOpora(dir: string) {
  const calls: { op: string; owner?: string; token?: string; nodeId: string }[] = [];
  const leases = new Map<string, { owner: string; token: string; expires: number }>();
  const opora = { calls, leases, current: 0, refuseClaims: false, keepHeldInFrontier: false };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const now = Date.now() / 1000;
      const held = (id: string) => (leases.get(id)?.expires ?? 0) > now;
      switch (url.pathname) {
        case '/':
          res.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY' });
          return res.end('<!doctype html><title>Opora</title>');
        case '/api/health':
          return send(200, { status: 'ok' });
        case '/api/bootstrap':
          return send(200, { projects: [{ id: 'p1', name: 'Shop', sourcePath: dir }] });
        case '/api/project-workspaces':
          return send(200, { workspaces: [{ id: 'main' }] });
        case '/api/view':
          return send(200, { graph: { nodes: [{ id: 's1', kind: 'sector', name: 'Checkout', parentId: null }, { id: 'c1aa11bb-card', kind: 'node', name: 'Pay API', parentId: 's1' }] } });
        case '/api/desktop-v3/frontier': {
          if (url.searchParams.get('nodeId') !== 's1') return send(200, { frontier: [{ id: 's1', name: 'Checkout' }] });
          const row = { id: 'c1aa11bb-card', name: 'Pay API', pipeline: { profile: 'code', routed: true, current: STAGES[opora.current] ?? null } };
          return held(row.id) && !opora.keepHeldInFrontier ? send(200, { frontier: [], claimed: [{ ...row, claim: leases.get(row.id)!.owner }] }) : send(200, { frontier: [row] });
        }
        case '/api/drawing':
          return send(200, { scene: { elements: [] } });
        case '/api/storyboard':
          return send(200, { storyboard: null });
        case '/api/desktop-v3/node-brief':
          // The stages before the one on turn are handed in.
          return send(200, { pipeline: { stages: STAGES.map((s, i) => ({ ...s, status: i < opora.current ? 'passed' : 'todo' })) } });
        case '/api/desktop-v3/lease': {
          const nodeId = String(body.nodeId);
          const op = String(body.op);
          calls.push({ op, nodeId, ...(typeof body.owner === 'string' ? { owner: body.owner } : {}), ...(typeof body.token === 'string' ? { token: body.token } : {}) });
          const lease = leases.get(nodeId);
          if (op === 'claim') {
            if (opora.refuseClaims || held(nodeId)) return send(409, { error: HELD });
            const token = randomBytes(32).toString('hex');
            leases.set(nodeId, { owner: String(body.owner), token, expires: now + Number(body.ttlSeconds) });
            return send(200, { nodeId, op, token, expiresAt: now + Number(body.ttlSeconds) });
          }
          if (!lease || lease.token !== body.token || lease.expires <= now) return send(409, { error: HELD });
          if (op === 'heartbeat') {
            lease.expires = now + Number(body.ttlSeconds);
            return send(200, { nodeId, op, expiresAt: lease.expires });
          }
          leases.delete(nodeId);
          return send(200, { nodeId, op });
        }
      }
      send(404, { detail: 'nope' });
    });
  });
  return { server, opora };
}

async function office(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-opora-sessions-'));
  const { server, opora } = strictOpora(dir);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const workers: WorkerInfo[] = [];
  /** What each worker's process was started with, read as the worker manager does when it launches one. */
  const envs = new Map<string, Record<string, string>>();
  const prefix = randomBytes(3).toString('hex');
  let state: OporaState | undefined;
  const floor: BridgeFloor = {
    id: 'shop',
    dir,
    list: () => workers,
    seat(deskId, by, prompt) {
      const w = { id: `${prefix}-w${workers.length}`, deskId, kind: 'agent', prompt, name: `Worker ${workers.length}`, color: '#fff', status: 'working', acked: false, createdBy: by, createdAt: Date.now(), cols: 80, rows: 24, viewers: [], viewerIds: [] } as WorkerInfo;
      workers.push(w);
      // The worker manager launches the worker before seat() returns.
      envs.set(w.id, childEnv(w.id));
      return w;
    },
    desks: () => ['desk-1', 'desk-2', 'desk-3'],
    deskOccupied: (d) => workers.some((w) => w.deskId === d && w.status !== 'exited'),
    labels: () => ({}),
  };
  const bridge = new OporaBridge(floor, dir, { update: (s) => void (state = s), toast() {}, prompt: (id) => PROMPTS[id].text }, url);
  t.after(() => {
    bridge.shutdown();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await bridge.poll();
  const settle = () => new Promise((r) => setTimeout(r, 100));
  const heartbeat = () => (bridge as unknown as { heartbeat(): Promise<void> }).heartbeat();
  return { bridge, opora, workers, envs, settle, heartbeat, state: () => state! };
}

const CARD = 'c1aa11bb-card';
const claims = (o: { calls: { op: string; owner?: string }[] }) => o.calls.filter((c) => c.op === 'claim');

test('the work stage and the review after it run under different names, and the review is never the author’s', async (t) => {
  const f = await office(t);
  assert.equal(await f.bridge.take(CARD, 'Ana'), undefined);
  const work = f.opora.leases.get(CARD)!.owner;
  // The worker hands its stage in and ends its turn; the review is on turn next.
  f.opora.current = 1;
  f.workers[0].status = 'done';
  f.bridge.onWorker(f.workers[0]);
  await f.settle();
  await f.bridge.repoll();
  assert.equal(await f.bridge.take(CARD, 'Ana'), undefined);
  const review = f.opora.leases.get(CARD)!.owner;
  assert.notEqual(review, work, 'the review must not report under the name that did the work');
  for (const name of [work, review]) assert.match(name, /^[\w .:()-]+$/);
  assert.match(work, /^office-shop-c1aa11bb-work-a1b2c3d4-[0-9a-f]{4}$/);
  assert.match(review, /^office-shop-c1aa11bb-review-e5f6a7b8-[0-9a-f]{4}$/);
  // Each worker reports under its own session's name.
  assert.equal(f.envs.get(f.workers[0].id)!.OPORA_AGENT_NAME, work);
  assert.equal(f.envs.get(f.workers[1].id)!.OPORA_AGENT_NAME, review);
  assert.match(f.workers[1].prompt!, new RegExp(review));
});

test('the token the office claimed is the one its worker gets, and the one the office renews and lets go with', async (t) => {
  const f = await office(t);
  await f.bridge.take(CARD, 'Ana');
  const lease = f.opora.leases.get(CARD)!;
  assert.equal(f.envs.get(f.workers[0].id)!.OPORA_LEASE_TOKEN, lease.token);
  // The prompt says where the token is, never the token: every client and workers.json get the prompt.
  assert.ok(!f.workers[0].prompt!.includes(lease.token));
  assert.match(f.workers[0].prompt!, /OPORA_LEASE_TOKEN/);
  await f.heartbeat();
  const beat = f.opora.calls.filter((c) => c.op === 'heartbeat');
  assert.deepEqual(beat.map((c) => c.token), [lease.token]);
  assert.equal(f.state().runs[0].error, undefined);
  assert.ok(f.state().runs[0].leaseUntil, 'the run says until when Opora holds the lease');
  f.bridge.onWorkerGone(f.workers[0].id);
  await f.settle();
  assert.deepEqual(f.opora.calls.filter((c) => c.op === 'release').map((c) => c.token), [lease.token]);
  assert.equal(f.opora.leases.has(CARD), false);
});

test('a lease Opora no longer has (the worker let it go, or it ran out) is not renewed again and again', async (t) => {
  const f = await office(t);
  await f.bridge.take(CARD, 'Ana');
  // The worker released it itself, as its brief says, and is still at its desk.
  f.opora.leases.delete(CARD);
  await f.heartbeat();
  await f.heartbeat();
  assert.equal(f.opora.calls.filter((c) => c.op === 'heartbeat').length, 1, 'one 409 ends the renewing');
  assert.match(f.state().runs[0].error ?? '', /lease/i);
  assert.equal(f.envs.get(f.workers[0].id)!.OPORA_LEASE_TOKEN !== undefined, true);
  assert.equal(childEnv(f.workers[0].id).OPORA_LEASE_TOKEN, undefined, 'a relaunched worker isn’t handed the dead token');
});

test('a worker that crashes or goes home lets its session’s lease go with its token', async (t) => {
  const f = await office(t);
  await f.bridge.take(CARD, 'Ana');
  const token = f.opora.leases.get(CARD)!.token;
  f.workers[0].status = 'exited';
  f.bridge.onWorker(f.workers[0]);
  await f.settle();
  assert.deepEqual(f.opora.calls.filter((c) => c.op === 'release').map((c) => c.token), [token]);
  assert.equal(f.opora.leases.has(CARD), false);
  // Going home after that doesn't try again with a token that's gone.
  f.bridge.onWorkerGone(f.workers[0].id);
  await f.settle();
  assert.equal(f.opora.calls.filter((c) => c.op === 'release').length, 1);
  assert.equal(f.state().runs[0].state, 'gone');
});

test('a worker going home with no turn ended still lets its lease go', async (t) => {
  const f = await office(t);
  await f.bridge.take(CARD, 'Ana');
  const token = f.opora.leases.get(CARD)!.token;
  f.workers.splice(0, 1);
  await f.bridge.poll();
  await f.settle();
  assert.deepEqual(f.opora.calls.filter((c) => c.op === 'release').map((c) => c.token), [token]);
  assert.equal(f.opora.leases.has(CARD), false);
});

test('a 409 on claim takes nothing over and never asks again under the same name', async (t) => {
  const f = await office(t);
  f.opora.refuseClaims = true;
  f.opora.keepHeldInFrontier = true;
  const err = await f.bridge.take(CARD, 'Ana');
  assert.match(err ?? '', /holds|drží/);
  assert.equal(claims(f.opora).length, 1, 'no second claim within the take');
  assert.equal(f.workers.length, 0, 'nobody is seated for a card someone else holds');
  // The autopilot doesn't go straight back for it on the same read.
  f.bridge.setAutopilot(true, 2, 'Ana');
  await f.bridge.repoll();
  await f.bridge.take(CARD, 'Ana');
  const names = claims(f.opora).map((c) => c.owner);
  assert.equal(new Set(names).size, names.length, `a name Opora refused is never claimed with again: ${names.join(', ')}`);
  assert.equal(f.workers.length, 0);
});

test('a session’s name keeps its card, kind, stage and run however long the floor’s id, in the characters Opora takes', () => {
  const name = sessionName('floor/with spaces & ' + 'x'.repeat(200), 'c1aa11bb-card', { id: 'e5f6a7b8-review', kind: 'review' }, '0a1b');
  assert.ok(name.length <= 120);
  assert.match(name, /^office-floor-with spaces - x+-c1aa11bb-review-e5f6a7b8-0a1b$/);
  assert.equal(sessionName('shop', 'c1aa11bb-card', {}, '0a1b'), 'office-shop-c1aa11bb-card-0a1b');
});

test('a review whose name would be the work’s author is refused, not started', () => {
  const earlier = [{ owner: 'office-shop-c1aa11bb-review-e5f6a7b8-0a1b', stageKind: 'work' }];
  const picked = pickSession('shop', 'c1aa11bb-card', { id: 'e5f6a7b8-review', kind: 'review' }, earlier, () => '0a1b');
  assert.ok('error' in picked);
  assert.match(picked.error, /session of its own/);
  // Another run id is simply another session.
  let n = 0;
  const again = pickSession('shop', 'c1aa11bb-card', { id: 'e5f6a7b8-review', kind: 'review' }, earlier, () => (n++ ? 'beef' : '0a1b'));
  assert.deepEqual(again, { name: 'office-shop-c1aa11bb-review-e5f6a7b8-beef' });
});

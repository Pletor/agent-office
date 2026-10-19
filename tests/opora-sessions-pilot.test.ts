// What the pilot of PR #13 (a real office, a real Opora, a stub agent as the worker) found, kept as
// regression tests on a stand-in Opora: a restart while a session holds its lease, a lease someone
// else took over, where the lease token may go, and a turn that ends without the stage handed in.
// The `todo` ones are the pilot's blockers: they report until the fix lands, then pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OporaBridge, type BridgeFloor } from '../src/server/opora/bridge.js';
import { forgetSession } from '../src/server/opora/session.js';
import { childEnv } from '../src/server/workers/env.js';
import { PROMPTS } from '../src/shared/prompts.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const CARD = 'c1aa11bb-card';
const WORK = { id: 'a1b2c3d4-work', kind: 'work', lens: '', title: 'Práce' };

/** Opora's lease API as the pilot saw it: a token per claim, heartbeat and release only with it, 409 otherwise. */
function strictOpora(dir: string) {
  const calls: { op: string; owner?: string; token?: string }[] = [];
  const leases = new Map<string, { owner: string; token: string; expires: number }>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const send = (status: number, data: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      const now = Date.now() / 1000;
      const lease = leases.get(CARD);
      const held = (lease?.expires ?? 0) > now;
      switch (url.pathname) {
        case '/':
          return res.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY' }).end('<!doctype html>');
        case '/api/health':
          return send(200, { status: 'ok' });
        case '/api/bootstrap':
          return send(200, { projects: [{ id: 'p1', name: 'Shop', sourcePath: dir }] });
        case '/api/project-workspaces':
          return send(200, { workspaces: [{ id: 'main' }] });
        case '/api/view':
          return send(200, { graph: { nodes: [{ id: CARD, kind: 'node', name: 'Pay API', parentId: null }] } });
        case '/api/desktop-v3/frontier': {
          // The stage stays on turn until a session hands it in, as on Opora.
          const row = { id: CARD, name: 'Pay API', pipeline: { profile: 'code', routed: true, current: WORK } };
          return held ? send(200, { frontier: [], claimed: [{ ...row, claim: lease!.owner }] }) : send(200, { frontier: [row] });
        }
        case '/api/drawing':
          return send(200, { scene: { elements: [] } });
        case '/api/storyboard':
          return send(200, { storyboard: null });
        case '/api/desktop-v3/lease': {
          const op = String(body.op);
          calls.push({ op, ...(typeof body.owner === 'string' ? { owner: body.owner } : {}), ...(typeof body.token === 'string' ? { token: body.token } : {}) });
          if (op === 'claim') {
            if (held) return send(409, { error: 'Kartu drží jiný agent.' });
            const token = randomBytes(32).toString('hex');
            leases.set(CARD, { owner: String(body.owner), token, expires: now + Number(body.ttlSeconds) });
            return send(200, { token, expiresAt: now + Number(body.ttlSeconds) });
          }
          if (!lease || lease.token !== body.token || !held) return send(409, { error: 'Kartu drží jiný agent.' });
          if (op === 'heartbeat') {
            lease.expires = now + Number(body.ttlSeconds);
            return send(200, { expiresAt: lease.expires });
          }
          leases.delete(CARD);
          return send(200, {});
        }
      }
      send(404, { detail: 'nope' });
    });
  });
  return { server, calls, leases };
}

async function office(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-opora-pilot-'));
  const opora = strictOpora(dir);
  await new Promise<void>((r) => opora.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(opora.server.address() as AddressInfo).port}`;
  const workers: WorkerInfo[] = [];
  const envs = new Map<string, Record<string, string>>();
  const prefix = randomBytes(3).toString('hex');
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
    desks: () => ['desk-1', 'desk-2'],
    deskOccupied: (d) => workers.some((w) => w.deskId === d),
    labels: () => ({}),
  };
  const bridges: OporaBridge[] = [];
  const open = async () => {
    const bridge = new OporaBridge(floor, dir, { update() {}, toast() {}, prompt: (id) => PROMPTS[id].text }, url);
    bridges.push(bridge);
    await bridge.poll();
    return bridge;
  };
  t.after(() => {
    for (const b of bridges) b.shutdown();
    opora.server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const settle = () => new Promise((r) => setTimeout(r, 100));
  const heartbeat = (b: OporaBridge) => (b as unknown as { heartbeat(): Promise<void> }).heartbeat();
  return { dir, opora, workers, envs, open, settle, heartbeat };
}

const claims = (calls: { op: string }[]) => calls.filter((c) => c.op === 'claim');

test('an office that restarts while a session holds its lease gives the worker its own name back and claims nothing anew', async (t) => {
  const f = await office(t);
  const before = await f.open();
  assert.equal(await before.take(CARD, 'Ana'), undefined);
  const { owner, token } = f.opora.leases.get(CARD)!;
  before.shutdown();
  // A new office process: nothing of the old one's sessions is left in memory.
  forgetSession(f.workers[0].id);
  const after = await f.open();
  await f.settle();
  assert.equal(childEnv(f.workers[0].id).OPORA_AGENT_NAME, owner, 'the relaunched worker reports under the same session');
  assert.equal(claims(f.opora.calls).length, 1, 'no new claim, under no name');
  const renewed = f.opora.calls.filter((c) => c.op === 'heartbeat').map((c) => c.token);
  assert.ok(renewed.every((x) => x === token), 'only the session’s own token is ever renewed');
  assert.equal(f.opora.leases.get(CARD)?.owner, owner, 'Opora still has the card under that session');
  after.onWorkerGone(f.workers[0].id);
  await f.settle();
  assert.equal(f.opora.leases.has(CARD), false, 'and the restarted office lets it go once the worker goes home');
});

test('a lease someone else took over is never claimed back, under any name, even once the card is free again', async (t) => {
  const f = await office(t);
  const bridge = await f.open();
  await bridge.take(CARD, 'Ana');
  // Taken over: the session's lease is gone, an outsider holds the card.
  f.opora.leases.set(CARD, { owner: 'outsider', token: randomBytes(32).toString('hex'), expires: Date.now() / 1000 + 900 });
  await f.heartbeat(bridge);
  assert.equal(childEnv(f.workers[0].id).OPORA_LEASE_TOKEN, undefined, 'a relaunch isn’t handed the dead token');
  // The outsider lets it go while the office's worker is still at it.
  f.opora.leases.delete(CARD);
  await bridge.repoll();
  assert.match((await bridge.take(CARD, 'Ana')) ?? '', /already on/);
  await f.heartbeat(bridge);
  assert.equal(claims(f.opora.calls).length, 1, 'the office claimed once, at the take');
  assert.equal(f.opora.calls.filter((c) => c.op === 'heartbeat').length, 1, 'one 409 ends the renewing');
});

test('the lease token reaches the worker only through its environment, never its prompt, which every client and workers.json get', { todo: 'blocker found by the pilot of #13: src/server/opora/bridge.ts:260 puts the token into the prompt (WorkerInfo.prompt)' }, async (t) => {
  const f = await office(t);
  const bridge = await f.open();
  await bridge.take(CARD, 'Ana');
  const { token } = f.opora.leases.get(CARD)!;
  assert.equal(f.envs.get(f.workers[0].id)!.OPORA_LEASE_TOKEN, token);
  assert.ok(!f.workers[0].prompt!.includes(token), 'WorkerInfo.prompt goes to every client (worker.update, welcome) and into workers.json');
});

test('the office keeps no lease token in .agent-office/opora.json', { todo: 'blocker found by the pilot of #13: src/server/opora/bridge.ts:517 persists runs[].token' }, async (t) => {
  const f = await office(t);
  const bridge = await f.open();
  await bridge.take(CARD, 'Ana');
  const { token } = f.opora.leases.get(CARD)!;
  bridge.shutdown();
  assert.ok(!readFileSync(path.join(f.dir, 'opora.json'), 'utf8').includes(token));
});

test('a worker that ends its turn without handing its stage in keeps the card: the same stage is not seated twice', { todo: 'blocker found by the pilot of #13: bridge.ts:331 lets the lease go on any done, and onCard (bridge.ts:300) then frees the card' }, async (t) => {
  const f = await office(t);
  const bridge = await f.open();
  await bridge.take(CARD, 'Ana');
  // It ends its turn with a question for whoever's at the terminal: the stage is still on turn.
  f.workers[0].status = 'done';
  bridge.onWorker(f.workers[0]);
  await f.settle();
  await bridge.repoll();
  const again = await bridge.take(CARD, 'Ana');
  assert.equal(f.workers.length, 1, `a second session was seated on the same stage (${again ?? 'taken'})`);
  assert.equal(claims(f.opora.calls).length, 1);
});

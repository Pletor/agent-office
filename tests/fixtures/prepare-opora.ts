// A fake Opora (the HTTP routes the bridge uses) and a bridge on a fake floor, for the preparation
// runner's tests (tests/harness-prepare.test.ts) and the crashing child (prepare-crash.ts). The leases
// are kept as Opora keeps them: a claim of a held card is 409, a release lets it go, so a test sees on
// Opora's side whether a failed take leaked one. A floor's workers can be kept in a file, so a worker
// seated by a child process that then died is still at its desk for the office that starts after it.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { OporaBridge, type BridgeEvents, type BridgeFloor } from '../../src/server/opora/bridge.js';
import { PROMPTS } from '../../src/shared/prompts.js';
import type { WorkerInfo } from '../../src/shared/protocol.js';

export interface FakeOpora {
  url: string;
  leases: Map<string, string>;
  calls: { path: string; body?: Record<string, unknown> }[];
  close(): Promise<void>;
}

/** Shop: one sector (Checkout) with two developer cards (c1, c2), its folder `dir`, in workspace `draft`. */
export async function fakeOpora(dir: string, leases = new Map<string, string>()): Promise<FakeOpora> {
  const calls: FakeOpora['calls'] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      calls.push({ path: url.pathname, body });
      const send = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      switch (url.pathname) {
        case '/': res.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY' }); return res.end('<!doctype html>');
        case '/api/health': return send(200, { status: 'ok' });
        case '/api/bootstrap': return send(200, { projects: [{ id: 'p1', name: 'Shop', sourcePath: dir }] });
        case '/api/project-workspaces': return send(200, { workspaces: [{ id: 'draft' }] });
        case '/api/view': return send(200, { graph: { nodes: [{ id: 's1', kind: 'sector', name: 'Checkout', parentId: null }, { id: 'c1', kind: 'node', name: 'Cart API', parentId: 's1' }, { id: 'c2', kind: 'node', name: 'Pay API', parentId: 's1' }] } });
        case '/api/desktop-v3/frontier':
          if (url.searchParams.get('nodeId') !== 's1') return send(200, { frontier: [{ id: 's1', name: 'Checkout' }] });
          return send(200, { frontier: [{ id: 'c1', name: 'Cart API', pipeline: { profile: 'code', current: null } }, { id: 'c2', name: 'Pay API', pipeline: { profile: 'code', current: null } }].filter((c) => !leases.has(c.id)) });
        case '/api/drawing': return send(200, { scene: { elements: [] }, revision: 1 });
        case '/api/storyboard': return send(200, { storyboard: null, revision: 1 });
        case '/api/desktop-v3/lease': {
          const node = String(body?.nodeId);
          if (body?.op === 'claim') {
            if (leases.has(node)) return send(409, { detail: 'held' });
            const token = `tok-${node}-${calls.length}`;
            leases.set(node, token);
            return send(200, { token, expiresAt: '2030-01-01T00:00:00Z' });
          }
          if (body?.op === 'release') {
            if (leases.get(node) !== body.token) return send(409, { detail: 'not your lease' });
            leases.delete(node);
          }
          return send(200, { ok: true });
        }
      }
      send(404, { detail: 'nope' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, leases, calls, close: () => new Promise((r) => server.close(() => r())) };
}

/** A floor whose workers are an array (kept in `file` when given, so they outlive a process); `seat` runs first and may refuse (a string) or throw. */
export function fakeFloor(dir: string, file?: string, seat?: (deskId: string, prompt: string) => string | undefined) {
  const workers: WorkerInfo[] = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const save = () => { if (file) writeFileSync(file, JSON.stringify(workers)); };
  const floor: BridgeFloor = {
    id: 'shop', dir,
    list: () => workers,
    seat(deskId, by, prompt) {
      if (seat) { const r = seat(deskId, prompt); if (typeof r === 'string') return r; }
      const w = { id: `w${workers.length}-${process.pid}`, deskId, kind: 'agent', prompt, name: `Worker ${workers.length}`, color: '#fff', status: 'working', acked: false, createdBy: by, createdAt: Date.now(), cols: 80, rows: 24, viewers: [], viewerIds: [] } as WorkerInfo;
      workers.push(w);
      save();
      return w;
    },
    desks: () => ['desk-1', 'desk-2', 'desk-3'],
    deskOccupied: (d) => workers.some((w) => w.deskId === d),
    labels: () => ({}),
  };
  return { floor, workers, save };
}

/** A bridge on `floor` reading the fake Opora at `url`, with the office state in `stateDir`. */
export function bridgeOn(floor: BridgeFloor, stateDir: string, url: string, events: Pick<BridgeEvents, 'prepareTask' | 'recoverRuns'>) {
  const toasts: string[] = [];
  const bridge = new OporaBridge(floor, stateDir, { ...events, update: () => undefined, toast: (x) => void toasts.push(x), prompt: (id) => PROMPTS[id].text }, url);
  return { bridge, toasts };
}

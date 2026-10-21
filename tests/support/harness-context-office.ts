// An office with four floors for the library's context (docs/harness.md "Choosing the context"), the
// real harness routes over stub Opora windows: no Opora server, no workers, no 3D.
//   ample      bound to Opora project "Ample" (p-ample / w-ample), its canvas a page › layer › area › sector › task
//   tajemstvi  bound to Opora project "Tajemství opory" (p-tajemstvi / w-tajemstvi), another canvas with its own names
//   loose      never bound (its window reads a project, but nobody bound the floor)
//   dark       bound, but its Opora isn't answering
// Each checkout publishes its own project element under .harness/, named after the project, so a leak of
// one project's element, slot or node into the other's view is visible by name.
// Used in-process by tests/harness-context.test.ts and as a child process by tests/fixtures/harness-context-office.ts.
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Ctx } from '../../src/server/office/context.js';
import { requestHandler } from '../../src/server/http/router.js';
import { harnessBindingRoute, harnessProfileRoute, harnessRoute } from '../../src/server/http/routes/harness.js';
import { harnessContextRoutes } from '../../src/server/http/routes/harness-context.js';
import { harnessElementRoute } from '../../src/server/harness/element-api.js';
import { HarnessBindings } from '../../src/server/harness/bindings.js';

export interface StubNode { id: string; kind: string; name: string; parentId: string | null; memberOf?: string }

/** A canvas: a root sector, a page, a layer, an area, a sector (member of the area) and a task, each named after `tag`. */
export function canvas(tag: string, prefix: string): StubNode[] {
  return [
    { id: prefix + '-root', kind: 'sector', name: tag, parentId: null },
    { id: prefix + '-page', kind: 'node', name: tag + ' page', parentId: prefix + '-root' },
    { id: prefix + '-layer', kind: 'node', name: '[vrstva 01] ' + tag + ' layer', parentId: prefix + '-page' },
    { id: prefix + '-area', kind: 'area', name: tag + ' area', parentId: prefix + '-layer' },
    { id: prefix + '-sector', kind: 'sector', name: tag + ' sector', parentId: prefix + '-layer', memberOf: prefix + '-area' },
    { id: prefix + '-task', kind: 'node', name: tag + ' task', parentId: prefix + '-sector' },
    { id: prefix + '-task2', kind: 'node', name: tag + ' second task', parentId: prefix + '-sector' },
  ];
}

export const PROJECTS = {
  ample: { project: 'p-ample', workspace: 'w-ample', name: 'Ample', prefix: 'am' },
  tajemstvi: { project: 'p-tajemstvi', workspace: 'w-tajemstvi', name: 'Tajemství opory', prefix: 'ta' },
} as const;

/** The office: its data directory, its floors' stub Opora windows (to take down or drift), a request function and `close`. */
export async function contextOffice(opts: { port?: number; session?: (req: http.IncomingMessage) => unknown } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'harness-context-'));
  const all = Object.values(PROJECTS).map((p) => ({ id: p.project, name: p.name }));
  const floors = new Map<string, unknown>();
  const windows: Record<string, { connected: boolean; error?: string; project: { id: string; name: string } | null; workspace: string | null; nodes: StubNode[] }> = {};
  const add = (id: string, name: string, project: { id: string; name: string } | null, workspace: string | null, nodes: StubNode[], connected = true) => {
    const dir = path.join(dataDir, 'checkouts', id);
    mkdirSync(path.join(dir, '.harness', 'instructions'), { recursive: true });
    writeFileSync(path.join(dir, '.harness', 'instructions', id + '-rules.md'), `# ${name} house rules\n\nOnly for the ${name} project.\n`);
    windows[id] = { connected, project, workspace, nodes };
    const w = windows[id];
    floors.set(id, {
      id, dir, info: () => ({ name }),
      opora: { view: () => ({ connected: w.connected, error: w.error, project: w.project, workspace: w.workspace, projects: all, cards: w.nodes.filter((n) => n.kind === 'node').map((n) => ({ id: n.id, name: n.name })) }), canvasNodes: () => w.nodes, freshCanvasNodes: async () => w.nodes },
      workers: { authenticate: () => undefined }, planning: { state: () => ({ current: undefined }) },
    });
    return dir;
  };
  const ample = add('ample', 'ample-shop', { id: PROJECTS.ample.project, name: PROJECTS.ample.name }, PROJECTS.ample.workspace, canvas('Ample', PROJECTS.ample.prefix));
  const tajemstvi = add('tajemstvi', 'tajemstvi-opory', { id: PROJECTS.tajemstvi.project, name: PROJECTS.tajemstvi.name }, PROJECTS.tajemstvi.workspace, canvas('Tajemství', PROJECTS.tajemstvi.prefix));
  add('loose', 'loose-repo', { id: PROJECTS.ample.project, name: PROJECTS.ample.name }, PROJECTS.ample.workspace, canvas('Loose', 'lo'));
  const dark = add('dark', 'dark-repo', null, null, [], false);
  windows.dark.error = 'connect ECONNREFUSED';
  const bindings = new HarnessBindings(dataDir);
  await bindings.bind('ample', ample, { project: PROJECTS.ample.project, workspace: PROJECTS.ample.workspace }, 'fixture');
  await bindings.bind('tajemstvi', tajemstvi, { project: PROJECTS.tajemstvi.project, workspace: PROJECTS.tajemstvi.workspace }, 'fixture');
  await bindings.bind('dark', dark, { project: 'p-dark', workspace: 'w-dark' }, 'fixture');
  const ctx = {
    cfg: { dataDir, port: 0 }, floors,
    accounts: { get: (id: string) => ({ role: id.startsWith('admin') ? 'admin' : 'member' }) },
    // The shared-password session (an administrator) unless the caller says otherwise; a request with
    // `x-test-role: member` is a named member's (the editor's browser test opens a read-only page that way).
    auth: { fromRequest: opts.session ?? ((req: http.IncomingMessage) => (req.headers['x-test-role'] === 'member' ? { account: { id: 'member-mia', role: 'member' } } : {})) },
    workerFloor: () => undefined,
  } as unknown as Ctx;
  const handler = requestHandler(ctx, [harnessRoute, harnessProfileRoute, harnessBindingRoute, harnessContextRoutes.projects, harnessContextRoutes.tree, harnessElementRoute]);
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  ctx.cfg.port = (server.address() as { port: number }).port;
  const base = 'http://127.0.0.1:' + ctx.cfg.port;
  return {
    base, dataDir, windows,
    call: (url: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + url, {
      method: body ? 'POST' : 'GET', headers: { origin: base, 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    close() { server.close(); server.closeAllConnections(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OporaBridge, type BridgeFloor, type BridgeEvents } from '../src/server/opora/bridge.js';
import { HarnessProfiles } from '../src/server/harness/profiles.js';
import { harnessHandoff } from '../src/server/harness/handoff.js';
import { oporaHarnessTask } from '../src/shared/harness-cascade.js';
import { OPORA_ESCAPE_WINDOW_MS, browserOporaUrl, canEmbedOpora, cardGroup, deskFor, oporaCanvasUrl, oporaEmbedPolicy, oporaEscapeLeaves, sameDir, signGroup } from '../src/shared/opora.js';
import { PROMPTS } from '../src/shared/prompts.js';
import { oporaCardViews } from '../src/server/opora/sketches.js';
import { configureRea, reaFor } from '../src/server/rea/index.js';
import { queueFeedback, readNotes } from '../src/server/opora/ticket-feedback.js';
import type { OporaState, WorkerInfo } from '../src/shared/protocol.js';

test('Opora dispatch embeds effective harness and refuses a missing resource before claiming', async (t) => {
  let root = '';
  const f = await fixture(t, (project, workspace, card) => harnessHandoff(root, root, oporaHarnessTask(project, workspace, card), false));
  root = f.dir;
  const profiles = new HarnessProfiles(root);
  await profiles.save(root, '', 'global', { language: { value: 'en' } }, 0);
  await profiles.save(root, oporaHarnessTask('p1', 'draft', 'c2'), 'task', { language: { value: 'cs' } }, 1);
  assert.equal(await ticketFor(f, 'c2'), undefined);
  assert.match(f.workers[0].prompt!, /"value": "cs"/);
  assert.match(f.workers[0].prompt!, /Snapshot SHA-256/);
  await profiles.save(root, '', 'repository', { missing: { resource: 'missing' } }, 2);
  assert.match((await ticketFor(f, 'c1'))!, /unavailable/);
  assert.equal(f.op.leases.has('c1'), false);
  assert.equal(f.workers.length, 1);
});

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

/** A small stand-in for Opora's API: a project planning `dir` with a sector of two cards, another project elsewhere with one card, and leases. */
/** `?assignment=omit` (Opora M2): the lease without its assignment, with the assignment's context pin. */
function lean(lease: Record<string, unknown>, url: URL) {
  if (url.searchParams.get('assignment') !== 'omit') return lease;
  const { assignment, ...rest } = lease;
  return { ...rest, contextVersion: (assignment as Record<string, unknown>).contextVersion };
}

function fakeOpora(dir: string) {
  const calls: { method: string; path: string; body?: Record<string, unknown>; headers: http.IncomingHttpHeaders }[] = [];
  const leases = new Map<string, string>();
  const executions = new Map<string, Record<string, unknown>>();
  // Plan-step cards (accepted `spec.steps`, no routed pipeline) that Canvas's agent-state offers a ready claim for.
  const stepCards: { id: string; name: string }[] = [];
  // Ready plan-step cards outside every sector (the heart laid them out by the architecture): no frontier lists them.
  const looseCards: { id: string; name: string }[] = [];
  // More of agent-state (stages, decisions, cards), as a test sets it: a Canvas waiting on a person.
  const agentState: Record<string, unknown> = {};
  // Opora's page refuses to be framed, as it does until its embed_origins lists someone.
  const page: { headers: Record<string, string> } = { headers: { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'" } };
  // Shop's workspaces; a test adds `main` and a work one (`work1`, with a card of its own).
  const workspaces: { id: string; label?: string }[] = [{ id: 'draft' }];
  // The projects whose brain gate is on (OPORA's heart plans them); none by default.
  const heartOn = new Set<string>();
  // The workspace of the heart's last accepted plan, per project (heart/status `activeWorkspace`).
  const heartWorkspace = new Map<string, string>();
  // OPORA's brain gate (ticket-gate.ts): the tickets the heart issued, and each session the office opened.
  const gate = { tickets: [] as Record<string, any>[], sessions: [] as string[], refuseClaim: undefined as string | undefined };
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
      if (url.pathname === '/api/gate/sessions') {
        const token = `gt-${gate.sessions.length}-${'x'.repeat(24)}`;
        gate.sessions.push(token);
        return send(201, { sessionId: `gs-${gate.sessions.length}`, token, expiresAt: '2030-01-01T00:00:00Z' });
      }
      if (url.pathname === '/api/gate/requests') {
        const token = String(req.headers['x-opora-gate-token'] ?? '');
        if (!gate.sessions.includes(token)) return send(401, { code: 'gate_token_invalid', error: 'no session' });
        const b = (body?.body ?? {}) as Record<string, any>;
        const t = gate.tickets.find((x) => x.ticketId === b.ticketId);
        const answer = (a: unknown) => send(201, { ticketId: 'gt_req', seq: 1, kind: body?.kind, status: 'answered', answer: a });
        switch (body?.kind) {
          case 'ticket.request': {
            const held = gate.tickets.find((x) => x.session === token && ['claimed', 'in_progress', 'needs_answer', 'delivered'].includes(x.status));
            const found = held ?? gate.tickets.find((x) => x.status === 'issued');
            return answer({ ticket: found ? { ticketId: found.ticketId, status: found.status, body: found.body, machine: found.machine, feedback: found.feedback } : null, held: !!held });
          }
          case 'ticket.claim':
            if (!t) return send(404, { code: 'ticket_not_found' });
            // A new session of the holder takes a held ticket back for the same execution; anyone else is refused.
            if (t.status !== 'issued' && t.executionId === b.executionId) { t.session = token; return answer({ ticket: t }); }
            if (t.status !== 'issued') return send(409, { code: 'ticket_not_held', error: 'held by another' });
            if (gate.refuseClaim) return send(409, { code: gate.refuseClaim, error: 'refused' });
            if (!executions.has(String(b.executionId))) return send(409, { code: 'ticket_execution', error: 'no such execution' });
            Object.assign(t, { status: 'claimed', session: token, executionId: b.executionId });
            return answer({ ticket: t });
          case 'ticket.release':
            if (!t || t.session !== token) return send(409, { code: 'ticket_not_held' });
            Object.assign(t, { status: 'issued', session: undefined, executionId: undefined });
            return answer({ ticket: { ticketId: t.ticketId, status: 'issued' } });
          case 'ticket.feedback':
            if (!t || t.session !== token) return send(409, { code: 'ticket_not_held' });
            t.feedback.push({ feedbackId: `tf_${t.feedback.length}`, kind: b.kind, text: b.text, answer: null });
            t.status = b.kind === 'question' ? 'needs_answer' : 'in_progress';
            return answer({ ticket: { ticketId: t.ticketId, status: t.status } });
          case 'ticket.deliver':
            if (!t || t.session !== token) return send(409, { code: 'ticket_not_held' });
            if (t.status === 'needs_answer') return send(409, { code: 'ticket_state', error: 'open question' });
            Object.assign(t, { status: 'delivered', delivery: { summary: b.summary, sha: b.sha } });
            return answer({ ticket: { ticketId: t.ticketId, status: 'delivered' } });
        }
        return send(422, { code: 'invalid_payload' });
      }
      if (url.pathname === '/api/oporahub/executions/context') return send(200, { available: true, acceptedHead: 'a'.repeat(40), contextVersion: 'ctx' });
      if (url.pathname === '/api/oporahub/executions/claim') {
        const node = String(body?.nodeId);
        if (leases.has(node)) return send(409, {});
        const lease = { executionId: 'ex-' + node, project: body?.project, workspace: body?.workspace, nodeId: node,
          token: 'tok-' + node, epoch: 1, acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64),
          assignment: { acceptedRevision: 'a'.repeat(40), contextVersion: 'ctx', documents: { [node]: 'Accepted task' }, specification: {} },
          serverNow: Date.now() / 1000, expiresAt: Date.now() / 1000 + 900, state: 'running' };
        leases.set(node, String(lease.token)); executions.set(lease.executionId, lease);
        return send(200, lean(lease, url));
      }
      if (url.pathname.startsWith('/api/oporahub/executions/ex-')) {
        const id = url.pathname.split('/')[4];
        const lease = executions.get(id);
        if (lease && req.method === 'GET' && url.pathname.endsWith('/assignment')) {
          if (req.headers['x-opora-execution-token'] !== lease.token) return send(409, {});
          const { token: _token, serverNow: _now, expiresAt: _expires, state: _state, ...read } = lease;
          return send(200, { ...read, progress: { total: 0, done: 0, current: null, steps: [] } });
        }
        if (!lease || body?.token !== lease.token || body?.epoch !== lease.epoch) return send(409, {});
        if (url.pathname.endsWith('/release')) { leases.delete(String(lease.nodeId)); return send(200, { state: 'released' }); }
        return send(200, lean({ ...lease, serverNow: Date.now() / 1000, expiresAt: Date.now() / 1000 + 900 }, url));
      }
      // The other project's canvas: one sector with one card.
      if (url.searchParams.get('project') === 'other') {
        if (url.pathname === '/api/view') return send(200, { graph: { nodes: [{ id: 's9', kind: 'sector', name: 'Elsewhere', parentId: null }, { id: 'c9', kind: 'node', name: 'Other card', parentId: 's9' }] } });
        if (url.pathname === '/api/oporahub/agent-state') return send(200, { actions: [{ verb: 'claim', status: 'ready', targetId: 'c9' }] });
      }
      // Shop's work workspace: a sector with one card, planned there and not in main.
      if (url.searchParams.get('workspace') === 'work1') {
        if (url.pathname === '/api/view') return send(200, { graph: { nodes: [{ id: 's5', kind: 'sector', name: 'Oracle', parentId: null }, { id: 'c5', kind: 'node', name: 'Oracle card', parentId: 's5' }] } });
        if (url.pathname === '/api/oporahub/agent-state') return send(200, { actions: leases.has('c5') ? [] : [{ verb: 'claim', status: 'ready', targetId: 'c5' }] });
      }
      switch (url.pathname) {
        case '/api/health':
          return send(200, { status: 'ok' });
        case '/api/brain/gate-setting':
          return send(200, { project: url.searchParams.get('project'), enabled: heartOn.has(String(url.searchParams.get('project'))) });
        case '/api/brain/heart/status':
          return send(200, { project: url.searchParams.get('project'), activeWorkspace: heartWorkspace.get(String(url.searchParams.get('project'))) ?? null });
        case '/api/bootstrap':
          return send(200, { projects });
        case '/api/project-workspaces':
          return send(200, { workspaces });
        case '/api/view':
          return send(200, { graph: { nodes: [{ id: 'a1', kind: 'area', name: 'Frontend' }, { id: 's1', kind: 'sector', name: 'Checkout', parentId: null }, { id: 'c1', kind: 'node', name: 'Cart page', parentId: 's1' }, { id: 'c2', kind: 'node', name: 'Pay API', parentId: 's1' }, ...stepCards.map((c) => ({ ...c, kind: 'node', parentId: 's1' })), ...looseCards.map((c) => ({ ...c, kind: 'node', parentId: null }))] } });
        case '/api/oporahub/agent-state':
          return send(200, { actions: [{ id: 'c1' }, { id: 'c2' }, ...stepCards, ...looseCards].map((c) => ({ verb: 'claim', status: leases.has(c.id) ? 'blocked' : 'ready', targetId: c.id })), ...agentState });
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
  return { server, calls, leases, gate, projects, page, workspaces, stepCards, looseCards, agentState, heartOn, heartWorkspace };
}

async function fixture(t: { after(fn: () => void): void }, prepareTask?: BridgeEvents['prepareTask']) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-opora-'));
  const op = fakeOpora(dir);
  await new Promise<void>((r) => op.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(op.server.address() as AddressInfo).port}`;
  const workers: WorkerInfo[] = [];
  const toasts: string[] = [];
  const relinks: number[] = [];
  let state: OporaState | undefined;
  const floor: BridgeFloor = {
    id: 'shop',
    dir,
    list: () => workers,
    stop: async id => { const worker = workers.find(w => w.id === id); if (worker) worker.status = 'exited'; },
    seat(deskId, by, prompt) {
      const w = { id: `w${workers.length}`, deskId, kind: 'agent', prompt, name: `Worker ${workers.length}`, color: '#fff', status: 'working', acked: false, createdBy: by, createdAt: Date.now(), cols: 80, rows: 24, viewers: [], viewerIds: [] } as WorkerInfo;
      workers.push(w);
      return w;
    },
    desks: () => ['desk-1', 'desk-2', 'desk-3'],
    deskOccupied: (d) => workers.some((w) => w.deskId === d),
    labels: () => ({ 'desk-3': { text: 'Design', color: '#000', by: 'a', at: 0 } }),
  };
  const bridge = new OporaBridge(floor, dir, { prepareTask, update: (s) => void (state = s), relinked: () => void relinks.push(Date.now()), toast: (x) => void toasts.push(x), prompt: (id) => PROMPTS[id].text }, url);
  t.after(() => {
    bridge.shutdown();
    op.server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await bridge.poll();
  return { bridge, floor, op, workers, toasts, relinks, url, dir, state: () => state! };
}

test('bridge prepares the selected desk before claiming and starts through the Opora seating wrapper', async t => {
  const f = await fixture(t), seat = f.floor.seat;
  configureRea(f.dir, undefined, { AGENT_OFFICE_REA: 'opora' }); t.after(() => configureRea(f.dir, undefined, {}));
  f.floor.seat = () => { throw new Error('legacy seating must not run'); };
  let prepared = false;
  f.floor.prepareWorker = async (deskId, by, owner) => {
    assert.equal(deskId, 'desk-1'); assert.equal(by, 'Ana'); assert.equal(owner, 'owner');
    assert.equal(f.op.calls.some(c => c.path === '/api/oporahub/executions/claim'), false);
    prepared = true;
    const signal = new AbortController().signal;
    return { worker: {} as WorkerInfo, cwd: f.dir, signal, prepare: operation => operation(f.dir, signal),
      start(prompt) {
        assert.equal(prepared, true); assert.equal(f.op.leases.has('c2'), true);
        const worker = seat(deskId, by, prompt, owner); assert.notEqual(typeof worker, 'string');
        if (typeof worker !== 'string') assert.equal(reaFor(worker), true);
        return worker;
      }, cancel: async () => { throw new Error('successful reservation must not be cancelled'); } };
  };
  f.floor.orchestrator = () => ({ by: 'Ana', owner: 'owner' });
  assert.equal(await ticketFor(f, 'c2'), undefined);
  assert.equal(f.workers.length, 1); assert.equal(f.state().runs[0].state, 'working');
});

test('the bridge links the Opora project that plans this floor’s folder, and reads the ready cards in their sectors', async (t) => {
  const f = await fixture(t);
  const s = f.state();
  assert.equal(s.connected, true);
  assert.equal(s.error, undefined);
  assert.deepEqual(s.project, { id: 'p1', name: 'Shop' });
  assert.equal(s.workspace, 'draft');
  assert.deepEqual(s.sectors, [{ id: 's1', name: 'Checkout' }]);
  assert.deepEqual(s.cards.map((c) => [c.name, c.status, c.group, c.sectorName]), [['Cart page', 'frontier', 'dev', 'Checkout'], ['Pay API', 'frontier', 'dev', 'Checkout']]);
});

test('a ticket claims its card’s execution on Opora and seats a worker for it, a design ticket at the Design desk', async (t) => {
  const f = await fixture(t);
  assert.equal(await ticketFor(f, 'c1', { profile: 'design' }), undefined);
  const claim = f.op.calls.find((c) => c.path === '/api/oporahub/executions/claim')!;
  assert.deepEqual({ project: claim.body!.project, workspace: claim.body!.workspace, nodeId: claim.body!.nodeId }, { project: 'p1', workspace: 'draft', nodeId: 'c1' });
  assert.match(String(claim.headers['x-opora-actor']), /^agent; name=office-shop/);
  assert.equal(f.workers[0].deskId, 'desk-3');
  assert.doesNotMatch(f.workers[0].prompt!, /tok-c1/);
  assert.match(f.workers[0].prompt!, /immutable Canvas assignment/);
  assert.doesNotMatch(JSON.stringify(f.state()), /tok-c1|assignmentDigest/);
  const run = f.state().runs[0];
  assert.equal(run.cardName, 'Cart page');
  assert.equal(run.state, 'working');
  assert.equal((run as unknown as { token?: string }).token, undefined, 'the lease token stays on the server');
  // The developer's card goes to an unsigned desk.
  assert.equal(await ticketFor(f, 'c2'), undefined);
  assert.equal(f.workers[1].deskId, 'desk-1');
  assert.doesNotMatch(f.workers[1].prompt!, /design card/);
});

test('a worker going home lets its card’s lease go', async (t) => {
  const f = await fixture(t);
  await ticketFor(f, 'c2');
  assert.ok(f.op.leases.has('c2'));
  f.workers[0].status = 'done';
  f.bridge.onWorker(f.workers[0]);
  assert.equal(f.state().runs[0].state, 'done');
  f.bridge.onWorkerGone(f.workers[0].id);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(f.op.leases.has('c2'), false);
  assert.equal(f.state().runs[0].state, 'gone');
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
});

test('a floor linked to a project by choice reads that project’s cards, and unlinking goes back to its folder’s', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.state().projects, [{ id: 'other', name: 'Other' }, { id: 'p1', name: 'Shop' }]);
  assert.equal(f.state().linkedBy, 'folder');
  // Linking the project it's on already moves nothing; another project says it moved (the orchestrator lets its card go).
  assert.equal(f.bridge.link('p1'), undefined);
  assert.equal(f.relinks.length, 0);
  assert.equal(f.bridge.link('other'), undefined);
  assert.equal(f.relinks.length, 1);
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
  await ticketFor(f, 'c2');
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

test('design and development workers use accepted assignments without live legacy briefs', async (t) => {
  const f = await fixture(t);
  assert.equal(await ticketFor(f, 'c1', { profile: 'design' }), undefined);
  assert.equal(await ticketFor(f, 'c2'), undefined);
  for (const worker of f.workers) {
    assert.match(worker.prompt!, /immutable Canvas assignment/);
    assert.match(worker.prompt!, /execution-worker/);
    assert.doesNotMatch(worker.prompt!, /tok-c|POST.*agent-output/);
  }
  // Only the design card's sketches are read, and only its worker gets the design addendum.
  const [design, dev] = f.workers;
  assert.match(design.prompt!, /Design references for this card/);
  assert.match(design.prompt!, /a storyboard \(animation "kod"\) with 2 moments, 1 sketched, 1 waiting on a reply/);
  assert.match(design.prompt!, /\/api\/storyboard\?project=p1&workspace=draft&nodeId=c1/);
  assert.match(design.prompt!, /no DESIGN\.md yet[\s\S]*design\/proposals\/c1\/DESIGN\.md/);
  assert.match(design.prompt!, /at most 8 PNGs/);
  assert.doesNotMatch(dev.prompt!, /Design references|opora_read|DESIGN\.md/);
  assert.equal(f.op.calls.filter(c => c.path === '/api/drawing').length, 1);
  assert.equal(f.op.calls.filter(c => c.path === '/api/storyboard').length, 1);
});

test('with 🔬 REA on for Opora, a card’s worker gets REA and is told how to use it; with it off, neither', async (t) => {
  const f = await fixture(t);
  configureRea(f.dir, undefined, {});
  assert.equal(await ticketFor(f, 'c2'), undefined);
  assert.equal(reaFor(f.workers[0]), false);
  assert.doesNotMatch(f.workers[0].prompt!, /"rea" MCP server/);
  configureRea(f.dir, undefined, { AGENT_OFFICE_REA: 'opora' });
  t.after(() => configureRea(f.dir, undefined, {}));
  assert.equal(await ticketFor(f, 'c1'), undefined);
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
  assert.equal(await ticketFor(f, 'c5'), undefined);
  const claim = f.op.calls.find((c) => c.path === '/api/oporahub/executions/claim')!;
  assert.deepEqual({ project: claim.body!.project, workspace: claim.body!.workspace, nodeId: claim.body!.nodeId }, { project: 'p1', workspace: 'work1', nodeId: 'c5' });
  // Lean claim: the assignment is read once, with the token in its header and never in the query.
  const reads = f.op.calls.filter((c) => c.path === '/api/oporahub/executions/ex-c5/assignment');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].method, 'GET');
  assert.equal(reads[0].headers['x-opora-execution-token'], 'tok-c5');
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
  await ticketFor(f, 'c5');
  assert.equal(f.state().runs[0].workspace, 'work1');
  // The floor moves to main while the card is still being worked on.
  f.bridge.useWorkspace(null);
  await f.bridge.repoll();
  assert.equal(f.state().workspace, 'main');
  const saved = JSON.parse(readFileSync(path.join(f.dir, 'opora.json'), 'utf8'));
  await f.bridge.executions.client.heartbeat(saved.runs[0].execution, 900);
  const beat = f.op.calls.find((c) => c.path.endsWith('/heartbeat'))!;
  assert.equal(beat.body!.workspace, 'work1');
  f.bridge.onWorkerGone(f.workers[0].id);
  await new Promise((r) => setTimeout(r, 100));
  const release = f.op.calls.find((c) => c.path.endsWith('/release'))!;
  assert.equal(release.body!.workspace, 'work1');
  assert.match(release.path, /ex-c5/);
  assert.equal(f.op.leases.has('c5'), false);
});

test('a legacy saved worker without execution authority cannot resume', async (t) => {
  const f = await fixture(t);
  await ticketFor(f, 'c2');
  delete (f.bridge as unknown as { runs: { execution?: unknown }[] }).runs[0].execution;
  const reason = await f.bridge.executions.guard.restore(f.workers[0]);
  assert.match(reason!, /could not be revalidated/);
  assert.equal(f.workers[0].status, 'exited');
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

test('while Opora waits on a person to accept the baseline, the floor says so until it is accepted', async (t) => {
  const f = await fixture(t);
  assert.equal(f.state().humanWait, undefined, 'nothing waits on a person: no notice');
  Object.assign(f.op.agentState, {
    stages: [{ id: 'plan', count: 184, health: 'blocking', reason: 'no_accepted_baseline' }, { id: 'claim', count: 0, health: 'ok', reason: 'nothing_ready' }],
    decisions: [{ id: 'd1', kind: 'accept_baseline', title: 'Přijmout výchozí zadání', actionId: 'a1' }],
    actions: [{ id: 'a1', verb: 'accept_baseline', status: 'blocked', blockReason: 'human_only' }],
    cards: [{ nodeId: 'c1', health: 'blocking', reason: 'no_accepted_baseline' }, { nodeId: 'c2', health: 'blocking', reason: 'no_accepted_baseline' }],
  });
  await f.bridge.poll();
  const w = f.state().humanWait!;
  assert.deepEqual(w.decisions, [{ kind: 'accept_baseline', title: 'Přijmout výchozí zadání' }]);
  assert.equal(w.cards, 2);
  assert.equal(w.claimsBlocked, true);
  // Accepted in Opora: the notice goes.
  for (const k of Object.keys(f.op.agentState)) delete f.op.agentState[k];
  await f.bridge.poll();
  assert.equal(f.state().humanWait, undefined);
});

/** What OPORA's wall lets an agent write in a project its heart plans (Opora's determinism/wall.py LANE). */
const WALL_LANE = ['/api/oporahub/executions', '/api/oporahub/process-events', '/api/oporahub/execution-observers', '/api/oporahub/harness-',
  '/api/oporahub/github-evidence', '/api/oporahub/review-jobs', '/api/oporahub/review-identities/claim', '/api/oporahub/verifications',
  '/api/desktop-v3/agent-output', '/api/desktop-v3/agent-messages', '/api/desktop-v3/agent-message-receipt', '/api/desktop-v3/agent-workspace', '/api/desktop-v3/lease'];
const inLane = (p: string) => p.startsWith('/api/gate/') || WALL_LANE.some((x) => (x.endsWith('-') ? p.startsWith(x) : p === x || p.startsWith(x + '/')));

test('the bridge says when OPORA’s heart plans the linked project, read again with the canvas', async (t) => {
  const f = await fixture(t);
  assert.equal(f.state().heart, false);
  assert.ok(f.op.calls.some((c) => c.method === 'GET' && c.path === '/api/brain/gate-setting'));
  f.op.heartOn.add('p1');
  await f.bridge.repoll();
  assert.equal(f.state().heart, true);
  // Another project, not planned by the heart.
  assert.equal(f.bridge.link('other'), undefined);
  await f.bridge.repoll();
  assert.equal(f.state().heart, false);
});

test('the floor follows the workspace of the heart’s last plan, unless a person pinned another', async (t) => {
  const f = await fixture(t);
  f.op.workspaces.push({ id: 'main' }, { id: 'work1', label: 'Work 1' });
  f.op.heartOn.add('p1');
  // No plan yet (null): the old behaviour, main.
  await f.bridge.repoll();
  assert.equal(f.state().workspace, 'main');
  assert.equal(f.state().followHeart, false);
  // The heart plans in work1: the floor follows.
  f.op.heartWorkspace.set('p1', 'work1');
  await f.bridge.repoll();
  assert.equal(f.state().workspace, 'work1');
  assert.equal(f.state().followHeart, true);
  assert.equal(f.state().workspaceBy, 'heart');
  // A pinned workspace wins.
  assert.equal(f.bridge.useWorkspace('main'), undefined);
  await f.bridge.repoll();
  assert.equal(f.state().workspace, 'main');
  assert.equal(f.state().followHeart, false);
  assert.equal(f.state().workspaceBy, 'choice');
  // Back to the default: follows the heart again.
  assert.equal(f.bridge.useWorkspace(null), undefined);
  await f.bridge.repoll();
  assert.equal(f.state().workspace, 'work1');
  // Heart off: the workspace the heart named is ignored.
  f.op.heartOn.delete('p1');
  await f.bridge.repoll();
  assert.equal(f.state().workspace, 'main');
  assert.equal(f.state().followHeart, false);
});

test('an Opora without the brain (gate-setting 404) is planned the old way', async (t) => {
  const f = await fixture(t);
  f.op.server.removeAllListeners('request');
  const { server: plain } = fakeOpora(f.dir);
  f.op.server.on('request', (req, res) => {
    if (req.url?.startsWith('/api/brain/') || req.url?.startsWith('/api/gate/')) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"detail":"Not Found"}'); }
    plain.emit('request', req, res);
  });
  await f.bridge.repoll();
  assert.equal(f.state().connected, true);
  assert.equal(f.state().heart, false);
});

test('in a project the heart plans, taking a ticket and letting it go writes only in the wall’s lane', async (t) => {
  const f = await fixture(t);
  f.op.heartOn.add('p1');
  await f.bridge.repoll();
  assert.equal(await ticketFor(f, 'c2'), undefined);
  f.bridge.onWorkerGone(f.workers[0].id);
  await new Promise((r) => setTimeout(r, 50));
  const writes = f.op.calls.filter((c) => c.method !== 'GET' && c.method !== 'HEAD').map((c) => c.path);
  assert.ok(writes.some((p) => p === '/api/oporahub/executions/claim'));
  assert.deepEqual(writes.filter((p) => !inLane(p)), []);
});

test('a critical card by Opora gauge carries its review mark', async (t) => {
  const f = await fixture(t);
  Object.assign(f.op.agentState, { cards: [
    { nodeId: 'c2', gauge: { run: { label: 'XL', effort: 'xhigh', model: 'sonnet', advisor: 'opus', handout: false, humanReview: false } } },
    { nodeId: 'c1', gauge: { run: { label: 'S', effort: 'medium', model: 'sonnet', advisor: 'opus', handout: true, humanReview: true } } },
  ] });
  t.after(() => { delete f.op.agentState.cards; });
  await f.bridge.poll();
  const cards = f.state().cards;
  assert.equal(cards.find((c) => c.id === 'c1')?.run?.humanReview, true);
});

/** A ticket OPORA's heart issued for card c2 (Canvas docs/navrhy/2026-11-03-novy-zaklad.md §3.3). */
const issued = () => ({ ticketId: 'tk_1', status: 'issued', feedback: [] as Record<string, unknown>[],
  body: { essence: 'Customers pay in one step', build: 'The Pay API endpoint', openPaths: ['Refunds come later'], cautions: ['No card data in logs'], skills: ['/ponytail@5.3.3'], doneCriteria: ['npm test is green'] },
  machine: { cardId: 'c2', executionId: null, cardVersion: 3 } });
const gateKinds = (f: { op: { calls: { path: string; body?: Record<string, unknown> }[] } }) => f.op.calls.filter((c) => c.path === '/api/gate/requests').map((c) => c.body?.kind);

/** OPORA's heart issues a ticket for `cardId` and the office takes it at the next poll; resolves to why it wasn't taken, if it wasn't. */
async function ticketFor(f: Awaited<ReturnType<typeof fixture>>, cardId: string, machine: Record<string, unknown> = {}) {
  const before = f.toasts.length;
  f.op.gate.tickets.push({ ...issued(), ticketId: `tk_${cardId}`, machine: { cardId, executionId: null, cardVersion: 1, ...machine } });
  await f.bridge.poll();
  return f.toasts.slice(before).find((x) => /wasn't taken/.test(x));
}

test('a ticket from the gate: the card’s execution starts, the ticket is claimed for it, and a worker sits down with the ticket’s body', async (t) => {
  const f = await fixture(t);
  f.op.gate.tickets.push(issued());
  await f.bridge.poll();
  const claimAt = f.op.calls.findIndex((c) => c.path === '/api/oporahub/executions/claim');
  const ticketAt = f.op.calls.findIndex((c) => c.path === '/api/gate/requests' && c.body?.kind === 'ticket.claim');
  assert.ok(claimAt >= 0 && ticketAt > claimAt, 'the execution starts first, then the ticket is claimed');
  assert.deepEqual(f.op.calls[ticketAt].body!.body, { ticketId: 'tk_1', executionId: 'ex-c2' });
  assert.equal(f.op.gate.tickets[0].status, 'claimed');
  assert.equal(f.workers.length, 1);
  const prompt = f.workers[0].prompt!;
  assert.match(prompt, /Ticket from OPORA's heart[\s\S]*Customers pay in one step[\s\S]*The Pay API endpoint[\s\S]*Refunds come later[\s\S]*No card data in logs[\s\S]*\/ponytail@5\.3\.3[\s\S]*npm test is green/);
  assert.match(prompt, /'feedback' 'KIND' 'TEXT'/);
  assert.doesNotMatch(prompt, /tk_1|gt-\d/, 'no ticket id or gate token in the prompt');
  assert.match(prompt, /immutable Canvas assignment/, 'the execution protocol stays');
  // The ticket is the run's, across a restart; the lobby and the ticket each have a session of their own.
  assert.match(readFileSync(path.join(f.dir, 'opora.json'), 'utf8'), /"ticketId": "tk_1"/);
  assert.doesNotMatch(JSON.stringify(f.state()), /tk_1/);
  assert.equal(f.op.gate.sessions.length, 2);
  // Held by the run: the next poll takes nothing more.
  await f.bridge.poll();
  assert.equal(f.op.calls.filter((c) => c.path === '/api/oporahub/executions/claim').length, 1);
});

test('without a ticket the office takes nothing by itself', async (t) => {
  const f = await fixture(t);
  await f.bridge.poll();
  assert.ok(gateKinds(f).includes('ticket.request'));
  assert.equal(f.op.calls.some((c) => c.path === '/api/oporahub/executions/claim'), false);
  assert.equal(f.workers.length, 0);
});

test('a 409 at the ticket claim gives the execution back and seats no one', async (t) => {
  const f = await fixture(t);
  f.op.gate.tickets.push(issued());
  f.op.gate.refuseClaim = 'ticket_execution';
  await f.bridge.poll();
  assert.ok(f.op.calls.some((c) => c.path === '/api/oporahub/executions/claim'));
  assert.ok(f.op.calls.some((c) => c.path === '/api/oporahub/executions/ex-c2/release'), 'the execution is released');
  assert.equal(f.op.leases.has('c2'), false);
  assert.equal(f.workers.length, 0);
  assert.equal(f.op.gate.tickets[0].status, 'issued', 'the ticket stays in the heart’s queue');
  assert.equal(f.toasts.filter((x) => /OPORA ticket for “Pay API” wasn't taken/.test(x)).length, 1);
});

test('with every desk taken, or the limit reached, the ticket is not claimed and no execution starts', async (t) => {
  const f = await fixture(t);
  f.op.gate.tickets.push(issued());
  const desks = f.floor.desks;
  f.floor.desks = () => [];
  await f.bridge.poll();
  f.floor.desks = desks;
  (f.bridge as unknown as { state: OporaState }).state.maxRuns = 0;
  await f.bridge.poll();
  assert.equal(f.op.calls.some((c) => c.path === '/api/oporahub/executions/claim'), false);
  assert.equal(gateKinds(f).includes('ticket.claim'), false);
  assert.equal(f.op.gate.tickets[0].status, 'issued');
});

test('the worker’s feedback goes to the gate, the heart’s answers come back, and the hand-off delivers the ticket', async (t) => {
  const f = await fixture(t);
  f.op.gate.tickets.push(issued());
  await f.bridge.poll();
  const bundle = path.join(f.dir, 'opora-executions', 'ex-c2.json');
  assert.match(JSON.stringify(queueFeedback(bundle, 'question', 'May I add a column to payments?')), /queued/);
  assert.throws(() => queueFeedback(bundle, 'rant', 'x'), /bug, idea, improvement, question/);
  await f.bridge.poll();
  const ticket = f.op.gate.tickets[0];
  assert.deepEqual(ticket.feedback.map((x: Record<string, unknown>) => [x.kind, x.text]), [['question', 'May I add a column to payments?']]);
  assert.equal(ticket.status, 'needs_answer');
  // The heart answers; the next poll writes it where the helper reads it.
  ticket.feedback[0].answer = { text: 'Yes, nullable.' };
  ticket.status = 'in_progress';
  await f.bridge.poll();
  assert.deepEqual(readNotes(bundle).feedback.map((x) => x.answer), [{ text: 'Yes, nullable.' }]);
  await f.bridge.poll();
  assert.equal(ticket.feedback.length, 1, 'each item goes once');
  // The worker reported; the hand-off then delivers the ticket with the result's summary and the head.
  writeFileSync(path.join(f.dir, 'opora-executions', 'ex-c2-reported.json'), JSON.stringify({ receiptId: 'r1', result: { summary: 'Pay API in one step' } }));
  const run = (f.bridge as unknown as { runs: Record<string, unknown>[] }).runs[0];
  await (f.bridge as unknown as { deliverTicket(run: unknown, out: unknown): Promise<void> }).deliverTicket(run, { state: 'opened', headSha: 'a'.repeat(40) });
  assert.equal(ticket.status, 'delivered');
  assert.deepEqual(ticket.delivery, { summary: 'Pay API in one step', sha: 'a'.repeat(40) });
  assert.match(readFileSync(path.join(f.dir, 'opora.json'), 'utf8'), /"ticketDelivered": true/);
});

test('a ticket’s department and profile pick the desk and the pipeline; without them the default choice stands', async (t) => {
  const f = await fixture(t);
  // The department's desk (signed so) wins over the developers' unsigned one, for a code card too.
  assert.equal(await ticketFor(f, 'c2', { department: 'design', profile: 'code' }), undefined);
  assert.equal(f.workers[0].deskId, 'desk-3');
  assert.doesNotMatch(f.workers[0].prompt!, /Design references/);
  // Neither set: the canvas's own card, a developer's at the first free desk.
  assert.equal(await ticketFor(f, 'c1'), undefined);
  assert.equal(f.workers[1].deskId, 'desk-1');
  assert.equal(f.state().runs.find((r) => r.cardId === 'c1')?.group, 'dev');
});

/** The office after a restart: the same floor and data, a new bridge (so new gate sessions). */
function restarted(t: { after(fn: () => void): void }, f: Awaited<ReturnType<typeof fixture>>) {
  f.bridge.shutdown();
  const toasts: string[] = [];
  const bridge = new OporaBridge(f.floor, f.dir, { update() {}, toast: (x) => void toasts.push(x), prompt: (id) => PROMPTS[id].text }, f.url);
  t.after(() => bridge.shutdown());
  return { bridge, toasts };
}

test('after a restart the office claims its held ticket again in a new session, for the same execution, before feedback', async (t) => {
  const f = await fixture(t);
  f.op.gate.tickets.push(issued());
  await f.bridge.poll();
  const ticket = f.op.gate.tickets[0];
  const first = ticket.session;
  const at = f.op.calls.length;
  const again = restarted(t, f);
  await again.bridge.poll();
  const after = f.op.calls.slice(at).filter((c) => c.path === '/api/gate/requests');
  assert.deepEqual(after.find((c) => c.body?.kind === 'ticket.claim')?.body?.body, { ticketId: 'tk_1', executionId: 'ex-c2' });
  assert.notEqual(ticket.session, first, 'the ticket is bound to the new session');
  // Feedback after the restart goes through (no ticket_not_held).
  queueFeedback(path.join(f.dir, 'opora-executions', 'ex-c2.json'), 'idea', 'Cache the totals');
  await again.bridge.poll();
  assert.deepEqual(ticket.feedback.map((x: Record<string, unknown>) => x.text), ['Cache the totals']);
  assert.deepEqual(again.toasts, []);
});

test('an expired gate session (401) gets a new one that claims the ticket again before the request', async (t) => {
  const f = await fixture(t);
  f.op.gate.tickets.push(issued());
  await f.bridge.poll();
  f.op.gate.sessions.length = 0;
  const at = f.op.calls.length;
  await f.bridge.poll();
  const kinds = f.op.calls.slice(at).filter((c) => c.path === '/api/gate/requests').map((c) => c.body?.kind);
  const claimAt = kinds.indexOf('ticket.claim');
  assert.ok(claimAt >= 0 && kinds.indexOf('ticket.request', claimAt) > claimAt, 'claimed again, then asked');
  assert.ok(f.op.gate.sessions.includes(f.op.gate.tickets[0].session), 'bound to a live session again');
  assert.equal(f.workers[0].status, 'working');
});

test('a ticket another worker holds after the restart ends the run cleanly: worker home, execution released, nothing delivered', async (t) => {
  const f = await fixture(t);
  f.op.gate.tickets.push(issued());
  await f.bridge.poll();
  // While the office was down, OPORA gave the ticket to another execution.
  Object.assign(f.op.gate.tickets[0], { executionId: 'ex-elsewhere', session: 'someone-else' });
  const again = restarted(t, f);
  await again.bridge.poll();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.workers[0].status, 'exited', 'the worker is sent home');
  assert.ok(f.op.calls.some((c) => c.path === '/api/oporahub/executions/ex-c2/release'), 'the execution is let go');
  assert.equal(f.op.leases.has('c2'), false);
  assert.equal(gateKinds(f).includes('ticket.deliver'), false);
  assert.equal(f.op.gate.tickets[0].executionId, 'ex-elsewhere');
  assert.ok(again.toasts.some((x) => /held by another worker/.test(x)));
  const saved = JSON.parse(readFileSync(path.join(f.dir, 'opora.json'), 'utf8'));
  assert.equal(saved.runs[0].state, 'gone');
});

test('the floor’s tickets at once are set from the window, kept across a restart, and refused out of range', async (t) => {
  const f = await fixture(t);
  assert.equal(f.state().maxRuns, 2);
  assert.equal(f.bridge.setMaxRuns(5), undefined);
  assert.equal(f.state().maxRuns, 5);
  assert.match(f.bridge.setMaxRuns(0)!, /Between 1 and 8/);
  assert.match(f.bridge.setMaxRuns(1.5)!, /Between 1 and 8/);
  assert.match(f.bridge.setMaxRuns(9)!, /Between 1 and 8/);
  assert.equal(JSON.parse(readFileSync(path.join(f.dir, 'opora.json'), 'utf8')).maxRuns, 5);
  const again = restarted(t, f);
  assert.equal(again.bridge.view().maxRuns, 5);
});

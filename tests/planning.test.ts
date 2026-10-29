import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HEART_PLANNER_TOOLS, PlanningRoom, heartPlannerLaunch, type PlanningQueue, type PlanningWorkers } from '../src/server/planning.js';
import { claude } from '../src/server/providers/claude.js';
import { restoreWorkers, saveWorkers } from '../src/server/workers/persist.js';
import { newWorker } from '../src/server/workers/worker.js';
import { newTracker } from '../src/server/usage.js';
import type { Worker, WorkerLaunchOptions } from '../src/server/workers/types.js';
import { DESK_BY_ID, nextFreeSeat, vacantSeats } from '../src/shared/layout.js';
import { PLANNER_SEAT, PLANNING_ROOM, inPlanningRoom, planTasks, planTitle } from '../src/shared/planning.js';
import { PROMPTS } from '../src/shared/prompts.js';
import { OFFICE_PLAN } from '../src/shared/maps/index.js';
import type { PlanningState, QueueTask, WorkerInfo } from '../src/shared/protocol.js';

const PLAN = `# Export boards as PDF

A button in the board's menu.

## Tasks

- [ ] **Add the export endpoint**: a route that renders the board to PDF.
  Check it with a test.
- [ ] **Add the menu button** — calls the endpoint and downloads the file.
- Plain item with no bold title
1. Numbered item

## Risks

- Not a task
`;

test('planTasks reads the list under the Tasks heading, with titles and their indented lines', () => {
  const tasks = planTasks(PLAN);
  assert.deepEqual(
    tasks.map((t) => t.title),
    ['Add the export endpoint', 'Add the menu button', 'Plain item with no bold title', 'Numbered item'],
  );
  assert.equal(tasks[0].text, 'a route that renders the board to PDF.\nCheck it with a test.');
  assert.equal(tasks[1].text, 'calls the endpoint and downloads the file.');
  assert.equal(tasks[2].text, 'Plain item with no bold title');
});

test('planTasks takes a Czech heading, and finds nothing without one', () => {
  assert.equal(planTasks('## Úkoly\n- **Jedna**: udělat to\n').length, 1);
  assert.deepEqual(planTasks('# Plan\n- **Not a task**: no heading'), []);
});

test('a plan is titled by its own title, or the first line of what it is for', () => {
  assert.equal(planTitle('Make it fast\nand more', ''), 'Make it fast');
  assert.equal(planTitle('whatever', 'My plan'), 'My plan');
});

test('the planner has a chair of its own: a place a worker can be, but never a seat anyone is hired to', () => {
  assert.equal(DESK_BY_ID.get(PLANNER_SEAT.id), PLANNER_SEAT);
  assert.equal(nextFreeSeat(() => false)?.id === PLANNER_SEAT.id, false);
  assert.ok(vacantSeats([]).has(PLANNER_SEAT.id));
  assert.ok(OFFICE_PLAN.byId.has(PLANNER_SEAT.id));
  assert.ok(inPlanningRoom(PLANNER_SEAT.x, PLANNER_SEAT.z));
  assert.ok(!inPlanningRoom(PLANNING_ROOM.maxX + 0.5, PLANNER_SEAT.z));
});

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-planning-'));
  const dataDir = path.join(dir, '.agent-office');
  mkdirSync(dataDir, { recursive: true });
  const workers: WorkerInfo[] = [];
  const tasks: QueueTask[] = [];
  const toasts: string[] = [];
  let state: PlanningState | undefined;
  const manager: PlanningWorkers = {
    list: () => workers,
    seat(by, prompt, provider) {
      if (workers.some((w) => w.deskId === PLANNER_SEAT.id)) return 'taken';
      const worker: WorkerInfo = {
        id: `w${workers.length}`, deskId: PLANNER_SEAT.id, kind: 'agent', provider, prompt, name: 'Planny',
        color: '#9b5de5', status: 'working', acked: false, createdBy: by,
        createdAt: Date.now(), cols: 80, rows: 24, viewers: [], viewerIds: [], via: 'planning',
      };
      workers.push(worker);
      return worker;
    },
    kill(id) {
      const i = workers.findIndex((w) => w.id === id);
      if (i >= 0) workers.splice(i, 1);
      return Promise.resolve({});
    },
  };
  const queue: PlanningQueue = {
    add(prompt, by, title, _issue, provider) {
      tasks.push({ id: `t${tasks.length}`, title: title ?? '', prompt, addedBy: by, addedAt: Date.now(), status: 'queued', provider });
      return undefined;
    },
    state: () => ({ tasks, maxWorkers: 3 }),
  };
  const rooms: PlanningRoom[] = [];
  const open = () => {
    const room = new PlanningRoom(dir, dataDir, manager, queue, {
      update: (s) => void (state = s),
      toast: (text) => void toasts.push(text),
      hiringPaused: () => undefined,
      prompt: (id) => PROMPTS[id].text,
    });
    rooms.push(room);
    return room;
  };
  return { dir, workers, tasks, toasts, open, state: () => state, close() { rooms.forEach((r) => r.shutdown()); rmSync(dir, { recursive: true, force: true }); } };
}

test('a plan seats its planner, is ready once its turn ends with tasks written, and hands the picked ones to the queue', (t) => {
  const f = fixture(); t.after(() => f.close());
  const room = f.open();
  assert.equal(room.start({ goal: 'Export boards as PDF', provider: 'claude' }, 'Ana'), undefined);
  const p = room.state().current!;
  assert.equal(p.status, 'planning');
  assert.equal(f.workers[0].deskId, PLANNER_SEAT.id);
  assert.match(f.workers[0].prompt!, /Export boards as PDF/);
  assert.match(f.workers[0].prompt!, new RegExp(path.basename(p.file).replace(/\./g, '\\.')));
  // A second plan waits for this one.
  assert.match(room.start({ goal: 'Another' }, 'Ana')!, /still at it/);

  // It ends its turn with nothing written: still planning.
  f.workers[0].status = 'done';
  room.onWorker(f.workers[0]);
  assert.equal(room.state().current!.status, 'planning');

  writeFileSync(path.join(f.dir, p.file), PLAN);
  room.onWorker(f.workers[0]);
  const ready = room.state().current!;
  assert.equal(ready.status, 'ready');
  assert.equal(ready.tasks.length, 4);
  assert.match(ready.preview, /Export boards as PDF/);

  assert.equal(room.queueTasks([0, 2], 'Ben'), 2);
  assert.equal(f.tasks.length, 2);
  assert.equal(f.tasks[0].title, 'Add the export endpoint');
  assert.equal(f.tasks[0].provider, 'claude');
  assert.match(f.tasks[0].prompt, /Read the whole plan in .*\.md/);
  assert.match(f.tasks[0].prompt, /a route that renders the board to PDF/);
  const queued = room.state().current!;
  assert.equal(queued.status, 'queued');
  assert.equal(queued.tasks[0].queueId, 't0');
  assert.equal(queued.tasks[1].queueId, undefined);
  // The ones on the queue already don't go twice.
  assert.equal(room.queueTasks([0], 'Ben'), 'Pick a task that isn’t on the queue yet');
  assert.equal(room.queueTasks([1, 3], 'Ben'), 2);
  assert.equal(f.tasks.length, 4);
});

test('clearing the room sends the planner home and keeps the plan in the earlier ones', (t) => {
  const f = fixture(); t.after(() => f.close());
  const room = f.open();
  room.start({ goal: 'Plan it' }, 'Ana');
  const p = room.state().current!;
  writeFileSync(path.join(f.dir, p.file), PLAN);
  f.workers[0].status = 'done';
  room.onWorker(f.workers[0]);
  assert.equal(room.clear('Ana'), undefined);
  assert.equal(f.workers.length, 0);
  assert.equal(room.state().current, null);
  assert.equal(room.state().past[0].title, 'Plan it');
  assert.equal(room.state().past[0].tasks, 4);
  // And the room is free for the next plan, which gets a file of its own.
  assert.equal(room.start({ goal: 'Plan it' }, 'Ana'), undefined);
  assert.notEqual(room.state().current!.file, p.file);
});

test('a planner sent home mid-plan stops the plan, and the room comes back after a restart', (t) => {
  const f = fixture(); t.after(() => f.close());
  const room = f.open();
  room.start({ goal: 'Plan it' }, 'Ana');
  room.onWorkerGone(f.workers[0].id);
  assert.equal(room.state().current!.status, 'stopped');
  assert.equal(room.state().current!.reason, 'the planner went home');
  room.shutdown();
  assert.equal(f.open().state().current!.status, 'stopped');
});

test('stop sends the planner home and says who stopped it', (t) => {
  const f = fixture(); t.after(() => f.close());
  const room = f.open();
  room.start({ goal: 'Plan it' }, 'Ana');
  assert.equal(room.stop('Ben'), undefined);
  assert.equal(room.state().current!.reason, 'stopped by Ben');
  assert.equal(f.workers.length, 0);
  assert.equal(room.stop('Ben'), 'Nobody is planning right now');
});

/** A planning room whose floor is linked to Opora, with or without the heart, recording what its planner was seated with. */
function oporaRoom(f: ReturnType<typeof fixture>, heart: boolean) {
  const seated: { prompt: string; launch?: WorkerLaunchOptions }[] = [];
  const manager: PlanningWorkers = {
    list: () => f.workers,
    seat(by, prompt, provider, _model, _effort, _owner, launch) {
      seated.push({ prompt, launch });
      const worker: WorkerInfo = { id: `w${f.workers.length}`, deskId: PLANNER_SEAT.id, kind: 'agent', provider, prompt, name: 'Planny', color: '#9b5de5', status: 'working', acked: false, createdBy: by, createdAt: Date.now(), cols: 80, rows: 24, viewers: [], viewerIds: [], via: 'planning' };
      f.workers.push(worker);
      return worker;
    },
    kill: () => Promise.resolve({}),
  };
  const room = new PlanningRoom(f.dir, path.join(f.dir, '.agent-office'), manager, { add: () => undefined, state: () => ({ tasks: [], maxWorkers: 1 }) }, {
    update: () => undefined,
    toast: (text) => void f.toasts.push(text),
    hiringPaused: () => undefined,
    prompt: (id) => PROMPTS[id].text,
    opora: () => ({ base: 'http://127.0.0.1:8740', project: 'p1', name: 'Shop', workspace: 'work1', focus: 'Web › Kontakt', heart, floor: 'shop' }),
  });
  return { room, seated };
}

test('in a project OPORA’s heart plans, the planner relays the task to the heart, with its tools allowed', (t) => {
  const f = fixture(); t.after(() => f.close());
  const { room, seated } = oporaRoom(f, true);
  t.after(() => room.shutdown());
  assert.equal(room.start({ goal: 'Kontaktní formulář s ověřením e-mailu', mode: 'opora', provider: 'claude' }, 'Ana'), undefined);
  const { prompt, launch } = seated[0];
  assert.match(prompt, /relay it verbatim/);
  assert.match(prompt, /Kontaktní formulář s ověřením e-mailu/);
  assert.match(prompt, /Focus \(what the cell works on.*\): Web › Kontakt\./);
  assert.match(prompt, /opora_gate\.py session --project p1 --workspace work1 --name orchestrator-shop/);
  assert.match(prompt, /opora_gate\.py tell/);
  assert.match(prompt, /\/api\/brain\/heart\/status --project p1/);
  assert.match(prompt, new RegExp(path.basename(room.state().current!.file).replace(/\./g, '\.')));
  assert.doesNotMatch(prompt, /\{\{/);
  assert.doesNotMatch(prompt, /canvas-plan batch/);
  assert.deepEqual(launch?.allowedTools, [...HEART_PLANNER_TOOLS]);
  for (const tool of ['Bash(python:*)', 'Read', 'Grep', 'Glob']) assert.ok(launch!.allowedTools!.includes(tool), tool);
  assert.ok(!launch!.allowedTools!.some((x) => /dangerously/i.test(x)));
  assert.deepEqual(launch?.env, { OPORA_BASE_URL: 'http://127.0.0.1:8740', OPORA_AGENT_NAME: 'orchestrator-shop' });
  assert.equal(room.state().current!.heart, true);
  assert.equal(room.state().current!.mode, 'opora');
  assert.match(f.toasts.at(-1)!, /heart/);
});

test('without the heart, planning onto Opora and routing stay as they were, with no extra tools', (t) => {
  const f = fixture(); t.after(() => f.close());
  const { room, seated } = oporaRoom(f, false);
  t.after(() => room.shutdown());
  assert.equal(room.start({ goal: 'A contact form', mode: 'opora' }, 'Ana'), undefined);
  assert.match(seated[0].prompt, /canvas-plan batch/);
  assert.equal(seated[0].launch, undefined);
  assert.equal(room.state().current!.heart, undefined);
  assert.equal(room.clear('Ana'), undefined);
  f.workers.length = 0;
  // The router is the router, heart or not.
  const heart = oporaRoom(f, true);
  t.after(() => heart.room.shutdown());
  assert.equal(heart.room.start({ goal: '', mode: 'router' }, 'Ana'), undefined);
  assert.match(heart.seated[0].prompt, /You're the router/);
  assert.equal(heart.seated[0].launch, undefined);
});

test('Claude gets the tools its seat allows as --allowedTools, before the prompt; none without', () => {
  const launch = (allowedTools?: string[]) => claude.launch({ h: { info: { id: 'w1' } } as never, args: [], prompt: 'go', cwd: '.', setup: { settings: 's.json', dir: '.' }, allowedTools }).args;
  const args = launch(['Bash(python:*)', 'Read']);
  const at = args.indexOf('--allowedTools');
  assert.deepEqual(args.slice(at, at + 3), ['--allowedTools', 'Bash(python:*)', 'Read']);
  assert.deepEqual(args.slice(-2), ['--', 'go']);
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.equal(launch().includes('--allowedTools'), false);
  assert.equal(launch([]).includes('--allowedTools'), false);
});

test('a worker’s launch options are saved and come back after a restart', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-launch-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'workers.json');
  const info = { id: 'w1', kind: 'agent', provider: 'claude', deskId: PLANNER_SEAT.id, name: 'Planny', color: '#fff', status: 'idle', acked: true, createdBy: 'Ana', createdAt: 1, cols: 80, rows: 24, viewers: [], viewerIds: [] } as WorkerInfo;
  const w = newWorker(info, newTracker());
  w.launch = heartPlannerLaunch('http://127.0.0.1:8740', 'shop');
  saveWorkers(file, [w], true);
  const back = new Map<string, Worker>();
  restoreWorkers(file, back, 'claude', () => false);
  assert.deepEqual(back.get('w1')?.launch, w.launch);
});

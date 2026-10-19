import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlanningRoom, type PlanningQueue, type PlanningWorkers } from '../src/server/planning.js';
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

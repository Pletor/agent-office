import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { slugify } from '../shared/meetings.js';
import { PLANNER_SEAT, PLANS_DIR, PLAN_LIMITS, planTasks, planTitle } from '../shared/planning.js';
import { fillPrompt, type PromptId } from '../shared/prompts.js';
import { forgetForOpora, markForOpora, seatForOpora, withReaBrief } from './rea/index.js';
import type { AgentEffort, AgentProvider, Plan, PlanMode, PlanRecord, PlanningState, QueueState, WorkerInfo } from '../shared/protocol.js';
import type { WorkerLaunchOptions } from './workers/types.js';

const MODE_PROMPT: Record<PlanMode, PromptId> = { file: 'planning.plan', opora: 'planning.opora', router: 'planning.router' };

/**
 * What the heart's planner may do without asking (Opora's docs/brain-heart-orchestrator.md §8): run the
 * opora-control-center skill's scripts, read, and write its summary under PLANS_DIR. Only those, so the
 * relay never stops on an approval prompt; never --dangerously-skip-permissions.
 */
export const HEART_PLANNER_TOOLS: readonly string[] = ['Bash(python:*)', 'Bash(python3:*)', 'Read', 'Grep', 'Glob', `Edit(./${PLANS_DIR}/**)`, `Write(./${PLANS_DIR}/**)`];

/** How the heart's planner is started: its tools, and Opora's address and its agent name for the skill's scripts. */
export function heartPlannerLaunch(base: string | undefined, floor: string | undefined): WorkerLaunchOptions {
  return {
    allowedTools: [...HEART_PLANNER_TOOLS],
    env: { ...(base ? { OPORA_BASE_URL: base } : {}), OPORA_AGENT_NAME: `orchestrator-${floor || 'office'}` },
  };
}

/** What the planning room needs from the worker manager. Narrow on purpose, so a test can fake it. */
export interface PlanningWorkers {
  list(): WorkerInfo[];
  /** Seats the planner in the planning room's chair (see PLANNER_SEAT). */
  seat(by: string, prompt: string, provider: AgentProvider | undefined, model: string | undefined, effort: AgentEffort | undefined, owner?: string, launch?: WorkerLaunchOptions): WorkerInfo | string;
  kill(id: string): Promise<{ note?: string; error?: string }>;
}

/** What it needs from the floor's task queue: somewhere to put a plan's tasks. */
export interface PlanningQueue {
  add(prompt: string, by: string, title?: string, issue?: number, provider?: AgentProvider, model?: string, effort?: AgentEffort, owner?: string): string | undefined;
  state(): QueueState;
}

export interface PlanningEvents {
  update(state: PlanningState): void;
  toast(text: string, level: 'info' | 'warn' | 'error'): void;
  /** Why no workers may be hired right now (today's budget is spent), if that's so. */
  hiringPaused(): string | undefined;
  /** A prompt's text as the office has it now (rewritten in ⚙️ Settings, or the default). */
  prompt(id: PromptId): string;
  /**
   * Where Opora is, and the floor's project and workspace on it once it's linked (see opora/bridge.ts);
   * `heart` when OPORA's heart plans that project, `floor` the floor's id (the orchestrator's name there).
   */
  opora?(): { base: string; project?: string; name?: string; workspace?: string; focus?: string; heart?: boolean; floor?: string };
  /** The overview of the card picked for the orchestrator at the right board, a block of data to add to the planner's brief. */
  brief?(): string | undefined;
}

export interface PlanRequest {
  goal: string;
  mode?: PlanMode;
  title?: string;
  provider?: AgentProvider;
  model?: string;
  effort?: AgentEffort;
}

/** How much of the plan the board in the room shows, and the most of it read for its tasks. */
const PREVIEW_CHARS = 1600;
const READ_BYTES = 256 * 1024;
const PAST = 20;
const TICK_MS = 3000;

/**
 * The planning room (🧭 Opora Control Center). Someone asks for a plan; a planner sits down at the
 * room's table and writes it to a file under PLANS_DIR, with the work split into tasks under its
 * "## Tasks" heading. Each time the planner ends its turn, the office reads the tasks back; once
 * there are some, the plan is ready, and whoever looks at it hands the tasks they pick to the task
 * queue, which seats a worker for each. The planner stays at the table until the room is cleared, so
 * you can ask it to change the plan first.
 */
export class PlanningRoom {
  private current: Plan | null = null;
  private past: PlanRecord[] = [];
  private statePath: string;
  private timer: NodeJS.Timeout;

  constructor(
    /** The project's folder, which the plan's path is from. */
    private dir: string,
    dataDir: string,
    private workers: PlanningWorkers,
    private queue: PlanningQueue,
    private events: PlanningEvents,
  ) {
    this.statePath = path.join(dataDir, 'planning.json');
    this.restore();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  state(): PlanningState {
    return { current: this.current ? { ...this.current, tasks: this.current.tasks.map((t) => ({ ...t })) } : null, past: this.past.map((r) => ({ ...r })) };
  }

  start(req: PlanRequest, by: string, owner?: string): string | undefined {
    const mode: PlanMode = req.mode === 'opora' || req.mode === 'router' ? req.mode : 'file';
    const goal = (req.goal.trim() || (mode === 'router' ? 'Route the cards on the Opora canvas that have no pipeline yet' : '')).slice(0, PLAN_LIMITS.goal);
    if (!goal) return 'Say what to plan';
    const opora = this.events.opora?.();
    if (mode !== 'file' && (!opora?.project || !opora.workspace)) return 'Opora isn’t linked to this floor yet: see the 🛰️ Opora window';
    if (this.current?.status === 'planning') return 'The planner is still at it: stop that plan first';
    if (this.current) return 'Clear the room first: the last plan is still on the board';
    if (this.workers.list().some((w) => w.deskId === PLANNER_SEAT.id)) return "The last planner hasn't left the table yet: try again in a moment";
    const paused = this.events.hiringPaused();
    if (paused) return paused;
    const title = planTitle(goal, req.title || (mode === 'router' ? 'Routing the Opora cards' : undefined));
    const file = this.freeFile(title);
    mkdirSync(path.join(this.dir, PLANS_DIR), { recursive: true });
    // A project OPORA's heart plans: the planner relays the task to the heart and never plans cards itself.
    const heart = mode === 'opora' && opora?.heart === true;
    const focus = !opora?.focus ? '' : heart ? `Focus (what the cell works on, switched at the 🎚️ switchboard): ${opora.focus}.` : `Stay inside what the cell works on (switched at the 🎚️ switchboard): ${opora.focus}. Read, plan and route only there.`;
    const filled = fillPrompt(this.events.prompt(heart ? 'planning.heart' : MODE_PROMPT[mode]), { goal, file: path.join(this.dir, file), base: opora?.base, project: opora?.project, name: opora?.name ?? opora?.project, workspace: opora?.workspace, focus, floor: opora?.floor || 'office' });
    const focused = this.events.brief?.();
    // The card picked for the orchestrator at the right board: its overview, as data, after the brief.
    const prompt = focused ? `${filled}\n\n${focused}\nThe office keeps this overview up to date in ${path.join(this.dir, '.agent-office', 'orchestrator-focus.md')} while the card stays picked.` : filled;
    // Planning onto the canvas, the planner gets 🔬 REA when it's on, to take a reference app apart first (see rea/).
    const seat = (brief: string, launch?: WorkerLaunchOptions) => this.workers.seat(by, brief, req.provider, req.model, req.effort, owner, launch);
    const seated = heart ? seat(prompt, heartPlannerLaunch(opora?.base, opora?.floor)) : mode === 'opora' ? seatForOpora(() => seat(withReaBrief(prompt, this.events.prompt))) : seat(prompt);
    if (typeof seated === 'string') return seated;
    this.current = {
      id: randomBytes(4).toString('hex'),
      title,
      goal,
      mode,
      ...(heart ? { heart: true as const } : {}),
      by,
      ...(owner ? { owner } : {}),
      startedAt: Date.now(),
      status: 'planning',
      workerId: seated.id,
      workerName: seated.name,
      file,
      preview: '',
      tasks: [],
      ...(req.provider ? { provider: req.provider } : {}),
      ...(req.model ? { model: req.model } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
    };
    this.changed();
    this.events.toast(heart ? `🧭 ${by} asked ${seated.name} to hand “${title}” to OPORA's heart` : `🧭 ${by} asked ${seated.name} to plan “${title}”`, 'info');
    return undefined;
  }

  /** Hands the plan's tasks at `indexes` that aren't on the queue yet to it. Resolves to how many went, or why none could. */
  queueTasks(indexes: number[], by: string): string | number {
    const p = this.current;
    if (!p || (p.status !== 'ready' && p.status !== 'queued') || (p.mode ?? 'file') !== 'file') return 'There’s no plan ready to hand over';
    const picked = [...new Set(indexes)].filter((i) => Number.isInteger(i) && p.tasks[i] && !p.tasks[i].queueId);
    if (!picked.length) return 'Pick a task that isn’t on the queue yet';
    let sent = 0;
    for (const i of picked) {
      const task = p.tasks[i];
      const prompt = fillPrompt(this.events.prompt('planning.task'), { plan: p.title, file: path.join(this.dir, p.file), title: task.title, task: task.text });
      const err = this.queue.add(prompt, by, task.title, undefined, p.provider, p.model, p.effort, p.owner);
      if (err) {
        if (sent) this.handed(p, sent, by);
        return sent ? `${sent} went on the queue, then: ${err}` : err;
      }
      task.queueId = this.queue.state().tasks.at(-1)?.id ?? '?';
      sent++;
    }
    this.handed(p, sent, by);
    return sent;
  }

  stop(by: string): string | undefined {
    const p = this.current;
    if (!p || p.status !== 'planning') return 'Nobody is planning right now';
    this.halt(p, `stopped by ${by}`);
    if (p.workerId) void this.workers.kill(p.workerId);
    return undefined;
  }

  /** Puts the plan away (it's kept in the list of earlier ones) and sends its planner home. */
  clear(by: string): string | undefined {
    const p = this.current;
    if (!p) return 'The room is already clear';
    if (p.status === 'planning') this.halt(p, `cleared by ${by}`);
    this.past.unshift({ title: p.title, by: p.by, at: p.startedAt, file: p.file, tasks: p.tasks.length, status: p.status });
    this.past.length = Math.min(this.past.length, PAST);
    this.current = null;
    if (p.workerId) {
      forgetForOpora(p.workerId);
      void this.workers.kill(p.workerId);
    }
    this.changed();
    return undefined;
  }

  onWorker(info: WorkerInfo) {
    const p = this.current;
    if (!p || info.id !== p.workerId) return;
    if (p.status === 'planning' && (info.status === 'exited' || info.status === 'offline')) {
      this.read(p);
      if (!p.tasks.length) return this.halt(p, 'the planner stopped before writing any tasks');
    }
    // Its turn is over (or it's asking something): see what it's written so far.
    if (info.status === 'working' || info.status === 'starting') return;
    if (p.status !== 'planning' && p.status !== 'ready') return;
    const before = JSON.stringify([p.preview, p.tasks]);
    this.read(p);
    // Onto the Opora canvas (or routing it): done once its turn is over and it wrote what it did.
    if (p.status === 'planning' && (p.mode ?? 'file') !== 'file' && info.status === 'done' && p.preview) {
      p.status = 'ready';
      this.events.toast(`🧭 “${p.title}” is on the Opora canvas: the office takes its cards from there`, 'info');
      return this.changed();
    }
    if (p.status === 'planning' && (p.mode ?? 'file') === 'file' && p.tasks.length) {
      p.status = 'ready';
      this.events.toast(`🧭 The plan “${p.title}” is ready: ${p.tasks.length} task${p.tasks.length === 1 ? '' : 's'} to hand to the queue`, 'info');
      return this.changed();
    }
    if (JSON.stringify([p.preview, p.tasks]) !== before) this.changed();
  }

  onWorkerGone(workerId: string) {
    const p = this.current;
    if (!p || p.workerId !== workerId) return;
    p.workerId = undefined;
    forgetForOpora(workerId);
    if (p.status === 'planning') return this.halt(p, 'the planner went home');
    this.changed();
  }

  shutdown() {
    clearInterval(this.timer);
    this.persist();
  }

  /** While the planner writes, the board shows what's there so far. */
  private tick() {
    const p = this.current;
    if (!p || p.status !== 'planning') return;
    const before = p.preview;
    this.read(p, false);
    if (p.preview !== before) this.changed();
  }

  /** Reads the plan file: the start of it for the board, and (unless `tasks` is false, or they're on the queue already) its tasks. */
  private read(p: Plan, tasks = true) {
    const file = path.join(this.dir, p.file);
    if (!existsSync(file)) return;
    let text = '';
    try {
      text = readStart(file, READ_BYTES);
    } catch {
      return;
    }
    p.preview = text.slice(0, PREVIEW_CHARS);
    if (tasks && p.status !== 'queued') p.tasks = planTasks(text).map((t) => ({ title: t.title, text: t.text }));
  }

  private handed(p: Plan, sent: number, by: string) {
    p.status = 'queued';
    p.queuedAt = Date.now();
    this.changed();
    this.events.toast(`🧭 ${by} handed ${sent} task${sent === 1 ? '' : 's'} of “${p.title}” to the 📋 queue`, 'info');
  }

  private halt(p: Plan, reason: string) {
    p.status = 'stopped';
    p.reason = reason;
    this.changed();
    this.events.toast(`🧭 The plan “${p.title}” stopped: ${reason}`, 'warn');
  }

  /** A plan file nobody has written yet: the date, then the title. */
  private freeFile(title: string): string {
    const base = `${new Date().toISOString().slice(0, 10)}-${slugify(title, 50).replace(/^meeting$/, 'plan')}`;
    for (let n = 1; ; n++) {
      const file = `${PLANS_DIR}/${base}${n === 1 ? '' : `-${n}`}.md`;
      if (!existsSync(path.join(this.dir, file))) return file;
    }
  }

  private changed() {
    this.persist();
    this.events.update(this.state());
  }

  private persist() {
    try {
      writeFileSync(this.statePath, JSON.stringify({ current: this.current, past: this.past }, null, 2), { mode: 0o600 });
    } catch {
      // a full disk loses the room's state, not the office
    }
  }

  private restore() {
    try {
      if (!existsSync(this.statePath)) return;
      const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<PlanningState>;
      if (saved.current && typeof saved.current.id === 'string' && Array.isArray(saved.current.tasks)) this.current = saved.current;
      if (this.current?.mode === 'opora' && !this.current.heart && this.current.workerId) markForOpora(this.current.workerId);
      if (Array.isArray(saved.past)) this.past = saved.past.slice(0, PAST);
    } catch {
      // a broken file starts the room empty
    }
  }
}

function readStart(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8').replace(/�+$/, '');
  } finally {
    closeSync(fd);
  }
}

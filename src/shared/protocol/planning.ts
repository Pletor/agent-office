// The planning room (🧭 Opora Control Center): a planner writes a plan, and its tasks go on the queue.

import type { AgentEffort, AgentProvider } from './agents.js';

/**
 * Where a plan is: being written, written and waiting for someone to hand its tasks to the queue,
 * on the queue, or stopped (by hand, or because the planner went home or wrote no tasks).
 */
export type PlanStatus = 'planning' | 'ready' | 'queued' | 'stopped';

/**
 * What the planner does: a plan in a file whose tasks go on the queue, a plan laid onto the Opora
 * canvas as sectors and cards (which the office then takes from there), or routing the canvas's cards
 * that have no pipeline yet.
 */
export type PlanMode = 'file' | 'opora' | 'router';

export interface PlanTask {
  title: string;
  /** What its worker is told to do, from the plan. */
  text: string;
  /** The queue task it became, once it's been handed over. */
  queueId?: string;
}

export interface Plan {
  id: string;
  title: string;
  /** What it's a plan for, as asked. */
  goal: string;
  /** What the planner does (file when it's missing: plans from before there were others). */
  mode?: PlanMode;
  /** An `opora` plan in a project OPORA's heart plans: the planner relayed the task to the heart (planning.heart). */
  heart?: true;
  by: string;
  /** The account that asked for it: the planner, and the tasks it queues, run on its sign-ins. */
  owner?: string;
  startedAt: number;
  status: PlanStatus;
  /** Why it stopped, when it did. */
  reason?: string;
  /** The planner at the room's table (it may have gone home since). */
  workerId?: string;
  workerName?: string;
  /** The plan file, from the project's folder (in PLANS_DIR). */
  file: string;
  /** The start of what's written in it, for the board in the room. */
  preview: string;
  /** The tasks under its "## Tasks" heading, as of the planner's last turn. */
  tasks: PlanTask[];
  /** The worker it was planned for, which its tasks go on the queue for too. */
  provider?: AgentProvider;
  model?: string;
  effort?: AgentEffort;
  queuedAt?: number;
}

/** A plan from before, in one line. */
export interface PlanRecord {
  title: string;
  by: string;
  at: number;
  file: string;
  tasks: number;
  status: PlanStatus;
}

export interface PlanningState {
  current: Plan | null;
  past: PlanRecord[];
}

export type PlanningClientMsg =
  | { t: 'planning.start'; goal: string; title?: string; mode?: PlanMode; provider?: AgentProvider; model?: string; effort?: AgentEffort }
  /** Hand these of the plan's tasks (by index) to the task queue. */
  | { t: 'planning.queue'; tasks: number[] }
  | { t: 'planning.stop' }
  /** Put the plan away, and send its planner home. */
  | { t: 'planning.clear' };

export type PlanningServerMsg = { t: 'planning'; state: PlanningState };

// The planning room (🧭 Opora Control Center): where it stands on the office floor, and the plans
// written there. A planner, a worker at the room's table, writes a plan with its tasks in it; the
// tasks it splits the work into go on the floor's task queue, for the other workers to carry out.

import type { DeskDef } from './layout.js';

/**
 * The room: glass walls round the open floor between the desks and the lounge, south of the fire
 * pole and west of the plant by the lounge, with its door in the east wall facing the lounge.
 */
export const PLANNING_ROOM = { minX: 2.4, maxX: 7.6, minZ: 3, maxZ: 8, height: 2.75, door: { z0: 4.6, z1: 6 } } as const;
/** The table, its long side running north–south (`depth` along z), with the planner at its east end. */
export const PLANNING_TABLE = { x: 4.8, z: 5.5, width: 1.3, depth: 2.4, height: 0.76 } as const;
/** The board the plan goes up on: standing on its feet by the west wall, facing the table (+x). `bottom` is its lower edge. */
export const PLANNING_BOARD = { x: 2.75, z: 5.5, width: 3.4, height: 1.9, bottom: 0.6 } as const;

/** The planner's chair, at the table's east end, facing the board. Only the planning room seats a worker there. */
export const PLANNER_SEAT: DeskDef = {
  id: 'planner',
  x: PLANNING_TABLE.x + PLANNING_TABLE.width / 2 - 0.4,
  z: PLANNING_TABLE.z,
  rotY: Math.PI / 2,
  label: "Planner's chair",
  planner: true,
};

/** Whether (x, z) is inside the room. */
export function inPlanningRoom(x: number, z: number): boolean {
  const R = PLANNING_ROOM;
  return x > R.minX && x < R.maxX && z > R.minZ && z < R.maxZ;
}

/** What's in the way in and round the room, for the nav grid (see shared/nav.ts): its walls with the doorway, the table, the board, the chair. */
export function planningObstacles(): { rects: [number, number, number, number][]; circles: [number, number, number][] } {
  const R = PLANNING_ROOM;
  const G = 0.06;
  const t = PLANNING_TABLE;
  const b = PLANNING_BOARD;
  const chairX = PLANNER_SEAT.x + 0.85;
  return {
    rects: [
      [R.minX - G, R.maxX + G, R.minZ - G, R.minZ + G],
      [R.minX - G, R.maxX + G, R.maxZ - G, R.maxZ + G],
      [R.minX - G, R.minX + G, R.minZ, R.maxZ],
      [R.maxX - G, R.maxX + G, R.minZ, R.door.z0],
      [R.maxX - G, R.maxX + G, R.door.z1, R.maxZ],
      [t.x - t.width / 2, t.x + t.width / 2, t.z - t.depth / 2, t.z + t.depth / 2],
      [b.x - 0.25, b.x + 0.25, b.z - b.width / 2, b.z + b.width / 2],
    ],
    circles: [[chairX, PLANNER_SEAT.z, 0.18]],
  };
}

// ---- Plans ------------------------------------------------------------------------------------------

/** Where the floor's plans are written, under its project folder (kept out of git with the rest of .agent-office). */
export const PLANS_DIR = '.agent-office/plans';
/** The most tasks a plan hands to the queue, and how long a task's title may be. */
export const PLAN_LIMITS = { tasks: 30, title: 100, goal: 20000 } as const;

/** One task a plan splits the work into: what the queue calls it, and what its worker is told. */
export interface PlanTaskDef {
  title: string;
  text: string;
}

const TASKS_HEADING = /^(#{1,4})\s+(?:\d+[.)]\s*)?(tasks|úkoly|ukoly)\b/i;
const ITEM = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;

/**
 * The tasks in a plan: the list under its "## Tasks" (or "## Úkoly") heading, down to the next heading
 * as big or bigger. Each item is a task; "**Title**: what to do" gives it its title, otherwise its
 * first words do, and the lines indented under an item go with it.
 */
export function planTasks(markdown: string): PlanTaskDef[] {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => TASKS_HEADING.test(l.trim()));
  if (start < 0) return [];
  const level = TASKS_HEADING.exec(lines[start].trim())![1].length;
  const items: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading && heading[1].length <= level) break;
    const item = /^\S/.test(line) ? ITEM.exec(line) : null;
    if (item) items.push([item[1].trim()]);
    else if (items.length && line.trim()) items[items.length - 1].push(line.trim());
  }
  return items
    .map(([first, ...rest]) => {
      const bold = /^\*\*(.+?)\*\*\s*[:—–-]?\s*(.*)$/.exec(first);
      const title = clipTitle(bold ? bold[1] : first);
      const text = [bold ? bold[2] : first, ...rest].filter(Boolean).join('\n').trim();
      return { title, text: text || title };
    })
    .filter((t) => t.title)
    .slice(0, PLAN_LIMITS.tasks);
}

function clipTitle(s: string): string {
  const flat = s.replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > PLAN_LIMITS.title ? `${flat.slice(0, PLAN_LIMITS.title - 1).trimEnd()}…` : flat;
}

/** A plan's title: the one given, or the goal's first line. */
export function planTitle(goal: string, title?: string): string {
  return clipTitle(title?.trim() || goal.trim().split('\n')[0] || 'Plan');
}

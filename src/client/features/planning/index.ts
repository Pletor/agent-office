/** The planning room (🧭 Opora Control Center): E at its table or board opens its window, and the board shows the plan. */
import type * as THREE from 'three';
import { PLANNER_SEAT } from '../../../shared/planning';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import type { Parts } from '../../core/parts';
import { store } from '../../state';
import { clip } from '../../ui/dom';
import { PlanningBoardTexture } from './board';
import { openPlanning } from './ui';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    planning: true;
  }
}

export function installPlanning(ctx: Ctx, parts: Pick<Parts, 'waiting'>) {
  function showPlanning() {
    openPlanning(ctx.net, { openTerminal: (id) => parts.waiting.openWorkerTerminal(id), showQueue: () => parts.waiting.showQueue() });
  }

  ctx.interactions.define('planning', {
    reach: 6,
    hint: () => {
      const p = store.planning.current;
      const what = !p ? 'free' : p.status === 'planning' ? `✍️ planning “${p.title}”` : p.status === 'ready' ? `📋 ${p.tasks.length} tasks ready` : p.status === 'queued' ? '🛠️ on the queue' : '⛔ stopped';
      return { k: what, parts: [hintTitle('🧭 Opora Control Center'), aside(clip(what, 50)), key('E', p ? 'See the plan' : 'Plan something')] };
    },
    use: onE(() => showPlanning()),
  });

  // The board: the plan as it's written, then its tasks and how each is getting on, on the queue.
  const board = new PlanningBoardTexture();
  const face = ctx.office.planningBoard;
  const mat = face.material as THREE.MeshBasicMaterial;
  mat.map = board.texture;
  mat.needsUpdate = true;
  const draw = () => board.render(store.planning, store.queue);
  store.on('planning', draw);
  store.on('queue', draw);
  draw();

  // The planner's chair is only there to use (its terminal, like any worker's) while the planner sits in it.
  const seat = ctx.office.plannerSeat;
  const sync = () => void (seat.off = !store.workerAtDesk(PLANNER_SEAT.id));
  store.on('workers', sync);
  sync();

  return { showPlanning };
}

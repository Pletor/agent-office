/**
 * 🛰️ The live canvas on the planning room's board, facing the door: while the floor is linked to an
 * Opora project, the way down to what the cell works on, its cards with who's on each, and what the
 * agents do on the canvas as they do it. E there still opens the planning room's window; O opens the
 * real Opora Canvas full screen, where the editor is and things can be commented for the agents.
 */
import type * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key } from '../../core/hint';
import { store } from '../../state';
import { LiveCanvasTexture } from './screen';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    oporalive: true;
  }
}

/** How often the board redraws while it's up, for its blinking light and how long ago things were. */
const REDRAW_MS = 1000;

export function installOporaLive(ctx: Ctx, deps: { openFull(): void; showPlanning(): void }) {
  ctx.interactions.define('oporalive', {
    reach: 6,
    hint: () => {
      const s = store.opora;
      const last = s.activity[0];
      const what = last ? `${last.agent.replace(/^office-/, '')} ${last.what}` : 'zatím ticho';
      return { k: what, parts: [hintTitle('🛰️ Canvas živě'), aside(what), key('E', 'Plán'), key('O', 'Editor Opory')] };
    },
    use: (_it, k) => {
      if (k === 'E') deps.showPlanning();
      if (k === 'O') deps.openFull();
    },
  });

  const { face, use } = ctx.office.oporaLiveBoard;
  const screen = new LiveCanvasTexture();
  const mat = face.material as THREE.MeshBasicMaterial;
  mat.map = screen.texture;
  mat.needsUpdate = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  const draw = () => {
    const s = store.opora;
    const up = s.connected && !!s.project;
    face.visible = up;
    use.off = !up;
    if (up) screen.render(s, store.planning);
    if (up && !timer) timer = setInterval(draw, REDRAW_MS);
    else if (!up && timer) timer = void clearInterval(timer);
  };
  store.on('opora', draw);
  store.on('planning', draw);
  draw();
}

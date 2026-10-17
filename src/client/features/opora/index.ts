/** Opora on the planning room's glass: the canvas's pipeline on its screen, and E there opens the 🛰️ Opora window. */
import type * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import type { Parts } from '../../core/parts';
import { store } from '../../state';
import { OporaScreenTexture } from './screen';
import { openOpora } from './ui';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    opora: true;
  }
}

export function installOpora(ctx: Ctx, parts: Pick<Parts, 'waiting'>, deps: { showPlanning(): void }) {
  function showOpora() {
    openOpora(ctx.net, { openTerminal: (id) => parts.waiting.openWorkerTerminal(id), showPlanning: deps.showPlanning });
  }

  ctx.interactions.define('opora', {
    reach: 7,
    hint: () => {
      const s = store.opora;
      const working = s.runs.filter((r) => r.state !== 'gone').length;
      const ready = s.cards.filter((c) => c.status === 'frontier').length;
      const what = !s.connected ? 'not running' : !s.project ? 'not linked' : `${ready} ready · ${working} in the office${s.autopilot ? ' · 🤖' : ''}`;
      return { k: what, parts: [hintTitle('🛰️ Opora'), aside(what), key('E', 'Open')] };
    },
    use: onE(() => showOpora()),
  });

  const screen = new OporaScreenTexture();
  const mat = ctx.office.oporaScreen.material as THREE.MeshBasicMaterial;
  mat.map = screen.texture;
  mat.needsUpdate = true;
  const draw = () => screen.render(store.opora);
  store.on('opora', draw);
  draw();

  return { showOpora };
}

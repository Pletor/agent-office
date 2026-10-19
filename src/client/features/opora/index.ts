/**
 * Opora on the planning room's glass: the canvas's pipeline on its screen, and E there opens the 🛰️ Opora
 * window. The boss's PC is the Opora workstation: from its chair, O opens the real Opora Canvas on the whole
 * screen, inside the office (or in a tab of its own while Opora won't be framed), see openFull.
 */
import type * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import type { Parts } from '../../core/parts';
import { canEmbedOpora } from '../../../shared/opora';
import { store } from '../../state';
import type { Arcade } from '../arcade/ui';
import { paintOporaCard } from './monitor';
import { OporaScreenTexture } from './screen';
import { openOporaFull, openOporaTab } from './full';
import { openOpora } from './ui';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    opora: true;
  }
}

export function installOpora(ctx: Ctx, parts: Pick<Parts, 'waiting'>, deps: { showPlanning(): void; arcade: Pick<Arcade, 'setOverlay'> }) {
  function showOpora() {
    openOpora(ctx.net, { openTerminal: (id) => parts.waiting.openWorkerTerminal(id), showPlanning: deps.showPlanning, openFull, embeddable });
  }

  /** Whether Opora lets this page frame it (its embed_origins lists the office's address). */
  function embeddable() {
    return canEmbedOpora(store.opora, location.origin);
  }

  /**
   * Opora on the whole screen, on the floor's linked project: inside the office when Opora lets itself
   * be framed by it, else the real Opora Canvas in its own browser tab (the same one each time, by name).
   * With Opora not running, the 🛰️ Opora window instead, which can start it. Call it straight from the
   * key or the click, or the browser blocks the new tab.
   */
  function openFull() {
    if (!store.opora.connected) return showOpora();
    if (embeddable()) return void openOporaFull(store.opora);
    // Let go of the mouse first: the office is left behind in its tab.
    ctx.player.unlock();
    openOporaTab(store.opora);
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
  const draw = () => {
    screen.render(store.opora);
    deps.arcade.setOverlay((g) => paintOporaCard(g, store.opora));
  };
  store.on('opora', draw);
  draw();

  return { showOpora, openFull };
}

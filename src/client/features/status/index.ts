/**
 * 🚦 The status wall ("Stav") over the gong: whether the office and Opora are healthy, each with a
 * traffic light and its reasons, checked by the office's server (see server/status/). E at it opens
 * the 🚦 Stav window with the details and links.
 */
import type * as THREE from 'three';
import type { StatusLight } from '../../../shared/protocol';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { store } from '../../state';
import { StatusScreenTexture } from './screen';
import { openStatus } from './ui';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    status: true;
  }
}

const DOT: Record<StatusLight, string> = { green: '🟢', amber: '🟠', red: '🔴', unknown: '⚪' };

export function installStatusWall(ctx: Ctx) {
  ctx.interactions.define('status', {
    reach: 9,
    hint: () => {
      const s = store.status;
      const what = s ? `Kancelář ${DOT[s.office.light]} · Opora ${DOT[s.opora.light]}` : 'zjišťuji…';
      return { k: what, parts: [hintTitle('🚦 Stav'), aside(what), key('E', 'Podrobnosti')] };
    },
    use: onE(() => openStatus(ctx.net)),
  });

  const screen = new StatusScreenTexture();
  const mat = ctx.office.statusScreen.material as THREE.MeshBasicMaterial;
  mat.map = screen.texture;
  mat.needsUpdate = true;
  const draw = () => screen.render(store.status, store.opora);
  store.on('status', draw);
  store.on('opora', draw);
  draw();
  // The wall is the same for the whole building: ask for it each time the page (re)joins.
  ctx.messages.on('welcome', () => ctx.net.send({ t: 'status.get' }));
}

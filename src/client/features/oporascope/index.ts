/**
 * 🎚️ The switchboard on the inside of the planning room's north glass: the Opora project's
 * architecture as a cascade (environment → domain → page → subpage), each node switched on or off.
 * What's on is what the cell works on (see shared/opora-scope.ts); E there opens it to switch.
 */
import type * as THREE from 'three';
import { cleanFocus, focusLine } from '../../../shared/opora-scope';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { store } from '../../state';
import { clip } from '../../ui/dom';
import { ScopeBoardTexture } from './screen';
import { openScope } from './ui';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    oporascope: true;
  }
}

export function installOporaScope(ctx: Ctx) {
  ctx.interactions.define('oporascope', {
    reach: 5,
    hint: () => {
      const s = store.opora;
      const what = !s.scope.length ? (s.connected ? 'bez architektury' : 'Opora neběží') : focusLine(s.scope, cleanFocus(s.scope, s.focus)) || 'celý projekt';
      return { k: what, parts: [hintTitle('🎚️ Zaměření'), aside(clip(what, 60)), key('E', 'Přepnout')] };
    },
    use: onE(() => openScope(ctx.net)),
  });

  const screen = new ScopeBoardTexture();
  const mat = ctx.office.oporaScopeBoard.material as THREE.MeshBasicMaterial;
  mat.map = screen.texture;
  mat.needsUpdate = true;
  const draw = () => screen.render(store.opora);
  store.on('opora', draw);
  draw();
}

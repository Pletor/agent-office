/**
 * 🎯 The orchestrator's card in the planning room (🧭 Opora Control Center). The deepest page or subpage
 * switched on at the 🎚️ switchboard on the north glass is the orchestrator's card (the server follows
 * the focus); it flies over to the purple board, whose ledge shows it, and E there opens its full detail
 * in both designs, Lens (návrh 1) and Design karta (návrh 2). The server gives the planner its overview.
 * `store.orchestrator.focus` is the card the whole room works on, for any screen that highlights it.
 */
import type * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { store } from '../../state';
import { clip, type Modal } from '../../ui/dom';
import { listenForLensEsc } from '../lens/diagram';
import { openScope } from '../oporascope/ui';
import { CardBeam } from './beam';
import { DetailLedgeTexture, focusedCard } from './board';
import { openDetail } from './detail';
import './ui.css';

declare module '../../world/types' {
  interface InteractKinds {
    carddetail: true;
  }
}

export function installOrchestrator(ctx: Ctx) {
  listenForLensEsc();
  let open: Modal | undefined;
  const showDetail = () => { open?.close(); open = openDetail({ openScope: () => { open?.close(); openScope(ctx.net); } }); };
  const what = () => {
    const shown = focusedCard({ state: store.orchestrator, opora: store.opora });
    return shown ? shown.name : !store.opora.project ? 'patro bez Opory' : 'žádná karta';
  };

  ctx.interactions.define('carddetail', {
    reach: 5,
    hint: () => ({ k: what(), parts: [hintTitle('🎯 Karta pro orchestrátora'), aside(clip(what(), 50)), key('E', 'Lens + Design karta')] }),
    use: onE(showDetail),
  });

  const { detail } = ctx.office.orchestratorBoards;
  const ledge = new DetailLedgeTexture();
  const mat = detail.material as THREE.MeshBasicMaterial;
  mat.map = ledge.texture;
  mat.needsUpdate = true;

  // The card flying from the switchboard to the purple board when it changes.
  const beam = new CardBeam();
  ctx.scene.add(beam.group);
  let seen = store.orchestrator.focus ? `${store.orchestrator.focus.cardId}@${store.orchestrator.focus.at}` : '';
  let lit = 0;
  const draw = (flash = lit) => ledge.render({ state: store.orchestrator, opora: store.opora }, flash);
  store.on('orchestrator', () => {
    const f = store.orchestrator.focus;
    const now = f ? `${f.cardId}@${f.at}` : '';
    if (now && now !== seen) beam.fly(focusedCard({ state: store.orchestrator, opora: store.opora })?.name ?? f!.name, performance.now());
    seen = now;
    draw();
  });
  store.on('opora', () => draw());
  ctx.ticks.add('world', ({ now }) => {
    const flying = beam.tick(now);
    const next = beam.lit(now);
    if (next !== lit || (flying && next)) { lit = next; draw(); }
  });
  draw();
}

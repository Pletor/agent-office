/**
 * 🎯 The orchestrator's boards in the planning room (🧭 Opora Control Center). The right board, the plate
 * over the 🎚️ switchboard on the north glass, picks the card the orchestrator focuses on (E there); the
 * purple board's ledge opens that card's full detail in both designs, Lens (návrh 1) and Design karta
 * (návrh 2) (E there). The server keeps the pick for the floor and gives the planner its overview.
 */
import type * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { store } from '../../state';
import { clip, type Modal } from '../../ui/dom';
import { listenForLensEsc } from '../lens/diagram';
import { DetailLedgeTexture, focusedCard, PickerPlateTexture } from './board';
import { openDetail } from './detail';
import { openPicker } from './picker';
import './ui.css';

declare module '../../world/types' {
  interface InteractKinds {
    cardpicker: true;
    carddetail: true;
  }
}

export function installOrchestrator(ctx: Ctx) {
  listenForLensEsc();
  let open: Modal | undefined;
  const swap = (next: () => Modal | undefined) => { open?.close(); open = next(); };
  const showPicker = () => swap(() => openPicker(ctx.net, { openDetail: showDetail }));
  function showDetail() { swap(() => openDetail({ openPicker: showPicker })); }
  const what = () => {
    const shown = focusedCard({ state: store.orchestrator, opora: store.opora });
    return shown ? shown.name : !store.opora.project ? 'patro bez Opory' : 'žádná karta';
  };

  ctx.interactions.define('cardpicker', {
    reach: 5,
    hint: () => ({ k: what(), parts: [hintTitle('🎯 Karta pro orchestrátora'), aside(clip(what(), 50)), key('E', 'Vybrat kartu')] }),
    use: onE(showPicker),
  });
  ctx.interactions.define('carddetail', {
    reach: 5,
    hint: () => ({ k: what(), parts: [hintTitle('🔎 Detail karty'), aside(clip(what(), 50)), key('E', 'Lens + Design karta')] }),
    use: onE(showDetail),
  });

  const { picker, detail } = ctx.office.orchestratorBoards;
  const plate = new PickerPlateTexture(), ledge = new DetailLedgeTexture();
  for (const [m, t] of [[picker, plate], [detail, ledge]] as const) {
    const mat = m.material as THREE.MeshBasicMaterial;
    mat.map = t.texture;
    mat.needsUpdate = true;
  }
  const draw = () => {
    const s = { state: store.orchestrator, opora: store.opora };
    plate.render(s);
    ledge.render(s);
  };
  store.on('orchestrator', draw);
  store.on('opora', draw);
  draw();
}

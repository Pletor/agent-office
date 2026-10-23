/**
 * 🛰️ The live canvas on the planning room's purple board, facing the door: while the floor is linked to
 * an Opora project, the orchestrator's card (the deepest page switched on at the 🎚️ switchboard, lit
 * as it lands) and its plan by layers, area → sector → node, read from Opora's canvas; for a design card
 * "Design karta v procesu"; and what the agents and the room just did. E there opens it to act on
 * (Pozastavit, Přeplánovat, Přidat stůl), P the planning room's window, O the real Opora Canvas.
 */
import type * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key } from '../../core/hint';
import { store } from '../../state';
import type { Modal } from '../../ui/dom';
import { BEAM_MS, LIT_MS } from '../orchestrator/beam';
import { isDesign, laneFor } from '../orchestrator/design';
import { CardReads, RoomNotes } from './data';
import { planView } from './model';
import { LiveCanvasTexture } from './screen';
import { openLiveWindow } from './window';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    oporalive: true;
  }
}

/** How often the board redraws while it's up, for its light, the working stage and how long ago things were. */
const REDRAW_MS = 1000;

export function installOporaLive(ctx: Ctx, deps: { openFull(): void; showPlanning(): void; openTerminal(workerId: string): void }) {
  const notes = new RoomNotes();
  let draw = () => {};
  const reads = new CardReads(() => draw());
  let open: Modal | undefined;
  const showWindow = () => { open?.close(); open = openLiveWindow({ net: ctx.net, reads, notes, changed: () => draw(), ...deps }); };

  ctx.interactions.define('oporalive', {
    reach: 6,
    hint: () => {
      const f = store.orchestrator.focus;
      const what = f ? `🎯 ${f.name}` : 'žádná karta';
      return { k: what, parts: [hintTitle('🛰️ Canvas živě'), aside(what), key('E', 'Zasáhnout'), key('P', 'Plán'), key('O', 'Editor Opory')] };
    },
    use: (_it, k) => {
      if (k === 'E') showWindow();
      if (k === 'P') deps.showPlanning();
      if (k === 'O') deps.openFull();
    },
  });

  const { face, use } = ctx.office.oporaLiveBoard;
  const screen = new LiveCanvasTexture();
  const mat = face.material as THREE.MeshBasicMaterial;
  mat.map = screen.texture;
  mat.needsUpdate = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  // The card lands when the chip from the switchboard does (orchestrator/beam.ts): the bar lights then.
  let seen = store.orchestrator.focus ? `${store.orchestrator.focus.cardId}@${store.orchestrator.focus.at}` : '';
  let landsAt = -Infinity;
  let litTimer: ReturnType<typeof setInterval> | undefined;
  draw = () => {
    const s = store.opora;
    const up = s.connected && !!s.project;
    face.visible = up;
    use.off = !up;
    const now = performance.now();
    const lit = now >= landsAt && now - landsAt < LIT_MS ? 1 - (now - landsAt) / LIT_MS : 0;
    if (up) {
      const card = s.cards.find((c) => c.id === store.orchestrator.focus?.cardId);
      const design = !!card && isDesign(card);
      reads.follow(store.floor, store.orchestrator.focus?.cardId, design);
      const lane = design ? laneFor(card) : undefined;
      screen.render({
        opora: s, orchestrator: store.orchestrator, planning: store.planning, plan: planView(s, store.orchestrator, reads.layers), notes: notes.list, lit,
        design: design ? { card: card!, lane: lane?.lane, worker: lane?.worker, preview: reads.preview, sketch: reads.sketch, shot: reads.shot } : undefined,
      });
    }
    if (up && !timer) timer = setInterval(draw, REDRAW_MS);
    else if (!up && timer) timer = void clearInterval(timer);
  };
  store.on('orchestrator', () => {
    const f = store.orchestrator.focus;
    const now = f ? `${f.cardId}@${f.at}` : '';
    if (now && now !== seen) {
      notes.add('Orchestrátor', `dostal kartu „${f!.name}“ od ${f!.by} (přehled se skládá)`, f!.at);
      landsAt = performance.now() + BEAM_MS;
      clearInterval(litTimer);
      // Faster redraws while the bar is lit, so it fades.
      litTimer = setInterval(() => { draw(); if (performance.now() - landsAt > LIT_MS) clearInterval(litTimer); }, 100);
    } else if (f?.cardId && store.orchestrator.briefAt && notes.list[0]?.what.includes('přehled se skládá')) {
      notes.add('Orchestrátor', `má přehled karty „${f.name}“ v zadání plánovače`, store.orchestrator.briefAt);
    }
    seen = now;
    draw();
  });
  store.on('opora', () => draw());
  store.on('planning', () => draw());
  draw();
}

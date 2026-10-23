import type { Ctx } from '../../core/context';
import { store } from '../../state';
import { addInspectorSection } from '../process-wall/inspector';
import { DesignPreviewSection } from './section';

const KEEP = 24;

/** A card on Opora's design pipeline, by the canvas or by the office's run of it. */
function isDesignCard(card: string): boolean {
  const c = store.opora.cards.find((x) => x.id === card);
  if (c) return c.group === 'design' || c.profile === 'design';
  return store.opora.runs.some((r) => r.cardId === card && r.group === 'design');
}

/**
 * "Jak to bude vypadat" in the process wall's card inspector, for a lane that is a design card on
 * Opora (nothing for any other). One section per card is kept, so the window's redraw on every event
 * moves it back in place instead of asking Opora again.
 */
export function installDesignPreview(_ctx: Ctx) {
  const kept = new Map<string, DesignPreviewSection>();
  addInspectorSection((lane) => {
    const card = lane.cardId, floor = store.floor;
    if (!card || !floor || !isDesignCard(card)) return null;
    const key = `${floor} ${card}`;
    let section = kept.get(key);
    if (!section) {
      section = new DesignPreviewSection(floor, card, () => store.opora.url || undefined);
      kept.set(key, section);
      while (kept.size > KEEP) { const [k, old] = kept.entries().next().value!; old.destroy(); kept.delete(k); }
    } else { kept.delete(key); kept.set(key, section); }
    const c = store.opora.cards.find((x) => x.id === card);
    section.update({ status: c?.status, stage: c?.stage, phase: lane.phase, moved: lane.marker !== 'none', branch: lane.branch, pr: lane.pr, working: lane.working });
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && section.root.contains(focused)) {
      // The inspector puts the section back right after this returns; the focus went with the old place.
      queueMicrotask(() => { if (focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true }); });
    }
    return section.root;
  });
}

import type { Ctx } from '../../core/context';
import { store } from '../../state';
import { addInspectorSection } from '../process-wall/inspector';
import { listenForLensEsc } from './diagram';
import { LensSection } from './ui';

const KEEP = 24;

/**
 * PR Lens in the office: a Lens section in the card inspector of the process wall's window, for a
 * lane that is an Opora card. One section per card is kept, so the window's redraw on every event
 * moves it back in place instead of asking Opora again (and gives focus back to what had it in there).
 */
export function installLens(_ctx: Ctx) {
  listenForLensEsc();
  const kept = new Map<string, LensSection>();
  addInspectorSection((lane) => {
    const card = lane.cardId, floor = store.floor;
    if (!card || !floor) return null;
    const key = `${floor} ${card}`;
    let section = kept.get(key);
    if (!section) {
      section = new LensSection(floor, card, () => store.opora.cards.find((c) => c.id === card)?.sectorId, () => store.opora.url || undefined);
      kept.set(key, section);
      while (kept.size > KEEP) { const [k, old] = kept.entries().next().value!; old.destroy(); kept.delete(k); }
    } else { kept.delete(key); kept.set(key, section); }
    section.refresh();
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && section.root.contains(focused)) {
      // The inspector puts the section back right after this returns; the focus went with the old place.
      queueMicrotask(() => { if (focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true }); });
    }
    return section.root;
  });
}

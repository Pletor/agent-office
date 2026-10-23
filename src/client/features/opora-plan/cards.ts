// The cards of the floor's Opora project as the "Lens plánu" tab lists them: searched, grouped by area,
// and a card as an inspector lane (its own lane on the wall when it has one, else a quiet one made from
// the card), so the inspector's sections (Lens, Jak to bude vypadat) show for any card. Pure.

import { PROCESS_PHASES, type OporaCard, type OporaCardStatus } from '../../../shared/protocol';
import type { Lane } from '../process-wall/lanes';

export const STATUS_CZ: Record<OporaCardStatus, string> = {
  frontier: 'na řadě', claimed: 'v práci', blocked: 'blokovaná', waiting: 'čeká', closed: 'hotovo', needsRouting: 'bez cesty',
};
export const UNASSIGNED = 'Nezařazeno';

export interface CardGroup { area: string; cards: OporaCard[] }

/** Lower case without diacritics, so "planu" finds "plánu". */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The cards whose name, id or area has every word of the query, by area (Nezařazeno last), each by name. */
export function groupCards(cards: readonly OporaCard[], query = ''): CardGroup[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const byArea = new Map<string, OporaCard[]>();
  for (const c of cards) {
    const area = c.sectorName?.trim() || UNASSIGNED;
    const hay = fold(`${c.name} ${c.id} ${area}`);
    if (!words.every((w) => hay.includes(w))) continue;
    byArea.set(area, [...(byArea.get(area) ?? []), c]);
  }
  return [...byArea].map(([area, list]) => ({ area, cards: list.sort((a, b) => a.name.localeCompare(b.name, 'cs')) }))
    .sort((a, b) => (a.area === UNASSIGNED ? 1 : 0) - (b.area === UNASSIGNED ? 1 : 0) || a.area.localeCompare(b.area, 'cs'));
}

/** The card's lane on the wall, or one made from the card alone: no events, no worker, no phase reached. */
export function cardLane(card: OporaCard, lanes: readonly Lane[]): { lane: Lane; onWall: boolean } {
  const own = lanes.find((l) => l.cardId === card.id);
  if (own) return { lane: own, onWall: true };
  return {
    onWall: false,
    lane: {
      key: `card:${card.id}`, name: card.name, chip: card.id.slice(0, 8), source: 'Opora', initials: '—', phase: 0, marker: 'none',
      trail: PROCESS_PHASES.map(() => null), lastAt: 0, events: [], cardId: card.id, working: false,
    },
  };
}

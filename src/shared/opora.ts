// The bridge to Opora Canvas, the part both sides use: which desks a card goes to, and reading
// Opora's answers. Opora plans (project → area → sector → card); the office carries the cards out.

import type { DeskLabel } from './floorplan.js';
import type { OporaCard, OporaCardStatus, OporaGroup, OporaState } from './protocol/opora.js';

/** Where Opora listens when nobody says (`uv run opora`'s default). */
export const OPORA_DEFAULT_URL = 'http://127.0.0.1:8740';
/** The most cards the office works on at once from Opora, and the default. */
export const OPORA_LIMITS = { maxRuns: 8, defaultRuns: 2 } as const;

export const EMPTY_OPORA: OporaState = {
  url: OPORA_DEFAULT_URL,
  connected: false,
  project: null,
  projects: [],
  workspace: null,
  sectors: [],
  cards: [],
  runs: [],
  autopilot: false,
  maxRuns: OPORA_LIMITS.defaultRuns,
  checkedAt: 0,
  canStart: false,
  starting: false,
};

/** The signs that make a desk a designer's or a developer's (see the 🪧 sign over a desk). */
const GROUP_SIGN: Record<OporaGroup, RegExp> = {
  design: /design|návrh|navrh|\bux\b|\bui\b/i,
  dev: /dev|vývoj|vyvoj|code|kód|kod|frontend|backend|engineer/i,
};

/** A card's desks: the designers' for a card on the design pipeline, the developers' for the rest. */
export function cardGroup(profile: string | undefined | null): OporaGroup {
  return profile === 'design' ? 'design' : 'dev';
}

/** The group a desk's sign puts it in, if any. */
export function signGroup(label: Pick<DeskLabel, 'text'> | undefined): OporaGroup | undefined {
  if (!label) return undefined;
  if (GROUP_SIGN.design.test(label.text)) return 'design';
  if (GROUP_SIGN.dev.test(label.text)) return 'dev';
  return undefined;
}

/**
 * The desk a card's worker sits at: a free one signed for its group (or for its sector, by name),
 * else a free desk with no group's sign, else any free one. `desks` are the floor's desks in order.
 */
export function deskFor(group: OporaGroup, sectorName: string | undefined, desks: readonly string[], labels: Record<string, Pick<DeskLabel, 'text'>>, taken: (id: string) => boolean): string | undefined {
  const free = desks.filter((d) => !taken(d));
  const sector = sectorName?.trim().toLowerCase();
  return (
    (sector && free.find((d) => labels[d]?.text.trim().toLowerCase() === sector)) ||
    free.find((d) => signGroup(labels[d]) === group) ||
    free.find((d) => !signGroup(labels[d])) ||
    free[0]
  );
}

/** Whether two folders are the same one, as Opora and the office each write it (Windows ignores case). */
export function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return /^[a-z]:/i.test(a) || /^[a-z]:/i.test(b) ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

const STATUSES: readonly OporaCardStatus[] = ['frontier', 'claimed', 'blocked', 'waiting', 'closed', 'needsRouting'];

interface FrontierRow {
  id?: unknown;
  name?: unknown;
  pipeline?: { profile?: unknown; current?: unknown } | null;
}

/**
 * The cards in one `frontier` answer, each in the group it's listed in. A card listed twice (a free
 * card with no pipeline is in `frontier` and `needsRouting`) keeps the first. `isCard` leaves out
 * sectors and areas, which the root frontier lists too.
 */
export function frontierCards(answer: unknown, isCard: (id: string) => boolean, sector?: { id: string; name: string }): OporaCard[] {
  const out: OporaCard[] = [];
  const seen = new Set<string>();
  if (!answer || typeof answer !== 'object') return out;
  for (const status of STATUSES) {
    const rows = (answer as Record<string, unknown>)[status];
    if (!Array.isArray(rows)) continue;
    for (const row of rows as FrontierRow[]) {
      const id = typeof row?.id === 'string' ? row.id : '';
      if (!id || seen.has(id) || !isCard(id)) continue;
      seen.add(id);
      const profile = typeof row.pipeline?.profile === 'string' ? row.pipeline.profile : undefined;
      const stage = typeof row.pipeline?.current === 'string' ? row.pipeline.current : row.pipeline?.current && typeof row.pipeline.current === 'object' ? String((row.pipeline.current as { id?: unknown; label?: unknown }).label ?? (row.pipeline.current as { id?: unknown }).id ?? '') || undefined : undefined;
      out.push({
        id,
        name: typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 200) : 'Card',
        ...(sector ? { sectorId: sector.id, sectorName: sector.name } : {}),
        status,
        ...(profile ? { profile } : {}),
        ...(stage ? { stage } : {}),
        group: cardGroup(profile),
      });
    }
  }
  return out;
}

/** An agent's name as Opora takes it (`[\w .:()-]`, no slash), for the card's worker. */
export function oporaAgentName(floorId: string, cardId: string): string {
  return `office-${floorId}-${cardId.slice(0, 8)}`.replace(/[^\w .:()-]/g, '-').slice(0, 80);
}

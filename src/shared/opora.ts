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
  workspaces: [],
  sectors: [],
  cards: [],
  scope: [],
  focus: [],
  activity: [],
  runs: [],
  autopilot: false,
  handOut: true,
  handOutWaiting: [],
  maxRuns: OPORA_LIMITS.defaultRuns,
  checkedAt: 0,
  canStart: false,
  starting: false,
  embeddable: false,
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

/** The browser tab Opora opens in from the office, by name, so opening it again goes back to the same tab. */
export const OPORA_TAB = 'opora-canvas';

/**
 * Opora Canvas itself, on the floor's linked project when there is one: Opora reads `?project=`,
 * `&workspace=` and `&screen=canvas` from its address (App.tsx), else it starts on its home screen.
 */
export function oporaCanvasUrl(s: Pick<OporaState, 'url' | 'project' | 'workspace'>): string {
  const base = s.url || OPORA_DEFAULT_URL;
  if (!s.project) return base;
  const q = new URLSearchParams({ project: s.project.id });
  if (s.workspace) q.set('workspace', s.workspace);
  q.set('screen', 'canvas');
  return `${base.replace(/\/+$/, '')}/?${q}`;
}

/**
 * Opora's address as the browser should reach it: on loopback, the same name the office's page is on
 * (localhost or 127.0.0.1), as Opora's SameSite=Strict sign-in cookie only goes to the same site the
 * page is from. Anywhere else, the address as it is.
 */
export function browserOporaUrl(oporaUrl: string, pageHostname: string): string {
  const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1';
  let url: URL;
  try {
    url = new URL(oporaUrl);
  } catch {
    return oporaUrl;
  }
  if (!loopback(url.hostname) || !loopback(pageHostname) || url.hostname === pageHostname) return oporaUrl;
  url.hostname = pageHostname;
  return url.toString();
}

/**
 * Whether Opora lets other pages frame it, from the headers of its GET /: CSP frame-ancestors when
 * it sends one (browsers then ignore X-Frame-Options), else X-Frame-Options, where DENY and
 * SAMEORIGIN both refuse the office (it's on another port, so another origin).
 */
export function oporaEmbedPolicy(xFrameOptions: string | null, csp: string | null): Pick<OporaState, 'embeddable' | 'embedOrigins'> {
  const directive = csp
    ?.split(';')
    .map((d) => d.trim().split(/\s+/))
    .find(([name]) => name?.toLowerCase() === 'frame-ancestors');
  if (directive) {
    const sources = directive.slice(1).filter((x) => x && x !== "'self'" && x.toLowerCase() !== "'none'");
    return sources.length ? { embeddable: true, embedOrigins: sources } : { embeddable: false };
  }
  const xfo = xFrameOptions?.trim().toLowerCase();
  return xfo === 'deny' || xfo === 'sameorigin' ? { embeddable: false } : { embeddable: true };
}

/** Whether Opora would let this page (its origin) frame it: a frame-ancestors source matching it, `*`, or none listed. */
export function canEmbedOpora(s: Pick<OporaState, 'connected' | 'embeddable' | 'embedOrigins'>, pageOrigin: string): boolean {
  if (!s.connected || !s.embeddable) return false;
  if (!s.embedOrigins) return true;
  const page = pageOrigin.replace(/\/+$/, '').toLowerCase();
  return s.embedOrigins.some((src) => {
    const o = src.replace(/\/+$/, '').toLowerCase();
    if (o === '*' || o === page) return true;
    // A port wildcard (http://localhost:*) matches the host on any port.
    return o.endsWith(':*') && page.startsWith(o.slice(0, -1)) && /^\d+$/.test(page.slice(o.length - 1));
  });
}

/** How soon a second Esc inside framed Opora has to follow the first to leave it (ms). */
export const OPORA_ESCAPE_WINDOW_MS = 700;

/**
 * Whether an Esc that Opora passed up (`opora:escape`) leaves Opora full screen: only a second one
 * within the window of the first, as Opora's own panels close on Esc without saying so and one Esc
 * should only close those. `lastAt` is when the one before arrived (undefined if none).
 */
export function oporaEscapeLeaves(lastAt: number | undefined, now: number, windowMs = OPORA_ESCAPE_WINDOW_MS): boolean {
  return lastAt !== undefined && now - lastAt >= 0 && now - lastAt <= windowMs;
}

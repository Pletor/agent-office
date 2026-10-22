// Reads PR Lens diagrams from Opora for the process wall's card inspector (GET /api/opora-lens):
// the card's newest PR lens and area map (`GET /api/oporahub/review-lens`) and its area's plan Lens
// (`GET /api/oporahub/plan-lens`). Read-only GETs with the office's usual X-Opora-Actor, no lease
// token and no write. Each answer is kept 30 s, so a window redrawn on every event doesn't ask
// again; a 404 (an Opora without the endpoint), a 428, a timeout or a refusal is an answer too.

import { lensGraph, PLAN_STATS, str, type CardLens, type LensView, type PlanLens, type PlanStats } from '../../shared/opora-lens.js';

const TTL_MS = 30_000;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 200;

type Fetch = typeof fetch;
type Read = { status: number; data?: unknown };

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const int = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);
/** Only the defined fields, so a reply carries no `undefined` keys. */
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function view(record: Record<string, unknown> | undefined): LensView {
  const graph = lensGraph(record?.spec);
  if (graph) return { graph };
  const note = record?.spec === undefined || record?.spec === null
    ? (typeof record?.specBytes === 'number' || record?.note === 'spec too large' ? 'Specifikace je větší než 64 KiB, Opora má jen její velikost a otisk.' : 'Opora nemá specifikaci diagramu.')
    : 'Záznam není graf PR Lens.';
  return { graph: null, note };
}

/** Opora's `review-lens` answer as the window shows it. */
export function cardLens(r: Read): CardLens {
  if (r.status === 404) return { state: 'missing' };
  const d = r.status === 200 ? obj(r.data) : undefined;
  if (!d) return { state: 'unavailable' };
  const out: CardLens = { state: 'none' };
  const lens = obj(d.lens);
  if (lens) {
    out.pr = defined({
      ...view(lens),
      number: int(d.number) ?? int(lens.prNumber), repository: str(d.repository, 120), prState: str(d.prState, 20),
      current: typeof d.current === 'boolean' ? d.current : undefined, headSha: str(lens.headSha, 40), by: str(d.by, 80),
      createdAt: str(d.createdAt, 40), specBytes: int(lens.specBytes),
    });
  }
  const area = obj(d.area);
  if (area) out.area = defined({ ...view(obj(area.lens)), by: str(area.by, 80), createdAt: str(area.createdAt, 40), acceptedRevision: int(area.acceptedRevision) });
  if (out.pr || out.area) out.state = 'ok';
  return out;
}

/** Opora's `plan-lens` answer as the window shows it. */
export function planLens(r: Read): PlanLens {
  if (r.status === 404) return { state: 'missing' };
  const d = r.status === 200 ? obj(r.data) : undefined;
  if (!d) return { state: 'unavailable' };
  if (d.spec === undefined || d.spec === null) return { state: 'none' };
  const raw = obj(d.stats), stats: PlanStats = {};
  for (const k of PLAN_STATS) { const v = int(raw?.[k]); if (v !== undefined && v >= 0) stats[k] = v; }
  const confirmed = confirmedCards(d.spec);
  if (confirmed !== undefined) stats.confirmed = confirmed;
  const g = obj(d.graphify);
  const graphify = g ? defined({ available: g.available === true, sourceRevision: str(g.sourceRevision, 80) }) : undefined;
  return defined({ state: 'ok' as const, area: str(d.area, 80), digest: str(d.digest, 80), stats: Object.keys(stats).length ? stats : undefined, graphify, view: view({ spec: d.spec }) });
}

/**
 * Cards a human closed (`done.confirmed`), counted from the whole plan spec before it is capped:
 * a card node with the badge `hotovo`, or an area or "Nezařazeno" group with `N/M hotovo`.
 */
export function confirmedCards(spec: unknown): number | undefined {
  const nodes = obj(spec)?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  let n = 0;
  for (const node of nodes) {
    const badges = obj(node)?.badges;
    if (!Array.isArray(badges)) continue;
    for (const b of badges) {
      if (b === 'hotovo') n++;
      else if (typeof b === 'string') { const m = /^(\d{1,6})\/\d{1,6} hotovo$/.exec(b); if (m) n += Number(m[1]); }
    }
  }
  return n;
}

/** The two Opora reads, cached by Opora address, project, workspace and card or area. */
export class LensReader {
  private cache = new Map<string, { at: number; value: Promise<Read> }>();

  constructor(private fetcher: Fetch = fetch, private now: () => number = Date.now) {}

  card(base: string, agent: string, project: string, workspace: string, nodeId: string): Promise<CardLens> {
    return this.read(base, agent, '/api/oporahub/review-lens', { project, workspace, nodeId }).then(cardLens);
  }

  plan(base: string, agent: string, project: string, workspace: string, area?: string): Promise<PlanLens> {
    return this.read(base, agent, '/api/oporahub/plan-lens', { project, workspace, ...(area ? { area } : {}) }).then(planLens);
  }

  private read(base: string, agent: string, path: string, query: Record<string, string>): Promise<Read> {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const key = `${agent} ${url.href}`;
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < TTL_MS) return hit.value;
    for (const [k, v] of this.cache) if (now - v.at >= TTL_MS) this.cache.delete(k);
    while (this.cache.size >= MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    const value = this.get(url, agent);
    this.cache.set(key, { at: now, value });
    return value;
  }

  private async get(url: URL, agent: string): Promise<Read> {
    try {
      const res = await this.fetcher(url, { method: 'GET', redirect: 'error', headers: { Accept: 'application/json', 'X-Opora-Actor': `agent; name=${agent}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) { void res.body?.cancel().catch(() => undefined); return { status: res.status }; }
      const text = await res.text();
      if (text.length > MAX_BYTES) return { status: 413 };
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      return { status: 0 };
    }
  }
}

export const lensReader = new LensReader();

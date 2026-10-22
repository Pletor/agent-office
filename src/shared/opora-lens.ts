// PR Lens diagrams read from Opora for the process wall's card inspector (GET /api/opora-lens):
// the card's newest PR lens and area map (Opora's `GET /api/oporahub/review-lens`) and its area's
// plan Lens (`GET /api/oporahub/plan-lens`). A spec is a PR Lens graph document that agents wrote,
// so it's untrusted data: `lensGraph` keeps only the fields the window shows, as capped plain
// strings, and the page renders them as text, never as HTML.

export type LensDelta = 'added' | 'modified' | 'removed' | 'unchanged';

export interface LensFile { path: string; lines?: string }
export interface LensNode { id: string; label: string; kind: string; delta: LensDelta; summary?: string; files: LensFile[]; badges: string[] }
export interface LensLane { id: string; label: string; delta?: LensDelta; nodes: LensNode[] }
/** An edge between two node ids. `code` marks a link found in code (Graphify, `emphasis: muted`), not drawn by default. */
export interface LensEdge { from: string; to: string; kind: string; delta: LensDelta; label?: string; hero: boolean; code: boolean }
/** One step of a flow: a message between two node ids, or only a caption. */
export interface LensStep { from?: string; to?: string; label?: string }
export interface LensFlow { title: string; steps: LensStep[] }

/** The part of a PR Lens graph document the window shows. */
export interface LensGraph {
  title: string;
  summary?: string;
  lanes: LensLane[];
  edges: LensEdge[];
  flows: LensFlow[];
  /** Something was left out to keep it small (more lanes, cards, edges or files than shown). */
  truncated: boolean;
}

/** One diagram as the window gets it: the graph, or why there's none (too large, not a graph). */
export interface LensView {
  graph: LensGraph | null;
  note?: string;
}

/** Why a side has nothing to show: none recorded, Opora without the endpoint, Opora not answering. */
export type LensAbsence = 'none' | 'missing' | 'unavailable';

export interface CardLens {
  state: 'ok' | LensAbsence;
  /** The newest PR lens. */
  pr?: LensView & { number?: number; repository?: string; prState?: string; current?: boolean; headSha?: string; by?: string; createdAt?: string; specBytes?: number };
  /** The newest area map (drawn before code existed). */
  area?: LensView & { by?: string; createdAt?: string; acceptedRevision?: number };
}

/** Opora's numbers for a plan Lens (whitelisted), plus `confirmed`: cards a human closed (`hotovo`), counted by the office. */
export interface PlanStats { areas?: number; cards?: number; withCode?: number; planned?: number; standalone?: number; unassigned?: number; confirmed?: number }
export const PLAN_STATS = ['areas', 'cards', 'withCode', 'planned', 'standalone', 'unassigned'] as const;

export interface PlanLens {
  state: 'ok' | LensAbsence;
  area?: string;
  digest?: string;
  stats?: PlanStats;
  graphify?: { available: boolean; sourceRevision?: string };
  view?: LensView;
}

export interface OporaLensReply {
  /** The floor is linked to an Opora project and workspace. */
  linked: boolean;
  /** Opora's address, for "Otevřít v Opoře". */
  base?: string;
  nodeId: string;
  card: CardLens;
  plan: PlanLens;
}

const DELTAS: readonly LensDelta[] = ['added', 'modified', 'removed', 'unchanged'];
const MAX = { lanes: 12, nodes: 60, perLane: 16, files: 4, badges: 4, edges: 40, flows: 6, steps: 10 };

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** A one-line string without control characters, cut to `n`. */
export function str(v: unknown, n = 120): string | undefined {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return s ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : undefined;
}
const delta = (v: unknown): LensDelta | undefined => (DELTAS.includes(v as LensDelta) ? (v as LensDelta) : undefined);
const int = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

function file(v: unknown): LensFile | undefined {
  const f = obj(v);
  const path = str(f?.path, 160);
  if (!path) return undefined;
  const a = int(f?.startLine), b = int(f?.endLine);
  return { path, ...(a !== undefined ? { lines: b !== undefined && b !== a ? `${a}–${b}` : String(a) } : {}) };
}

/** A PR Lens graph document (`kind: graph`) as the window shows it, or null for anything else. */
export function lensGraph(spec: unknown): LensGraph | null {
  const d = obj(spec);
  if (!d || d.kind !== 'graph') return null;
  let truncated = false;
  const lanes: LensLane[] = [];
  const byLane = new Map<string, LensLane>();
  for (const raw of arr(d.lanes)) {
    const l = obj(raw), id = str(l?.id, 80);
    if (!id || byLane.has(id)) continue;
    if (lanes.length >= MAX.lanes) { truncated = true; break; }
    const lane: LensLane = { id, label: str(l?.label) ?? id, ...(delta(l?.delta) ? { delta: delta(l?.delta) } : {}), nodes: [] };
    lanes.push(lane);
    byLane.set(id, lane);
  }
  let count = 0;
  for (const raw of arr(d.nodes)) {
    const n = obj(raw), id = str(n?.id, 80), lane = byLane.get(str(n?.lane, 80) ?? '');
    if (!id) continue;
    const label = str(n?.label) ?? id;
    if (!lane) continue;
    if (count >= MAX.nodes || lane.nodes.length >= MAX.perLane) { truncated = true; continue; }
    const files = arr(n?.files).map(file).filter((f): f is LensFile => !!f);
    const badges = arr(n?.badges).map((b) => str(b, 24)).filter((b): b is string => !!b);
    if (files.length > MAX.files || badges.length > MAX.badges) truncated = true;
    const summary = str(n?.summary, 240);
    lane.nodes.push({ id, label, kind: str(n?.kind, 24) ?? 'other', delta: delta(n?.delta) ?? 'unchanged', ...(summary ? { summary } : {}), files: files.slice(0, MAX.files), badges: badges.slice(0, MAX.badges) });
    count++;
  }
  const edges: LensEdge[] = [];
  for (const raw of arr(d.edges)) {
    const e = obj(raw), from = str(e?.from, 80), to = str(e?.to, 80);
    if (!from || !to) continue;
    if (edges.length >= MAX.edges) { truncated = true; break; }
    const label = str(e?.label, 80);
    edges.push({ from, to, kind: str(e?.kind, 24) ?? 'other', delta: delta(e?.delta) ?? 'unchanged', ...(label ? { label } : {}), hero: e?.emphasis === 'hero', code: e?.emphasis === 'muted' || label === 'kód' });
  }
  const flows: LensFlow[] = [];
  for (const raw of arr(d.flows)) {
    const f = obj(raw), title = str(f?.title);
    if (!title) continue;
    if (flows.length >= MAX.flows) { truncated = true; break; }
    const msgs = arr(f?.messages ?? f?.steps);
    if (msgs.length > MAX.steps) truncated = true;
    const steps = msgs.slice(0, MAX.steps).map((m): LensStep | undefined => {
      const s = obj(m), from = str(s?.from, 80), to = str(s?.to, 80), label = str(s?.label ?? s?.title, 160);
      if (from && to) return { from, to, ...(label ? { label } : {}) };
      return label ? { label } : undefined;
    }).filter((s): s is LensStep => !!s);
    flows.push({ title, steps });
  }
  const summary = str(d.summary, 400);
  return { title: str(d.title, 160) ?? 'PR Lens', ...(summary ? { summary } : {}), lanes, edges, flows, truncated };
}

/** The Opora link that opens the card on its Lens tab, only for an http(s) Opora address. */
export function oporaLensUrl(base: string | undefined, nodeId: string): string | undefined {
  if (!base) return undefined;
  try {
    const u = new URL(base);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return undefined;
    const link = new URL('/', u.origin);
    link.searchParams.set('ohCard', nodeId);
    link.searchParams.set('ohTab', 'lens');
    return link.href;
  } catch {
    return undefined;
  }
}

/** Canvas ids as Opora takes them (`nodeId` ≤ 80). */
export const LENS_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

// What's inside one page of the project (a card of the 🎚️ switchboard's cascade) on Opora's infinite
// canvas, for the purple board's "Canvas živě" and the orchestrator's overview (GET /api/opora-layers):
// the page's own settings as Opora keeps them (what it's for, its route and source file, its goal,
// non-goals and acceptance, its working and accepted plan steps, the project's settings) and the layers
// laid out inside it: areas, the sectors in them and their nodes (cards), with each card's own fields.
// Everything is data agents or people wrote on Opora: whitelisted fields, capped plain strings.

import { str } from './opora-lens.js';

export type LayerKind = 'area' | 'sector' | 'node';

/** One area, sector or node inside the page. */
export interface LayerNode {
  id: string;
  kind: LayerKind;
  name: string;
  parentId: string;
  purpose?: string;
  /** The card's own fields on the canvas (draft, ready, done…), when it's a card. */
  card?: { status?: string; layer?: string; model?: string; effort?: string };
  /** How many checks it must pass. */
  checks?: number;
  /** Where it sits on the canvas, and an area's size, to put sectors and nodes into the area they're drawn in. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/** A page's settings on Opora. */
export interface PageSettings {
  purpose?: string;
  /** Its route in the app (`/oracle/paid`) and its kind (`page`). */
  route?: string;
  /** The source file the canvas ties it to. */
  source?: string;
  goal?: string;
  nonGoals?: string;
  acceptance?: string;
  /** Its plan steps on Opora: the working copy and the accepted one (null: none accepted yet). */
  working: string[];
  accepted: string[] | null;
}

export interface OporaLayersReply {
  linked: boolean;
  base?: string;
  nodeId: string;
  /** ok: Opora answered; missing: the node isn't on the canvas; unavailable: no answer. */
  state: 'ok' | 'missing' | 'unavailable';
  name?: string;
  settings?: PageSettings;
  /** The project's settings (platform, architecture, tenancy, goal). */
  project?: Record<string, string>;
  layers: LayerNode[];
}

/** Caps on what's kept. */
export const LAYERS_MAX = { nodes: 160, depth: 4, steps: 12 } as const;

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;
const KINDS = new Set<LayerKind>(['area', 'sector', 'node']);

/** The page's own node and what's inside it, from Opora's `/api/view` graph. */
export function parseLayers(view: unknown, nodeId: string): { node?: Record<string, unknown>; layers: LayerNode[] } {
  const nodes = obj(obj(view)?.graph)?.nodes;
  if (!Array.isArray(nodes)) return { layers: [] };
  const all = nodes.map(obj).filter((n): n is Record<string, unknown> => !!n && typeof n.id === 'string');
  const node = all.find((n) => n.id === nodeId);
  if (!node) return { layers: [] };
  const kids = new Map<string, Record<string, unknown>[]>();
  for (const n of all) if (typeof n.parentId === 'string') kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  const layers: LayerNode[] = [];
  const walk = (id: string, depth: number) => {
    for (const n of kids.get(id) ?? []) {
      if (layers.length >= LAYERS_MAX.nodes || depth > LAYERS_MAX.depth) return;
      const kind = n.kind as LayerKind;
      if (!KINDS.has(kind)) continue;
      // A subpage is a page of its own (the switchboard's next column), not a layer of this one.
      if (kind === 'node' && obj(n.site)?.kind === 'page') continue;
      const card = obj(n.card), size = obj(n.size);
      layers.push(defined({
        id: n.id as string, kind, name: str(n.name, 120) ?? '', parentId: id, purpose: str(n.purpose, 240),
        card: card ? defined({ status: str(card.status, 20), layer: str(card.layer, 30), model: str(card.model, 30), effort: str(card.effort, 20) }) : undefined,
        checks: Array.isArray(n.checks) ? n.checks.length : undefined,
        x: num(n.x), y: num(n.y), w: num(size?.w), h: num(size?.h),
      }));
      walk(n.id as string, depth + 1);
    }
  };
  walk(nodeId, 1);
  return { node, layers };
}

const stepTitles = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).map((s) => str(obj(s)?.title ?? s, 120)).filter((s): s is string => !!s).slice(0, LAYERS_MAX.steps);

/** A page's settings from its node on the canvas and its `/api/node-spec`. */
export function pageSettings(node: Record<string, unknown> | undefined, spec: unknown): PageSettings {
  const site = obj(node?.site), src = obj(node?.sourceRef), s = obj(spec), f = obj(s?.fields), plan = obj(s?.plan);
  return defined({
    purpose: str(node?.purpose, 300), route: str(site?.path, 120), source: str(src?.path, 160),
    goal: str(f?.goal, 300), nonGoals: str(f?.non_goals, 200), acceptance: str(f?.acceptance, 300),
    working: stepTitles(plan?.working), accepted: Array.isArray(plan?.accepted) ? stepTitles(plan.accepted) : null,
  }) as PageSettings;
}

/** The project's settings from `/api/project-settings`: short plain values only. */
export function projectSettings(reply: unknown): Record<string, string> | undefined {
  const s = obj(obj(reply)?.settings);
  if (!s) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(s).slice(0, 12)) { const t = str(v, 120); if (t && /^[A-Za-z_]{1,30}$/.test(k)) out[k] = t; }
  return Object.keys(out).length ? out : undefined;
}

/** A sector and its nodes, or nodes laid in an area without a sector. */
export interface LayerSector { sector?: LayerNode; nodes: LayerNode[] }
/** An area and what's drawn in it; the area is absent for what's outside every area. */
export interface LayerArea { area?: LayerNode; sectors: LayerSector[] }

const inside = (a: LayerNode, n: LayerNode) =>
  a.x !== undefined && a.y !== undefined && a.w !== undefined && a.h !== undefined && n.x !== undefined && n.y !== undefined &&
  n.x >= a.x && n.y >= a.y && n.x <= a.x + a.w && n.y <= a.y + a.h;

/**
 * The page's layers as the board shows them: area → sector → node. A sector or a loose node goes to
 * the area it's drawn in (an area is a frame on the canvas); nodes of a sector go with their sector.
 */
export function layerTree(layers: readonly LayerNode[], root: string): LayerArea[] {
  const top = layers.filter((l) => l.parentId === root);
  const areas = top.filter((l) => l.kind === 'area');
  const out: LayerArea[] = areas.map((area) => ({ area, sectors: [] }));
  const loose: LayerArea = { sectors: [] };
  const home = (n: LayerNode) => out.find((a) => inside(a.area!, n)) ?? loose;
  for (const s of top.filter((l) => l.kind === 'sector')) {
    home(s).sectors.push({ sector: s, nodes: layers.filter((l) => l.parentId === s.id && l.kind === 'node') });
  }
  for (const n of top.filter((l) => l.kind === 'node')) {
    const a = home(n);
    let bucket = a.sectors.find((s) => !s.sector);
    if (!bucket) a.sectors.push((bucket = { nodes: [] }));
    bucket.nodes.push(n);
  }
  if (loose.sectors.length) out.push(loose);
  return out;
}

/** How many areas, sectors and nodes the page has inside it. */
export function layerCounts(layers: readonly LayerNode[]): Record<LayerKind, number> {
  const c: Record<LayerKind, number> = { area: 0, sector: 0, node: 0 };
  for (const l of layers) c[l.kind]++;
  return c;
}

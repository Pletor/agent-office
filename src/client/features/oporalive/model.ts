// The purple board's plan, as both the board and its window show it: the orchestrator's card (the
// deepest page switched on at the 🎚️ switchboard) and the layers inside it on Opora's canvas, area →
// sector → node, each node with its state on the canvas and the office's worker on it.

import { layerTree, type LayerArea, type LayerNode, type OporaLayersReply } from '../../../shared/opora-layers';
import { ancestry, childrenOf } from '../../../shared/opora-scope';
import type { OporaRun, OporaScopeNode, OporaState, OrchestratorState } from '../../../shared/protocol';

/** A node's state, its colour and words, as the design draws them. */
export type NodeTone = 'run' | 'done' | 'human' | 'block' | 'free' | 'draft' | 'ready';
export const TONE: Record<NodeTone, [string, string]> = {
  run: ['#5bc0eb', 'běží'], done: ['#38d9a9', 'hotovo'], human: ['#ffd166', 'čeká na člověka'], block: ['#ef476f', 'blokováno'],
  free: ['#ffffff', 'volná karta'], draft: ['#e9ecef', 'koncept'], ready: ['#efe4fb', 'připravená'],
};

export interface NodeView { node: LayerNode; tone: NodeTone; worker?: string; workerId?: string; free: boolean }
export interface SectorView { id: string; name: string; sector?: LayerNode; nodes: NodeView[]; done: number; working: number }
export interface AreaView { name: string; area?: LayerNode; sectors: SectorView[] }

export interface PlanView {
  /** The orchestrator's card, if there is one. */
  cardId?: string;
  name?: string;
  /** Its way down: environment, domain, page, subpage. */
  path: OporaScopeNode[];
  /** The layers inside it, once read; empty while there are none. */
  areas: AreaView[];
  counts: { area: number; sector: number; node: number };
  /** Its subpages, when it's a page that has them (each is a card of its own at the switchboard). */
  subpages: OporaScopeNode[];
  read: 'none' | 'reading' | 'ok' | 'missing' | 'unavailable';
}

function tone(id: string, raw: LayerNode['card'], o: OporaState, run?: OporaRun): NodeTone {
  if (run?.state === 'working') return 'run';
  const c = o.cards.find((x) => x.id === id);
  switch (c?.status) {
    case 'claimed': return 'run';
    case 'closed': return 'done';
    case 'waiting': return 'human';
    case 'blocked': return 'block';
    case 'frontier': return 'free';
  }
  return raw?.status === 'done' ? 'done' : raw?.status === 'ready' ? 'ready' : 'draft';
}

function nodeView(n: LayerNode, o: OporaState): NodeView {
  const run = o.runs.find((r) => r.cardId === n.id && r.state !== 'gone');
  const t = tone(n.id, n.card, o, run);
  const free = o.cards.some((c) => c.id === n.id && c.status === 'frontier') && !run;
  return { node: n, tone: t, free, ...(run ? { worker: run.workerName ?? 'pracovník', ...(run.workerId ? { workerId: run.workerId } : {}) } : {}) };
}

function sectorView(id: string, name: string, nodes: NodeView[], sector?: LayerNode): SectorView {
  return { id, name, sector, nodes, done: nodes.filter((n) => n.tone === 'done').length, working: nodes.filter((n) => n.tone === 'run').length };
}

/** The plan for the orchestrator's card from the floor's state and the read of its layers. */
export function planView(o: OporaState, orch: OrchestratorState, layers?: OporaLayersReply): PlanView {
  const id = orch.focus?.cardId;
  const counts = { area: 0, sector: 0, node: 0 };
  if (!id) return { path: [], areas: [], counts, subpages: [], read: 'none' };
  const by = new Map(o.scope.map((n) => [n.id, n]));
  const path = ancestry(o.scope, id).reverse().map((x) => by.get(x)!).filter(Boolean);
  const name = by.get(id)?.name ?? o.cards.find((c) => c.id === id)?.name ?? orch.focus!.name;
  const subpages = childrenOf(o.scope, id);
  const read = !layers || layers.nodeId !== id ? 'reading' : layers.state;
  const areas: AreaView[] = read === 'ok'
    ? layerTree(layers!.layers, id).map((a: LayerArea) => ({
      name: a.area?.name ?? 'mimo oblasti', area: a.area,
      sectors: a.sectors.map((s, i) => sectorView(s.sector?.id ?? `${a.area?.id ?? 'loose'}:${i}`, s.sector?.name ?? 'uzly bez sektoru', s.nodes.map((n) => nodeView(n, o)), s.sector)),
    }))
    : [];
  if (read === 'ok') for (const l of layers!.layers) counts[l.kind]++;
  return { cardId: id, name, path, areas, counts, subpages, read };
}

/** Who someone is, by their initial, for the node's avatar. */
export const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

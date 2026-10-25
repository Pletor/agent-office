// Where a node of Opora's canvas sits in the harness cascade: the way down from the project to it,
// one node per level (page › layer › area › sector › task), each named by its Opora key. The levels
// are read from the canvas's real parents and `memberOf` (docs/opora-identity.md), never from a name
// or a position, and a node the canvas doesn't know is a task on its own, as the 3-level store had it.
//
// Contract and convention: kinds, parents and `memberOf` are Opora's contract. Which card above the
// sector is the "layer" is only Opora's convention of nesting one card (`[vrstva NN]`) under the page,
// so it's read from the shape alone (the innermost card above the sector) and a canvas without that
// nesting, or without `memberOf` (Opora before areas had members), simply has no layer or no area.
import { oporaKey, parseOporaKey, refuseForeign, type OporaPlace } from './opora-identity.js';
import type { HarnessPath, HarnessPathNode } from './harness-cascade.js';

/** What the hierarchy needs of a canvas node. */
export interface HierarchyNode { id: string; kind: 'node' | 'sector' | 'area'; name: string; parentId: string | null; memberOf?: string }
export function harnessIndex(nodes: readonly HierarchyNode[]) {
  const byId = new Map(nodes.map(n => [n.id, n])), children = new Map<string, HierarchyNode[]>();
  for (const node of nodes) if (node.parentId && node.kind !== 'area') {
    const list = children.get(node.parentId) ?? []; list.push(node); children.set(node.parentId, list);
  }
  return { byId, children };
}
type HierarchyIndex = ReturnType<typeof harnessIndex>;
function areaAt(index: HierarchyIndex, id: string): string | undefined {
  const node = index.byId.get(id), area = node?.memberOf ? index.byId.get(node.memberOf) : undefined;
  return area?.kind === 'area' && area.parentId === node?.parentId ? area.id : undefined;
}

/**
 * The node's path: the nodes above it on the canvas, outermost first, each at its level.
 *
 * - A root sector (no parent) is the project's domain, not a level of its own: the project's layer covers it.
 * - The deepest sector above the node (or the node, when it is one) is the `sector`; the area that
 *   sector (or else the node) is a `memberOf` is the `area`.
 * - The cards above the sector are the `page` (the outermost) and the `layer` (the innermost, when
 *   there are two or more); any in between have no level and set nothing.
 * - A card under a sector is a `task`, children or not (cards between the sector and it have no level).
 *   This is a decision, not a reading of the canvas: a sub-card is work of the card above it, so the
 *   sub-card is the task of its own handoff and the card above it sets nothing for it; the sector and
 *   what's above are shared by both. With no sector above it, a card with nothing under it is a `task`
 *   and one with children is a page or a layer.
 * - An area addressed by its own key is the `area` of its path (it is never a parent, so nothing is under it).
 * - A node id the canvas doesn't have is a task with nothing above it, so a custom task id keeps working.
 */
export function harnessPath(nodes: readonly HierarchyNode[], place: OporaPlace, nodeId: string, index = harnessIndex(nodes)): HarnessPath {
  const { byId } = index;
  const self = byId.get(nodeId);
  const key = (id: string) => oporaKey(place, id);
  if (!self) return [{ level: 'task', node: key(nodeId) }];
  // Malformed ancestry cannot silently drop an inherited scope.
  const up: HierarchyNode[] = [];
  for (let at: HierarchyNode | undefined = self; at; at = at.parentId ? byId.get(at.parentId) : undefined) {
    if (up.includes(at)) throw new Error('Canvas hierarchy contains a parent cycle.');
    if (at.parentId && !byId.has(at.parentId)) throw new Error('Canvas hierarchy contains a missing parent.');
    up.push(at);
  }
  const down = up.reverse().filter((n) => !(n.kind === 'sector' && !n.parentId));
  const hasChildren = (id: string) => !!index.children.get(id)?.length;
  const last = down[down.length - 1];
  const sectorAt = down.map((n) => n.kind).lastIndexOf('sector');
  const sector = sectorAt >= 0 ? down[sectorAt] : undefined;
  const task = last && last.kind === 'node' && (sector || !hasChildren(last.id)) ? last : undefined;
  const above = (sector ? down.slice(0, sectorAt) : down.filter((n) => n !== task)).filter((n) => n.kind === 'node');
  const area = self.kind === 'area' ? self.id : (sector && areaAt(index, sector.id)) || (task && areaAt(index, task.id)) || undefined;
  const entry = (level: HarnessPathNode['level'], n: HierarchyNode | undefined): HarnessPathNode[] => (n ? [{ level, node: key(n.id), ...(n.name ? { name: n.name } : {}) }] : []);
  return [
    ...entry('page', above[0]),
    ...entry('layer', above.length > 1 ? above[above.length - 1] : undefined),
    ...entry('area', area ? byId.get(area) : undefined),
    ...entry('sector', sector),
    ...entry('task', task),
  ];
}

/**
 * Why a save at the level `harnessPath` gives `nodeId` could reach no task: the node is a card above the
 * sectors that is neither the page (the outermost card) nor the layer of anything under it (no sector
 * and no leaf card right under it), so no task's path goes through it at any level. Undefined when
 * something can inherit from it, or the canvas doesn't have the node.
 */
export function harnessDeadEnd(nodes: readonly HierarchyNode[], nodeId: string, index = harnessIndex(nodes)): string | undefined {
  const { byId } = index;
  const self = byId.get(nodeId);
  if (!self || self.kind !== 'node') return undefined;
  const children = index.children.get(nodeId) ?? [];
  if (!children.length) return undefined;
  for (let at = self.parentId ? byId.get(self.parentId) : undefined, seen = new Set<string>([self.id]); at && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
    seen.add(at.id);
    if (at.kind === 'sector' && at.parentId) return undefined; // a root sector is the project, not a sector above
  }
  const outermost = !self.parentId || byId.get(self.parentId)?.kind !== 'node';
  if (outermost) return undefined;
  const reaches = children.some((c) => c.kind === 'sector' || (c.kind === 'node' && !index.children.get(c.id)?.length));
  if (reaches) return undefined;
  return `"${self.name || nodeId}" is a card between the page and the layers under it: no task's path goes through it, so a layer saved here would reach nothing. Save at the page above it or at the layer right above a sector.`;
}

/**
 * The path for what a caller addressed: an Opora key of this place is looked up on the canvas, a key
 * of another project or workspace is refused (the reason is thrown), and anything else is a custom
 * task id with nothing above it.
 */
export function harnessTarget(nodes: readonly HierarchyNode[], place: OporaPlace | undefined, id: string): HarnessPath {
  if (!id) return [];
  const at = parseOporaKey(id);
  if (!at) return [{ level: 'task', node: id }];
  if (!place) return [{ level: 'task', node: id }];
  const foreign = refuseForeign(place, id);
  if (foreign) throw new Error(foreign);
  return harnessPath(nodes, place, at.nodeId);
}

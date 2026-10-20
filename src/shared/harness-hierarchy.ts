// Where a node of Opora's canvas sits in the harness cascade: the way down from the project to it,
// one node per level (page › layer › area › sector › task), each named by its Opora key. The levels
// are read from the canvas's real parents and `memberOf` (docs/opora-identity.md), never from a name
// or a position, and a node the canvas doesn't know is a task on its own, as the 3-level store had it.
//
// Contract and convention: kinds, parents and `memberOf` are Opora's contract. Which card above the
// sector is the "layer" is only Opora's convention of nesting one card (`[vrstva NN]`) under the page,
// so it's read from the shape alone (the innermost card above the sector) and a canvas without that
// nesting, or without `memberOf` (Opora before areas had members), simply has no layer or no area.
import { areaOf, oporaKey, parseOporaKey, refuseForeign, type OporaPlace } from './opora-identity.js';
import type { CanvasNode } from './opora-scope.js';
import type { HarnessPath, HarnessPathNode } from './harness-cascade.js';

/** What the hierarchy needs of a canvas node. */
export type HierarchyNode = Pick<CanvasNode, 'id' | 'kind' | 'name' | 'parentId' | 'memberOf'>;

/**
 * The node's path: the nodes above it on the canvas, outermost first, each at its level.
 *
 * - A root sector (no parent) is the project's domain, not a level of its own: the project's layer covers it.
 * - The deepest sector above the node (or the node, when it is one) is the `sector`; the area that
 *   sector (or else the node) is a `memberOf` is the `area`.
 * - The cards above the sector are the `page` (the outermost) and the `layer` (the innermost, when
 *   there are two or more); any in between have no level and set nothing.
 * - A card with nothing under it is a `task`. A card with children is a page or a layer, never a task.
 * - A node id the canvas doesn't have is a task with nothing above it, so a custom task id keeps working.
 */
export function harnessPath(nodes: readonly HierarchyNode[], place: OporaPlace, nodeId: string): HarnessPath {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const self = byId.get(nodeId);
  const key = (id: string) => oporaKey(place, id);
  if (!self) return [{ level: 'task', node: key(nodeId) }];
  // The way up, nearest first, stopping at a loop or a parent the canvas doesn't have.
  const up: HierarchyNode[] = [];
  for (let at: HierarchyNode | undefined = self; at && !up.includes(at); at = at.parentId ? byId.get(at.parentId) : undefined) up.push(at);
  const down = up.reverse().filter((n) => !(n.kind === 'sector' && !n.parentId));
  const hasChildren = (id: string) => nodes.some((n) => n.parentId === id && n.kind !== 'area');
  const last = down[down.length - 1];
  const task = last && last.kind === 'node' && !hasChildren(last.id) ? last : undefined;
  const sectorAt = down.map((n) => n.kind).lastIndexOf('sector');
  const sector = sectorAt >= 0 ? down[sectorAt] : undefined;
  const above = (sector ? down.slice(0, sectorAt) : down.filter((n) => n !== task)).filter((n) => n.kind === 'node');
  const area = (sector && areaOf(nodes, sector.id)) || (task && areaOf(nodes, task.id)) || undefined;
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

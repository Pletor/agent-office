// The specialization tree of a project, the way the library's context bar offers it: every node of the
// bound project's canvas that has a level of the cascade (page › layer › area › sector › task), placed
// under the nodes its own harness path goes down through (shared/harness-hierarchy.ts). It is built
// from the paths, never from names or positions, so what the bar offers is exactly what a save at that
// node would resolve through. A card no task's path goes through (a dead end) is left out: a layer
// saved there would reach nothing. The client only renders it; it never invents a node.
import type { OporaPlace } from './opora-identity.js';
import { oporaKey } from './opora-identity.js';
import type { HarnessNodeLevel } from './harness-cascade.js';
import { harnessDeadEnd, harnessPath, type HierarchyNode } from './harness-hierarchy.js';

/** One node of the tree: its Opora key, its level, its name (the key when the canvas gave it none) and what is under it. */
export interface HarnessTreeNode { key: string; level: HarnessNodeLevel; name: string; children: HarnessTreeNode[] }

/** What the tree endpoint says about a floor's project: whether there is a tree to offer, and why not. */
export type HarnessTreeStatus = 'ready' | 'unbound' | 'unreachable' | 'elsewhere';

/** The most nodes the tree carries, so a huge canvas can't swamp the library. */
export const MAX_TREE_NODES = 600;

/**
 * The tree of `nodes` (one project's canvas, read for `place`): each node with a level, under the
 * nodes of its path. An area is placed where the sectors that are its members put it; one no sector
 * goes through is placed by its own path. At most `MAX_TREE_NODES` entries, in canvas order.
 */
export function harnessTree(nodes: readonly HierarchyNode[], place: OporaPlace): HarnessTreeNode[] {
  const roots: HarnessTreeNode[] = [];
  const seen = new Set<string>();
  let count = 0;
  const insert = (id: string) => {
    const path = harnessPath(nodes, place, id);
    const last = path[path.length - 1];
    if (!last || last.node !== oporaKey(place, id) || harnessDeadEnd(nodes, id)) return;
    let level = roots;
    for (const step of path) {
      let at = level.find((n) => n.key === step.node);
      if (!at) {
        if (count >= MAX_TREE_NODES) return;
        at = { key: step.node, level: step.level, name: step.name || step.node, children: [] };
        level.push(at);
        seen.add(step.node);
        count++;
      }
      level = at.children;
    }
  };
  for (const n of nodes) if (n.kind === 'node' || n.kind === 'sector') insert(n.id);
  for (const n of nodes) if (n.kind === 'area' && !seen.has(oporaKey(place, n.id))) insert(n.id);
  return roots;
}

/** Every node of the tree, depth first. */
export function* walkTree(tree: readonly HarnessTreeNode[]): Generator<HarnessTreeNode> {
  for (const n of tree) { yield n; yield* walkTree(n.children); }
}

/** The nodes from the root down to `key` (inclusive), or [] when the tree doesn't have it. */
export function treeTrail(tree: readonly HarnessTreeNode[], key: string): HarnessTreeNode[] {
  for (const n of tree) {
    if (n.key === key) return [n];
    const below = treeTrail(n.children, key);
    if (below.length) return [n, ...below];
  }
  return [];
}

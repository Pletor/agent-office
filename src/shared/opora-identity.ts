// Opora's identity contract, version 1, as the office reads it (docs/opora-identity.md). Opora owns
// every id: the project, its workspace and each node of the canvas. The office never makes one up,
// never takes one from a name or a position, and never carries one from one project or workspace to
// another: the same node id in another workspace is another card.

import { ancestry } from './opora-scope.js';
import type { OporaScopeNode } from './protocol/opora.js';

export const OPORA_IDENTITY_VERSION = 1;

/** The levels of the hierarchy, outermost first. Each one below `global` is an Opora id. */
export const OPORA_LEVELS = ['global', 'project', 'page', 'layer', 'area', 'sector', 'task'] as const;
export type OporaLevel = (typeof OPORA_LEVELS)[number];

/** Where a node lives: its project and workspace on Opora. */
export interface OporaPlace {
  project: string;
  workspace: string;
}

/** A node's canonical key, `opora:<project>:<workspace>:<nodeId>`, each part URI-encoded. */
export function oporaKey(place: OporaPlace, nodeId: string): string {
  return 'opora:' + [place.project, place.workspace, nodeId].map(encodeURIComponent).join(':');
}

/** The key's place and node, or undefined for anything that isn't a whole key. */
export function parseOporaKey(key: string): (OporaPlace & { nodeId: string }) | undefined {
  const parts = key.split(':');
  if (parts.length !== 4 || parts[0] !== 'opora' || parts.slice(1).some((p) => !p)) return undefined;
  try {
    const [project, workspace, nodeId] = parts.slice(1).map(decodeURIComponent);
    return { project, workspace, nodeId };
  } catch {
    return undefined;
  }
}

/** Why `key` can't be used in `place`, or undefined when it can: another project or workspace is refused, never remapped. */
export function refuseForeign(place: OporaPlace, key: string): string | undefined {
  const at = parseOporaKey(key);
  if (!at) return `Not an Opora key: ${key}`;
  if (at.project !== place.project) return `That node is in another Opora project (${at.project})`;
  if (at.workspace !== place.workspace) return `That node is in another workspace (${at.workspace}) of the project`;
  return undefined;
}

/** Whether two places are the same project and workspace. */
export function samePlace(a: OporaPlace | undefined, b: OporaPlace | undefined): boolean {
  return !!a && !!b && a.project === b.project && a.workspace === b.workspace;
}

/**
 * Whether a focus still means what it meant when it was switched on: every node in it is still in
 * the architecture with every node above it switched on too. A node that vanished or moved breaks
 * it, so the focus is never quietly widened to what's left of it (the parent of a vanished task).
 */
export function focusIntact(scope: readonly OporaScopeNode[], focus: readonly string[]): boolean {
  const on = new Set(focus);
  const there = new Set(scope.map((n) => n.id));
  return focus.every((id) => there.has(id) && ancestry(scope, id).every((a) => on.has(a)));
}

/**
 * The area a node explicitly belongs to, as Opora states it in the node's `memberOf`, or undefined.
 * Only an area with the same parent counts; the office never guesses one from where a card is drawn.
 */
export function areaOf(nodes: readonly { id: string; kind: string; parentId: string | null; memberOf?: string }[], id: string): string | undefined {
  const node = nodes.find((n) => n.id === id);
  if (!node?.memberOf) return undefined;
  const area = nodes.find((n) => n.id === node.memberOf);
  return area?.kind === 'area' && area.parentId === node.parentId ? area.id : undefined;
}

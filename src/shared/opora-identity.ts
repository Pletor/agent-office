// Opora's identity contract, version 1, as the office reads it (docs/opora-identity.md). Opora owns
// every id: the project, its workspace and each node of the canvas. The office never makes one up,
// never takes one from a name or a position, and never carries one from one project or workspace to
// another: the same node id in another workspace is another card.

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

/** Whether two places are the same project and workspace. */
export function samePlace(a: OporaPlace | undefined, b: OporaPlace | undefined): boolean {
  return !!a && !!b && a.project === b.project && a.workspace === b.workspace;
}

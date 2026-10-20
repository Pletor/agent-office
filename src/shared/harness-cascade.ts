// The harness cascade: named slots that resolve like CSS down Opora's hierarchy, global › project ›
// page › layer › area › sector › task (docs/opora-identity.md). Each level sets only the slots it
// names (its "own" view); a slot a level doesn't name inherits, null disables it, a binding replaces
// the whole binding above it. There is no deep merge, and siblings never see each other's layers.
import { OPORA_LEVELS, oporaKey, type OporaLevel } from './opora-identity.js';

/** A missing slot inherits; null explicitly disables it. Values replace, never deep-merge. */
export type HarnessBinding = { resource: string } | { value: string | number | boolean };
export type HarnessLayer = Record<string, HarnessBinding | null>;
/** A level of the cascade. `project` is the repository Opora plans; the 3-level store and the CLI call it `repository`. */
export type HarnessLevel = OporaLevel;
/** What a caller may name as a level: a level, or `repository`, the alias of `project`. */
export type HarnessScope = HarnessLevel | 'repository';
export const HARNESS_LEVELS: readonly HarnessLevel[] = OPORA_LEVELS;
/** The levels below the project, each an Opora node. */
export type HarnessNodeLevel = Exclude<HarnessLevel, 'global' | 'project'>;
/** One Opora node on the way down to what's addressed: its level and its key (`opora:project:workspace:nodeId`). */
export interface HarnessPathNode { level: HarnessNodeLevel; node: string; name?: string }
/** The way down from the project to the node addressed, outermost first, one entry per level at most. */
export type HarnessPath = readonly HarnessPathNode[];

/** Where an effective slot came from: the level, and for a level below the project the node's key and, when the canvas knows it, its name. */
export interface HarnessEffective { binding: HarnessBinding | null; scope: HarnessLevel; node?: string; nodeName?: string }
export interface HarnessProfile {
  /** The store's revision, one for every level: a save at any level moves it (compare-and-set). */
  revision: number;
  /** The nodes below the project this view goes down through. */
  path: HarnessPath;
  /** Each level's own view: only the slots it sets itself ({} for a level not on the path or without a layer). */
  layers: Record<HarnessLevel, HarnessLayer>;
  /** The resolved slots, each with the level (and node) it came from. */
  effective: Record<string, HarnessEffective>;
}

/** The level a scope names, or undefined: `repository` is `project`. */
export function harnessLevel(scope: unknown): HarnessLevel | undefined {
  if (scope === 'repository') return 'project';
  return (HARNESS_LEVELS as readonly unknown[]).includes(scope) ? (scope as HarnessLevel) : undefined;
}

/** Empty own views for every level. */
export function emptyLayers(): Record<HarnessLevel, HarnessLayer> {
  return Object.fromEntries(HARNESS_LEVELS.map((l) => [l, {}])) as Record<HarnessLevel, HarnessLayer>;
}

/** The path's node at `level`, if it goes down through one. */
export function pathNode(path: HarnessPath, level: HarnessLevel): HarnessPathNode | undefined {
  return path.find((p) => p.level === level);
}

/**
 * Resolves the cascade: outer levels first, each level's own slots replacing the ones above, so the
 * deepest level that names a slot wins. A level with no layer passes everything through unchanged.
 */
export function resolveHarness(layers: Partial<Record<HarnessLevel, HarnessLayer>>, path: HarnessPath = []): HarnessProfile['effective'] {
  const result: HarnessProfile['effective'] = Object.create(null);
  for (const scope of HARNESS_LEVELS) {
    const at = pathNode(path, scope);
    const origin = at ? { node: at.node, ...(at.name ? { nodeName: at.name } : {}) } : {};
    for (const [key, binding] of Object.entries(layers[scope] ?? {})) result[key] = { binding, scope, ...origin };
  }
  return result;
}

/** Namespace task IDs by the external project AND workspace, not just a card's short ID. */
export function oporaHarnessTask(project: string, workspace: string, card: string): string {
  return oporaKey({ project, workspace }, card);
}

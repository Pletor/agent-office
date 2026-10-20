// What the 🧭 Opora Control Center works on: the project's architecture as a cascade (environment →
// domain → page → subpage), each node switched on or off at the 🎚️ switchboard on the room's north
// glass. The deepest nodes switched on are the focus: the cell takes cards only from inside it, and
// its planner is told to stay in it, so the work is isolated to as exact a task as you make it.

import type { OporaScopeLevel, OporaScopeNode } from './protocol/opora.js';

/** A node of Opora's canvas as the bridge reads it, with the environment and host of a sector's site. */
export interface CanvasNode {
  id: string;
  kind: string;
  name: string;
  parentId: string | null;
  /** The area Opora says the node belongs to (never guessed from where it's drawn): see shared/opora-identity.ts. */
  memberOf?: string;
  env?: string;
  host?: string;
}

/** The levels in cascade order, and what the switchboard calls each. */
export const SCOPE_LEVELS: readonly OporaScopeLevel[] = ['env', 'domain', 'page', 'subpage'];
export const SCOPE_LEVEL_NAME: Record<OporaScopeLevel, string> = { env: 'Prostředí', domain: 'Doména', page: 'Stránka', subpage: 'Podstránka' };

/** Most nodes the cascade keeps, so a huge canvas can't swamp the floor's state. */
const MAX_SCOPE = 400;

/**
 * The cascade from the canvas's nodes: each root sector (one without a parent) under an `env:` node
 * for its site's environment (none when no root sector names one), its cards as pages, and theirs as
 * subpages (however deep). A sector nested under a card keeps that card as its parent, so a page's
 * layers, sectors and tasks stay under the page. A node whose parent isn't on the canvas, is an area
 * (never a parent) or loops back to it is left out, never lifted to a root.
 */
export function buildScope(nodes: readonly CanvasNode[]): OporaScopeNode[] {
  const out: OporaScopeNode[] = [];
  const roots = nodes.filter((n) => n.kind === 'sector' && !n.parentId);
  const withEnv = roots.some((s) => s.env);
  const envs = new Set<string>();
  for (const s of roots) {
    const env = withEnv ? (s.env || 'Other') : undefined;
    if (env && !envs.has(env)) {
      envs.add(env);
      out.push({ id: envId(env), name: env, level: 'env', parentId: null });
    }
    out.push({ id: s.id, name: s.name, level: 'domain', parentId: env ? envId(env) : null, ...(s.host ? { host: s.host } : {}) });
  }
  // Every other card and sector in canvas order, each once its parent is in: passes take any order,
  // and stop once one adds nothing (what's left has no way up to a root).
  const byLevel = new Map(out.map((n) => [n.id, n.level]));
  let left = nodes.filter((n) => (n.kind === 'node' || n.kind === 'sector') && n.parentId);
  while (left.length) {
    const next: CanvasNode[] = [];
    for (const n of left) {
      const parent = n.parentId ? byLevel.get(n.parentId) : undefined;
      if (!parent) {
        next.push(n);
        continue;
      }
      const level: OporaScopeLevel = parent === 'domain' ? 'page' : 'subpage';
      out.push({ id: n.id, name: n.name, level, parentId: n.parentId, ...(n.host ? { host: n.host } : {}) });
      byLevel.set(n.id, level);
    }
    if (next.length === left.length) break;
    left = next;
  }
  return out.slice(0, MAX_SCOPE);
}

export const envId = (name: string) => `env:${name}`;

/** Each node's parent, by id. */
function parents(scope: readonly OporaScopeNode[]): Map<string, string | null> {
  return new Map(scope.map((n) => [n.id, n.parentId]));
}

/** `id` and every node above it, nearest first. */
export function ancestry(scope: readonly OporaScopeNode[], id: string): string[] {
  const up = parents(scope);
  const out: string[] = [];
  for (let at: string | null | undefined = id; at && up.has(at) && !out.includes(at); at = up.get(at)) out.push(at);
  return out;
}

/** The nodes switched on that are still in the architecture, each with every node above it. */
export function cleanFocus(scope: readonly OporaScopeNode[], focus: readonly string[]): string[] {
  const on = new Set<string>();
  for (const id of focus) for (const a of ancestry(scope, id)) on.add(a);
  return scope.filter((n) => on.has(n.id)).map((n) => n.id);
}

/**
 * Switches one node: on, with everything above it (you can't work on a page of a domain that's off);
 * off, with everything under it.
 */
export function toggleFocus(scope: readonly OporaScopeNode[], focus: readonly string[], id: string, on: boolean): string[] {
  const now = new Set(cleanFocus(scope, focus));
  if (on) for (const a of ancestry(scope, id)) now.add(a);
  else for (const n of scope) if (now.has(n.id) && ancestry(scope, n.id).includes(id)) now.delete(n.id);
  return scope.filter((n) => now.has(n.id)).map((n) => n.id);
}

/** The deepest nodes switched on: the ones with nothing switched on under them. */
export function focusLeaves(scope: readonly OporaScopeNode[], focus: readonly string[]): string[] {
  const on = cleanFocus(scope, focus);
  const set = new Set(on);
  const hasChildOn = new Set(scope.filter((n) => set.has(n.id) && n.parentId).map((n) => n.parentId as string));
  return on.filter((id) => !hasChildOn.has(id));
}

/** Whether the cell works on `id`: nothing is switched on (the whole project), or it's a focus or under one. */
export function inFocus(scope: readonly OporaScopeNode[], focus: readonly string[], id: string): boolean {
  const leaves = focusLeaves(scope, focus);
  if (!leaves.length) return true;
  const up = ancestry(scope, id);
  return leaves.some((l) => up.includes(l));
}

/** Each focus as its way down from the top, e.g. [Vývoj, Aplikace, Oracle, Na míru]. */
export function focusPaths(scope: readonly OporaScopeNode[], focus: readonly string[]): OporaScopeNode[][] {
  const byId = new Map(scope.map((n) => [n.id, n]));
  return focusLeaves(scope, focus).map((leaf) =>
    ancestry(scope, leaf)
      .reverse()
      .map((id) => byId.get(id)!),
  );
}

/** The focus in words, for the planner's brief and the hints: “Vývoj › Aplikace (app.….dev) › Oracle › Na míru”. */
export function focusLine(scope: readonly OporaScopeNode[], focus: readonly string[]): string {
  const paths = focusPaths(scope, focus);
  if (!paths.length) return '';
  return paths.map((p) => p.map((n) => (n.host ? `${n.name} (${n.host})` : n.name)).join(' › ')).join('; ');
}

/** A node's children in canvas order. */
export function childrenOf(scope: readonly OporaScopeNode[], id: string | null): OporaScopeNode[] {
  return scope.filter((n) => n.parentId === id);
}

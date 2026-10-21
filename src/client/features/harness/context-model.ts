// The library's context (docs/harness.md "Choosing the context"): which one level the editor shows.
// Either Global, or one project (a floor of this office), or one specialization of that project (a
// node of its Opora tree: page, layer, area, sector or task). A specialization always belongs to a
// project and can't be chosen without one. The view never switches inheritance off: a project still
// inherits global and a specialization overrides single slots of what's above it; the context only
// decides which level's own settings are edited and whose resolved result is previewed.
import type { HarnessLevel, HarnessNodeLevel } from '../../../shared/harness-cascade';
import type { HarnessTreeNode, HarnessTreeStatus } from '../../../shared/harness-tree';

export type HarnessContext =
  | { kind: 'global' }
  | { kind: 'project'; floor: string }
  | { kind: 'node'; floor: string; node: string; level: HarnessNodeLevel; name: string };

/** A floor as the project picker lists it (GET /api/harness/projects). */
export interface ProjectChoice {
  floor: string;
  name: string;
  /** The key the profile audit files the floor's checkout under. */
  repo: string;
  binding: { project: string; workspace: string; projectName: string } | null;
  status: HarnessTreeStatus | 'error';
  notice: string;
  /** An unbound floor's Opora window place, which an administrator may bind ("Bind this floor"). */
  window?: { project: string; workspace: string; projectName: string } | null;
}
/** GET /api/harness/tree?floor=: the floor's tree, or an empty one and why. */
export interface TreeReply extends ProjectChoice { tree: HarnessTreeNode[] }

/** A context that can be: a specialization without a project is Global (nothing is guessed for it). */
export function normalizeContext(ctx: HarnessContext | undefined, fallbackFloor: string): HarnessContext {
  if (!ctx) return fallbackFloor ? { kind: 'project', floor: fallbackFloor } : { kind: 'global' };
  if (ctx.kind === 'global') return ctx;
  if (!ctx.floor) return { kind: 'global' };
  if (ctx.kind === 'node' && !ctx.node) return { kind: 'project', floor: ctx.floor };
  return ctx;
}

/** The level whose own settings the context edits. */
export const contextLevel = (ctx: HarnessContext): HarnessLevel => (ctx.kind === 'node' ? ctx.level : ctx.kind);
/** The floor whose profile, catalog and tree the context reads (Global reads the floor the library was opened on). */
export const contextFloor = (ctx: HarnessContext, opened: string): string => (ctx.kind === 'global' ? opened : ctx.floor);
/** A stable identity of the context: two contexts with the same key show the same thing. */
export const contextKey = (ctx: HarnessContext): string => (ctx.kind === 'global' ? 'global' : ctx.kind === 'project' ? 'project:' + ctx.floor : 'node:' + ctx.floor + ':' + ctx.node);
export const sameContext = (a: HarnessContext, b: HarnessContext) => contextKey(a) === contextKey(b);

/** A level's name as the library shows it. */
export const levelName = (level: string) => level[0].toUpperCase() + level.slice(1);

/** The namespace an element ID names: `guide:` is the handbook, `el:<ns>:` is ns; anything else is the project's. */
export function elementNamespace(id: string): string {
  return id.startsWith('guide:') ? 'handbook' : /^el:([a-z]+):/.exec(id)?.[1] ?? 'project';
}
/**
 * Whether an element belongs to the context's list: Global lists the elements the global layer may bind
 * (the same file in every project), a project and its specializations list the project's own elements.
 */
export function elementInContext(id: string, ctx: HarnessContext, globalNamespaces: readonly string[]): boolean {
  const global = globalNamespaces.includes(elementNamespace(id));
  return ctx.kind === 'global' ? global : !global;
}

/** An audit entry of the profile store, as the profile reply carries it. */
export interface AuditEntry { at: string; revision: number; level: string; node: string; repo?: string; by: string; slots: string[] }
/**
 * The saves of the context's own level: Global's for Global, this project's project layer for a project,
 * this node's for a specialization. An administrator's reply carries every repository's saves; the view
 * of one project never lists another's.
 */
export function ownAudit(audit: readonly AuditEntry[], ctx: HarnessContext, repo: string | undefined): AuditEntry[] {
  if (ctx.kind === 'global') return audit.filter((a) => a.level === 'global');
  if (!repo) return [];
  return audit.filter((a) => a.repo === repo && (ctx.kind === 'project' ? a.level === 'project' : a.level === ctx.level && a.node === ctx.node));
}

/** The context kept while the page lives, so closing and reopening the library comes back to it. */
let remembered: HarnessContext | undefined;
export const rememberContext = (ctx: HarnessContext) => { remembered = ctx; };
export const rememberedContext = () => remembered;

/**
 * The latest of a series of requests: each `next()` aborts the one before and hands out a signal and a
 * check, so a reply that arrives after the selection moved on is dropped instead of overwriting the view.
 */
export function latest(outer?: AbortSignal) {
  let controller: AbortController | undefined;
  let ticket = 0;
  return {
    next() {
      controller?.abort();
      const mine = new AbortController();
      controller = mine;
      const seq = ++ticket;
      outer?.addEventListener('abort', () => mine.abort(), { once: true });
      return { signal: mine.signal, current: () => seq === ticket && !mine.signal.aborted };
    },
    /** Drops whatever is in flight. */
    cancel() { controller?.abort(); ticket++; },
  };
}

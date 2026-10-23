import { HARNESS_LEVELS, resolveHarness, type HarnessLayer } from '../../../../shared/harness-cascade';
import type { HarnessHierarchyView } from '../../../../shared/harness-navigation';

export function resourceSlot(id: string): string {
  // Full IDs remain in bindings; this stable UI slot is only an assignment name.
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return 'resource.' + (hash >>> 0).toString(16);
}
export function resourceModel(view: HarnessHierarchyView, draft: HarnessLayer) {
  const layers = { ...view.layers, [view.level]: draft };
  const upstream = Object.fromEntries(HARNESS_LEVELS.slice(0, HARNESS_LEVELS.indexOf(view.level)).map(level => [level, layers[level]]));
  return { effective: resolveHarness(view.level === 'global' ? { global: draft } : layers, view.path), upstream: resolveHarness(upstream, view.path) };
}
export function setResource(view: HarnessHierarchyView, draft: HarnessLayer, id: string, enabled: boolean | 'inherit', aliases: string[] = []): HarnessLayer {
  const next = { ...draft }, { effective, upstream } = resourceModel(view, draft);
  const ids = new Set([id, ...aliases]);
  const has = (binding: unknown): boolean => !!binding && typeof binding === 'object' && 'resource' in binding && typeof binding.resource === 'string' && ids.has(binding.resource);
  const relevant = new Set([...Object.keys(effective).filter(slot => has(effective[slot].binding)), ...Object.keys(upstream).filter(slot => has(upstream[slot].binding)), ...Object.keys(draft).filter(slot => has(draft[slot]))]);
  for (const resource of ids) if (draft[resourceSlot(resource)] === null) relevant.add(resourceSlot(resource));
  if (enabled === 'inherit') for (const slot of relevant) delete next[slot];
  else if (!enabled) for (const slot of relevant) next[slot] = null;
  else {
    const inherited = Object.keys(upstream).filter(slot => has(upstream[slot].binding));
    if (inherited.length) for (const slot of inherited) next[slot] = upstream[slot].binding;
    else {
      let slot = resourceSlot(id), suffix = 0;
      while ((slot in next && next[slot] !== null && !has(next[slot])) || (slot in upstream && upstream[slot].binding !== null && !has(upstream[slot].binding))) slot = resourceSlot(id) + '.' + ++suffix;
      next[slot] = { resource: id };
    }
  }
  return next;
}

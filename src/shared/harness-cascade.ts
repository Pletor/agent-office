/** A missing slot inherits; null explicitly disables it. Values replace, never deep-merge. */
export type HarnessBinding = { resource: string } | { value: string | number | boolean };
export type HarnessLayer = Record<string, HarnessBinding | null>;
export type HarnessScope = 'global' | 'repository' | 'task';
export interface HarnessEffective { binding: HarnessBinding | null; scope: HarnessScope }
export interface HarnessProfile {
  revision: number;
  layers: Record<HarnessScope, HarnessLayer>;
  effective: Record<string, HarnessEffective>;
}
export function resolveHarness(layers: HarnessProfile['layers']): HarnessProfile['effective'] {
  const result: HarnessProfile['effective'] = Object.create(null);
  for (const scope of ['global', 'repository', 'task'] as const) {
    for (const [key, binding] of Object.entries(layers[scope])) result[key] = { binding, scope };
  }
  return result;
}
/** Namespace task IDs by the external project AND workspace, not just a card's short ID. */
export function oporaHarnessTask(project: string, workspace: string, card: string): string {
  return 'opora:' + [project, workspace, card].map(encodeURIComponent).join(':');
}

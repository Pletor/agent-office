/** Revalidate managed tool versions before automatic selection, using the existing CAS. */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HarnessProfiles, HarnessError } from './profiles.js';

interface Scope { peer: string; project: string; workspace: string; problem: string }
export interface ManagedVersion { id: string; digest: string; category: string; requires: string[] }
interface Source { verificationId: string; reportDigest: string }
interface State { scope: Scope; active: ManagedVersion; previous: ManagedVersion | null;
  source?: Source; previousSource?: Source; withdrawn?: ManagedVersion[]; status: 'stable' | 'suspended' }
interface Evidence { scope: Scope; version: ManagedVersion; eligible: boolean; source?: Source }
interface Store {
  toolLifecycleProtocol: 1;
  lifecycle(repo: string, scope: Scope): { revision: number; state?: State };
  advanceTool(repo: string, scope: Scope, revision: number, operation: 'reconcile',
    read: () => Promise<{ current: Evidence; fallback?: Evidence; assertCurrent: () => void }>): Promise<{ revision: number; state: State }>;
}
export interface RecommendationLifecycle {
  status: 'unavailable' | 'unmanaged' | 'stable' | 'suspended'; revision: number;
  active?: ManagedVersion; blocked: ManagedVersion[]; reason?: string;
}
const same = (a: ManagedVersion, b: ManagedVersion) => a.id === b.id && a.digest === b.digest
  && a.category === b.category && a.requires.length === b.requires.length && a.requires.every((r, i) => r === b.requires[i]);
export function managedVersionStatus(lifecycle: RecommendationLifecycle | undefined, version: ManagedVersion) {
  if (lifecycle?.status === 'stable' && lifecycle.active && same(lifecycle.active, version)) return 'stable';
  return lifecycle?.blocked.some(v => same(v, version)) ? 'blocked' : null;
}

export async function recommendationLifecycle(dataDir: string, repo: string, scope: Scope, revision: number,
  assertCurrent: () => void): Promise<RecommendationLifecycle> {
  const store = new HarnessProfiles(dataDir) as unknown as Partial<Store>;
  if (store.toolLifecycleProtocol !== 1 || typeof store.lifecycle !== 'function' || typeof store.advanceTool !== 'function')
    return { status: 'unavailable', revision, blocked: [], reason: 'lifecycle-storage-not-installed' };
  const initial = store.lifecycle(repo, scope);
  if (initial.revision !== revision) throw new HarnessError('Profiles changed before lifecycle assessment. Retry.', 409);
  if (!initial.state) return { status: 'unmanaged', revision, blocked: [] };
  const before = initial.state, managed = [before.active, ...(before.previous ? [before.previous] : []), ...(before.withdrawn ?? [])];
  const unavailable = (reason: string): RecommendationLifecycle => ({ status: 'unavailable', revision, blocked: managed, reason });
  if (!before.source) return unavailable('native-source-missing');
  const module = new URL('./retained-stability.js', import.meta.url);
  if (!existsSync(fileURLToPath(module)) && !existsSync(fileURLToPath(module).replace(/\.js$/, '.ts')))
    return unavailable('retained-native-adapter-not-installed');
  try {
    const adapter = await import(module.href);
    const result = await store.advanceTool(repo, scope, revision, 'reconcile', async () => {
      assertCurrent();
      const current = await adapter.readRetainedStability(scope, before.active, before.source) as Evidence;
      const fallback = !current.eligible && before.previous && before.previousSource
        ? await adapter.readRetainedStability(scope, before.previous, before.previousSource) as Evidence : undefined;
      assertCurrent(); return { current, ...(fallback ? { fallback } : {}), assertCurrent };
    });
    assertCurrent();
    return { status: result.state.status, revision: result.revision,
      ...(result.state.status === 'stable' ? { active: result.state.active } : {}),
      blocked: [...managed, ...(result.state.withdrawn ?? [])]
        .filter((v, i, all) => !all.slice(0, i).some(other => same(v, other)))
        .filter(v => result.state.status !== 'stable' || !same(v, result.state.active)) };
  } catch { return unavailable('native-reassessment-unavailable'); }
}

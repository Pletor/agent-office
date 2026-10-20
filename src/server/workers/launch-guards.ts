import type { WorkerInfo } from '../../shared/protocol.js';

export interface WorkerLaunchGuard {
  applies(info: WorkerInfo): boolean;
  check(info: WorkerInfo): string | undefined;
  restore(info: WorkerInfo): Promise<string | undefined>;
}

/** Feature-owned authority checks at every launch and before restoring a saved worker. */
export class WorkerLaunchGuards {
  private guards = new Set<WorkerLaunchGuard>();
  add(guard: WorkerLaunchGuard) { this.guards.add(guard); return () => this.guards.delete(guard); }
  manages(info: WorkerInfo) { return [...this.guards].some(guard => guard.applies(info)); }
  check(info: WorkerInfo) {
    for (const guard of this.guards) if (guard.applies(info)) { const reason = guard.check(info); if (reason) return reason; }
    return undefined;
  }
  async restore(info: WorkerInfo) {
    for (const guard of this.guards) if (guard.applies(info)) {
      try { const reason = await guard.restore(info); if (reason) return reason; }
      catch { return 'Worker authority could not be revalidated; worktree retained'; }
    }
    return this.check(info);
  }
}

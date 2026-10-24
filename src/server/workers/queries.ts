import type { Worker, WorkerContext } from './types.js';

export function occupiedDesk(workers: Iterable<Worker>, deskId: string) {
  for (const w of workers) if (w.info.deskId === deskId) return true;
  return false;
}

/** Same worker-to-service ownership projection for running and prepared workers. */
export function serviceOwners(ctx: Pick<WorkerContext, 'workers' | 'cwd' | 'dir'>) {
  return [...ctx.workers.values()].map(w => ({
    workerId: w.info.id, pid: w.pty?.pid, agent: w.info.kind === 'agent', cwd: ctx.cwd(w.info), root: ctx.dir,
  }));
}

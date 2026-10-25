import type { StagedWorker } from '../workers/staged-start.js';
import type { ExecutionController } from './execution-controller.js';
import type { ExecutionLease } from './execution-client.js';

export type PreparedWorker = Pick<StagedWorker, 'start' | 'cancel' | 'verify'> & Partial<Pick<StagedWorker, 'worker'>>;

/** A preparation may read its claimed assignment, but no provider is seated during this check. */
export async function verifyWorkerReadiness(controller: ExecutionController,
  grant: { lease: ExecutionLease; deadline: number }, worker?: PreparedWorker) {
  if (!worker?.verify) return;
  const id = worker.worker?.id;
  if (!id) throw new Error('Runtime readiness requires a reserved worker identity');
  if (controller.allowed(id)) throw new Error('Reserved worker already has execution authority');
  controller.watch(id, grant.lease, grant.deadline);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!controller.allowed(id)) throw new Error('Execution expired before worker readiness');
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort(); reject(new Error('Worker readiness deadline exceeded'));
      }, Math.max(1, Math.min(60_000, grant.deadline - performance.now())));
      timer.unref();
    });
    await Promise.race([Promise.resolve().then(() => worker.verify!(abort.signal)), deadline]);
    if (!controller.allowed(id)) throw new Error('Execution expired during worker readiness');
  } finally {
    clearTimeout(timer); abort.abort();
    // Normal guarded seating must still bind the worker and apply the resume plan once.
    controller.forget(id);
  }
}

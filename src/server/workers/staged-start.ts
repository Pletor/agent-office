import type { AgentEffort, AgentProvider, WorkerInfo } from '../../shared/protocol.js';
import type { Worker } from './types.js';

export const STAGED_START = Symbol('worker preparation');
export interface WorkerStageOptions {
  deskId: string; by: string; worktree?: boolean; owner?: string;
  provider?: AgentProvider; model?: string; effort?: AgentEffort; via?: WorkerInfo['via'];
  timeoutMs?: number;
}
export interface StagedWorker {
  readonly worker: Readonly<WorkerInfo>;
  readonly cwd: string;
  readonly signal: AbortSignal;
  /** Tracks a bounded preparation operation so cancellation cannot remove its directory mid-write. */
  prepare<T>(operation: (cwd: string, signal: AbortSignal) => Promise<T>): Promise<T>;
  /** Consumes this preparation once. Existing launch guards still decide whether work may start. */
  start(prompt: string): WorkerInfo | string;
  /** Releases the desk and uses the normal worktree preservation policy. Idempotent. */
  cancel(): Promise<{ note?: string; error?: string }>;
}
interface StageHost {
  current(): boolean;
  start(prompt: string): string | undefined;
  cancel(): Promise<{ note?: string; error?: string }>;
  persist(): void;
}
export function stageTimeout(value = 30_000): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120 * 60_000)
    throw new Error('Worker preparation timeout must be between 1ms and 120 minutes');
  return value;
}
export function stopPreparations(workers: Iterable<Worker>) {
  for (const w of workers) w.stopPreparation?.();
}

/** Manager-owned allocation, not execution authority or an attestation of the future process. */
export function stagedWorker(w: Worker, cwd: string, timeoutMs: number, host: StageHost): StagedWorker {
  const abort = new AbortController();
  let state: 'pending' | 'started' | 'failed' | 'cancelled' = 'pending';
  let cancellation: ReturnType<StageHost['cancel']> | undefined;
  let preparation: Promise<unknown> | undefined;
  const deadline = performance.now() + timeoutMs;
  const cancel = () => {
    if (state === 'started') return Promise.resolve({ error: 'Worker already started; preparation cannot cancel execution' });
    if (cancellation) return cancellation;
    state = 'cancelled'; clearTimeout(timer); abort.abort();
    cancellation = (preparation ?? Promise.resolve()).catch(() => {}).then(() => {
      if (!host.current()) return { note: 'Preparation owner no longer active; worktree retained' };
      // Only the owning handle knows its tracked writer has settled. Ordinary kill keeps staged trees.
      w.preparing = undefined;
      return host.cancel();
    });
    return cancellation;
  };
  const timer = setTimeout(() => { void cancel().catch(() => {}); }, timeoutMs);
  timer.unref();
  w.stopPreparation = () => {
    clearTimeout(timer);
    if (state !== 'started') { state = 'cancelled'; abort.abort(); }
  };
  return {
    worker: structuredClone(w.info), cwd, signal: abort.signal, cancel,
    async prepare(operation) {
      if (state !== 'pending' || preparation) throw new Error('Worker preparation is unavailable or already running');
      const task = Promise.resolve().then(() => {
        if (abort.signal.aborted || performance.now() >= deadline || !host.current()) throw new Error('Worker preparation was cancelled');
        return operation(cwd, abort.signal);
      });
      preparation = task;
      try {
        const result = await task;
        if (abort.signal.aborted || performance.now() >= deadline || !host.current()) throw new Error('Worker preparation was cancelled');
        return result;
      } catch (error) { void cancel().catch(() => {}); throw error; }
      finally { if (preparation === task) preparation = undefined; }
    },
    start(prompt) {
      if (state !== 'pending') return 'Worker preparation was already consumed or cancelled';
      if (preparation) return 'Worker preparation is still running';
      if (performance.now() >= deadline || !host.current()) {
        void cancel().catch(() => {}); return 'Worker preparation expired or the office is shutting down';
      }
      if (typeof prompt !== 'string' || !prompt.trim()) return 'Prepared worker needs a task prompt';
      state = 'failed'; clearTimeout(timer);
      const before = w.info.prompt;
      w.preparing = undefined; w.info.prompt = prompt.trim();
      try {
        const error = host.start(w.info.prompt);
        if (error || w.info.status === 'exited') {
          w.preparing = true; w.info.prompt = before; host.persist(); void cancel().catch(() => {});
          return error ?? 'Prepared worker failed to start';
        }
        state = 'started'; host.persist(); return w.info;
      } catch (error) {
        w.preparing = true; w.info.prompt = before; host.persist(); void cancel().catch(() => {});
        throw error;
      }
    },
  };
}

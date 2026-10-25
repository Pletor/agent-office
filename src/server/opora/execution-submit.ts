import { executionTimeoutsFromEnvironment } from './execution-client.js';

/**
 * Delivering the worker's result to Canvas (execution-worker.ts). Canvas stores a result once per `requestId`
 * and answers the same request again with the stored receipt (Canvas `ExecutionResults.submit`: the replay is
 * looked up before authority is checked, so it works even after the result ended the execution). A slow Opora
 * that commits the result but answers late must therefore not lose the receipt: each attempt waits as long as the
 * office's own request timeout (`AGENT_OFFICE_OPORA_EXECUTION_TIMEOUT_S`, 20 s), and a timeout, a network failure,
 * a 5xx or a 429 is sent again, identically, with the same `requestId`.
 */

/** How many times the same result is sent before the helper gives up, and the pauses between them. */
export const SUBMIT_ATTEMPTS = 3;
const PAUSES_MS = [1000, 3000];

/** The per-attempt timeout the office wrote into the bundle, else the environment's, else 20 s; 1 to 120 s. */
export function submitTimeoutMs(bundle: { requestTimeoutMs?: unknown }, env: NodeJS.ProcessEnv = process.env): number {
  const saved = bundle.requestTimeoutMs;
  if (typeof saved === 'number' && Number.isFinite(saved) && saved >= 1000 && saved <= 120_000) return saved;
  return executionTimeoutsFromEnvironment(env).requestMs;
}

const retryable = (response: Response) => response.status >= 500 || response.status === 429;

/** Sends with `send` until Canvas answers for good; the last answer, or the last failure when none came. */
export async function deliverResult(send: (signal: AbortSignal) => Promise<Response>, timeoutMs: number,
  attempts = SUBMIT_ATTEMPTS, pause: (ms: number) => Promise<void> = ms => new Promise(done => setTimeout(done, ms))): Promise<Response> {
  let failure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await pause(PAUSES_MS[Math.min(attempt - 2, PAUSES_MS.length - 1)]);
    try {
      const response = await send(AbortSignal.timeout(timeoutMs));
      if (!retryable(response) || attempt === attempts) return response;
      failure = undefined;
    } catch (error) { failure = error; }
  }
  throw failure ?? new Error('Canvas did not confirm the result');
}

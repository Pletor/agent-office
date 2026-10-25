import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ExecutionClient, ExecutionLease } from './execution-client.js';

/**
 * A result Canvas stored although the worker's helper never saw its receipt (Opora answered after the helper
 * gave up): Canvas then refuses the next heartbeat with 409 because the execution is finished, and without its
 * `<executionId>-reported.json` the office would call that a refusal and never push or open the pull request.
 * So on that 409 the controller asks Canvas (`GET /executions/{id}/results`) and, when a receipt for exactly this
 * execution, revision and assignment is there, writes the file the helper would have written. The run then ends
 * as finished and the usual hand-off (pull-request-handoff.ts) pushes `opora/<card>/<execution>` and opens its PR.
 */

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The newest receipt in Canvas's answer that belongs to `lease` and carries a result; undefined when none does. */
export function storedReceipt(lease: ExecutionLease, receipts: unknown[]): { receiptId: string; result: Record<string, unknown> } | undefined {
  for (const item of [...receipts].reverse()) {
    if (!object(item) || item.executionId !== lease.executionId || item.state !== 'reported' || typeof item.receiptId !== 'string' || !item.receiptId
      || !object(item.result) || typeof item.result.summary !== 'string') continue;
    if ((item.acceptedRevision !== undefined && item.acceptedRevision !== lease.acceptedRevision)
      || (item.assignmentDigest !== undefined && item.assignmentDigest !== lease.assignmentDigest)) continue;
    return { receiptId: item.receiptId, result: item.result };
  }
  return undefined;
}

/** Whether Canvas has this execution's result; when it does, it is kept as `<executionId>-reported.json` under `directory`. */
export async function recoverStoredResult(client: Pick<ExecutionClient, 'results'>, directory: string, lease: ExecutionLease,
  log: (message: string) => void = message => console.log(`[opora] ${message}`)): Promise<boolean> {
  const file = path.join(directory, 'opora-executions', `${lease.executionId}-reported.json`);
  if (existsSync(file)) return true;
  const found = storedReceipt(lease, await client.results(lease));
  if (!found) return false;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ ...found, recovered: 'read from Canvas after the helper missed its receipt' }, null, 2), { mode: 0o600, flag: 'wx' });
  } catch { if (!existsSync(file)) return false; }
  log(`Canvas already holds the result of execution ${lease.executionId} (receipt ${found.receiptId}); handing it off as finished`);
  return true;
}

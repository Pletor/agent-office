import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ExecutionError, validateExecution, type ExecutionLease } from './execution-client.js';
import { sameBudget } from './execution-budget.js';

/** V2 restore retains the original private grant and task file, never recaptures a live assignment. */
export function validateBudgetFiles(directory: string, base: string, agent: string, lease: ExecutionLease) {
  if (lease.executionProtocolVersion !== 2) return;
  try {
    const stem = path.join(directory, 'opora-executions', lease.executionId);
    const bundle = JSON.parse(readFileSync(stem + '.json', 'utf8'));
    const original = validateExecution(bundle, lease);
    const assignment = JSON.parse(readFileSync(stem + '-assignment.json', 'utf8'));
    if (original.executionProtocolVersion !== 2 || original.executionId !== lease.executionId
      || original.token !== lease.token || original.epoch !== lease.epoch
      || original.acceptedRevision !== lease.acceptedRevision || original.assignmentDigest !== lease.assignmentDigest
      || !sameBudget(original.budget!, lease.budget!) || !isDeepStrictEqual(original.assignment, lease.assignment)
      || !isDeepStrictEqual(assignment, lease.assignment) || bundle.base !== base
      || bundle.actor !== `agent; name=${agent}` || typeof bundle.resultRequestId !== 'string'
      || !/^[A-Za-z0-9_-]{1,80}$/.test(bundle.resultRequestId)) throw new Error('pins changed');
  } catch { throw new ExecutionError(409, true, 'Saved Canvas budget files are missing or inconsistent; worktree retained'); }
}

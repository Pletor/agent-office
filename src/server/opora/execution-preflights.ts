import type { ExecutionClient, ExecutionLease, ExecutionScope } from './execution-client.js';
import type { ContextVersion } from './execution-context.js';
import { harnessExecutionPreflight } from '../harness/execution-preflight.js';

export interface PreflightInput { client: ExecutionClient; scope: ExecutionScope; contextVersion: ContextVersion }
export type PreparedExecutionCheck = (lease: Readonly<ExecutionLease>) => void;
/** Feature-owned preparation checks; no claim or worker launch authority. */
const PREFLIGHTS: readonly ((input: PreflightInput) => Promise<PreparedExecutionCheck>)[] = [harnessExecutionPreflight];
export async function prepareExecution(input: PreflightInput): Promise<PreparedExecutionCheck> {
  const checks: PreparedExecutionCheck[] = [];
  for (const prepare of PREFLIGHTS) checks.push(await prepare(input));
  return lease => { for (const check of checks) check(lease); };
}

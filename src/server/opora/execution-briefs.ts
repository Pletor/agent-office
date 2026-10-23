import type { ExecutionLease } from './execution-client.js';
import { harnessWorkerBrief } from '../harness/worker-brief.js';

/** Immutable execution extensions. Entries must be synchronous and use only the accepted lease. */
const BRIEFS: readonly ((lease: Readonly<ExecutionLease>) => string)[] = [harnessWorkerBrief];
export function executionBriefs(lease: Readonly<ExecutionLease>): string {
  const text = BRIEFS.map(brief => brief(lease)).filter(Boolean).join('\n\n');
  return text ? text + '\n' : '';
}

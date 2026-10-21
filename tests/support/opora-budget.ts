import type { ExecutionLease } from '../../src/server/opora/execution-client.js';
import type { ExecutionBudget, ExecutionContext } from '../../src/server/opora/execution-budget.js';

export const budgetScope = { project: 'project', workspace: 'work', nodeId: 'card' };
export const authorityBudget = (): ExecutionBudget => ({ policyHead: 'c'.repeat(40), familyId: 'd'.repeat(40),
  allocationId: 'e'.repeat(40), attempt: 1, repairRound: 0, kind: 'initial', admittedAt: 100,
  runDeadlineAt: 160, maxRunSeconds: 60 });
export const budgetLease = (): ExecutionLease => ({ ...budgetScope, executionId: 'execution-1', token: 'PRIVATE-token', epoch: 7,
  acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64), assignment: { contextVersion: 'context', documents: { card: 'accepted brief' } },
  state: 'running', serverNow: 100, expiresAt: 160, executionProtocolVersion: 2, budget: authorityBudget() });
export const budgetContext = (): ExecutionContext => ({ available: true, unavailableReason: null,
  acceptedHead: 'a'.repeat(40), contextVersion: 'context', executionProtocolVersion: 2,
  budget: { enrolled: true, policyHead: 'c'.repeat(40), policy: { id: 'c'.repeat(40) }, latestExecutionId: null,
    blockedReason: null, attemptsUsed: 0, repairRoundsUsed: 0, remainingAttempts: 3, remainingRepairRounds: 1 } });
export const flushBudget = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

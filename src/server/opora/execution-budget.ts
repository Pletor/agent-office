/** Immutable Canvas authority budget; no billing or process-tree guarantees. */
export interface ExecutionBudget {
  policyHead: string; familyId: string; allocationId: string; attempt: number; repairRound: number;
  kind: 'initial' | 'retry' | 'repair'; admittedAt: number; runDeadlineAt: number; maxRunSeconds: number;
}
export interface BudgetContext {
  enrolled: true; policyHead: string | null; policy: Record<string, unknown> | null;
  latestExecutionId: string | null; blockedReason: string | null;
  attemptsUsed: number; repairRoundsUsed: number; remainingAttempts: number; remainingRepairRounds: number;
}
export interface ExecutionContext {
  available: boolean; unavailableReason: string | null; acceptedHead: string | null; contextVersion: string | null;
  executionProtocolVersion?: 1 | 2; budget?: BudgetContext | null;
  contextProtocolVersion?: 1 | 2;
}
const KEYS = ['policyHead', 'familyId', 'allocationId', 'attempt', 'repairRound', 'kind', 'admittedAt', 'runDeadlineAt', 'maxRunSeconds'] as const;
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (): never => { throw new Error('Invalid Canvas budget authority'); };

export function validateBudget(value: unknown): ExecutionBudget {
  if (!object(value) || Object.keys(value).length !== KEYS.length || !KEYS.every(key => key in value)) return fail();
  if (!['policyHead', 'familyId', 'allocationId'].every(key => hash(value[key]))
    || !count(value.attempt) || value.attempt < 1 || !count(value.repairRound)
    || typeof value.kind !== 'string' || !['initial', 'retry', 'repair'].includes(value.kind)
    || !Number.isInteger(value.maxRunSeconds) || (value.maxRunSeconds as number) < 30 || (value.maxRunSeconds as number) > 86400
    || typeof value.admittedAt !== 'number' || !Number.isFinite(value.admittedAt) || value.admittedAt < 0 || value.admittedAt > 253402214399
    || typeof value.runDeadlineAt !== 'number' || !Number.isFinite(value.runDeadlineAt)
    || value.runDeadlineAt !== value.admittedAt + (value.maxRunSeconds as number)
    || value.repairRound > value.attempt - 1
    || (value.kind === 'initial' && (value.attempt !== 1 || value.repairRound !== 0))
    || (value.kind === 'retry' && (value.attempt < 2 || value.repairRound !== 0))
    || (value.kind === 'repair' && (value.attempt < 2 || value.repairRound < 1))) return fail();
  return value as unknown as ExecutionBudget;
}

export function sameBudget(first: ExecutionBudget, second: ExecutionBudget) {
  return KEYS.every(key => first[key] === second[key]);
}

export function validateContext(value: unknown): ExecutionContext {
  if (!object(value) || typeof value.available !== 'boolean'
    || !(value.unavailableReason === null || typeof value.unavailableReason === 'string'
      || (value.unavailableReason === undefined && (value.executionProtocolVersion === undefined || value.executionProtocolVersion === 1)))
    || !(value.acceptedHead === null || hash(value.acceptedHead))
    || !(value.contextVersion === null || typeof value.contextVersion === 'string')) return fail();
  const version = value.executionProtocolVersion;
  if (version !== undefined && version !== 1 && version !== 2) return fail();
  if (version === 2) {
    const budget = value.budget;
    if (!object(budget) || budget.enrolled !== true || !(budget.policyHead === null || hash(budget.policyHead))
      || !(budget.policy === null || object(budget.policy))
      || !(budget.latestExecutionId === null || (typeof budget.latestExecutionId === 'string' && /^[a-f0-9]{32}$/.test(budget.latestExecutionId)))
      || !(budget.blockedReason === null || typeof budget.blockedReason === 'string')
      || !['attemptsUsed', 'repairRoundsUsed', 'remainingAttempts', 'remainingRepairRounds'].every(key => count(budget[key]))
      || (value.available && (budget.policyHead === null || budget.policy === null || budget.blockedReason !== null || budget.remainingAttempts === 0))) return fail();
  } else if (object(value.budget) && value.budget.enrolled === true) return fail();
  return value as unknown as ExecutionContext;
}

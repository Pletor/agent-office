import { ExecutionError, type ExecutionLease } from './execution-client.js';
import { sameBudget, type ExecutionBudget } from './execution-budget.js';

/** First observed monotonic cap survives later server samples and client wall-clock changes. */
export class ExecutionBudgetClock {
  private pins = new Map<string, { budget: ExecutionBudget; deadline: number }>();
  observe(lease: ExecutionLease, requestStarted: number): number {
    if (lease.executionProtocolVersion !== 2) return Infinity;
    const budget = lease.budget!;
    const previous = this.pins.get(lease.executionId);
    if (previous && !sameBudget(previous.budget, budget))
      throw new ExecutionError(409, true, 'Immutable Canvas budget changed');
    const deadline = requestStarted + (budget.runDeadlineAt - lease.serverNow) * 1000;
    const pin = { budget: structuredClone(budget), deadline: Math.min(previous?.deadline ?? Infinity, deadline) };
    this.pins.set(lease.executionId, pin);
    return pin.deadline;
  }
}

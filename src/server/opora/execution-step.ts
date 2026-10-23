import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateExecution } from './execution-client.js';
import { commitsFromLog, pinnedSteps, stepResultsProblem, type StepStatus } from './plan-steps.js';

/**
 * `execution-worker.ts <bundle> step <id> [done|failed|skipped] [--notes <text>] [--check <text>]...`: the
 * worker reports one plan step as soon as its commit is made (Canvas `POST /executions/{id}/steps`, OporaHub
 * M4), so a crash after two of four steps keeps those two and the next run resumes at the third. Same bundle
 * and token as the result helper; the token never leaves this process. The commits come from git (`step <id>:`
 * messages), never from the agent. The request id is derived from the content: retrying the same checkpoint
 * replays it, a corrected one is a new checkpoint.
 */

/** A step command Canvas would refuse, with what to fix; nothing was sent. */
export class StepShapeError extends Error {}

export interface StepArgs { stepId: string; status: StepStatus; notes?: string; checks: string[] }

export function parseStepArgs(args: string[]): StepArgs {
  const [stepId, ...rest] = args;
  if (!stepId || !/^[A-Za-z0-9_-]{1,40}$/.test(stepId)) throw new StepShapeError('step needs the step id: step <id> [done|failed|skipped] [--notes <text>] [--check <text>]...');
  let status: StepStatus = 'done', notes: string | undefined;
  const checks: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (i === 0 && (arg === 'done' || arg === 'failed' || arg === 'skipped')) status = arg;
    else if ((arg === '--notes' || arg === '--check') && i + 1 < rest.length) {
      const value = rest[++i];
      if (arg === '--notes') notes = value; else checks.push(value);
    } else throw new StepShapeError(`step: unexpected argument ${JSON.stringify(arg.slice(0, 40))}; use [done|failed|skipped] [--notes <text>] [--check <text>]...`);
  }
  return { stepId, status, notes, checks };
}

/** Posts one step checkpoint; returns the small public receipt (never the token). */
export async function reportStep(bundlePath: string, args: StepArgs, transport: typeof fetch = fetch, log: () => string = () => '') {
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const lease = validateExecution(bundle, bundle);
  const steps = pinnedSteps(lease.assignment);
  if (!steps.length) throw new StepShapeError('This assignment has no plan steps; there is nothing to report with step.');
  const commits = (commitsFromLog(log(), steps).get(args.stepId) ?? []).slice(-50);
  // Notes are required by Canvas; a bare `step s1` after its commit says what the commit says.
  const notes = args.notes?.trim() || (commits.length ? `Committed as step ${args.stepId} (${commits.map(c => c.slice(0, 12)).join(', ')}).` : '');
  if (!notes) throw new StepShapeError(`step ${args.stepId}: no commit named "step ${args.stepId}: …" was found; commit the step first or pass --notes.`);
  const evidence = { notes, ...(args.checks.length ? { checks: args.checks } : {}), ...(commits.length ? { commits } : {}) };
  const item = { stepId: args.stepId, status: args.status, evidence };
  const problem = stepResultsProblem([item], steps);
  if (problem) throw new StepShapeError(problem.replace('stepResults', 'step'));
  const requestId = `step-${args.stepId}-${args.status}-${createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 16)}`;
  const response = await transport(new URL(`/api/oporahub/executions/${encodeURIComponent(lease.executionId)}/steps`, bundle.base), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json', Origin: new URL(bundle.base).origin, 'X-Opora-Actor': bundle.actor },
    body: JSON.stringify({ project: lease.project, workspace: lease.workspace, token: lease.token, epoch: lease.epoch, requestId, ...item }),
  });
  if (!response.ok) throw new Error(`Canvas refused the step checkpoint (${response.status})`);
  const stored = await response.json() as Record<string, unknown>;
  if (stored.executionId !== lease.executionId || stored.stepId !== args.stepId || stored.status !== args.status || typeof stored.checkpointId !== 'string')
    throw new Error('Invalid step checkpoint');
  return { checkpointId: stored.checkpointId, executionId: lease.executionId, stepId: args.stepId, status: args.status, verification: 'agent-reported; not independently verified' };
}

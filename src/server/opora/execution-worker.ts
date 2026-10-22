import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateExecution } from './execution-client.js';
import { sameBudget, validateBudget } from './execution-budget.js';
import { EXECUTION_INSTRUCTIONS_VERSION, validateContextProof, validateContextVersion } from './execution-context.js';
import { validSelfChecks } from './self-checks.js';
import { commitsFromLog, pinnedSteps, withStepCommits } from './plan-steps.js';

/** A result the helper refuses before sending anything, with what to fix; the same file can then be corrected. */
export class ResultShapeError extends Error {}

/** This branch's own commits (not on any remote), oldest first, as `<sha> US <subject>` lines; '' when git can't say. */
export function worktreeLog(cwd = process.cwd()): string {
  try {
    return execFileSync('git', ['log', '--reverse', '--max-count=500', '--format=%H%x1f%s', 'HEAD', '--not', '--remotes'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000, windowsHide: true });
  } catch { return ''; }
}

/** Capability never leaves this process; stdout contains a small public receipt only. */
export async function reportExecution(bundlePath: string, resultPath: string, transport: typeof fetch = fetch, log: () => string = worktreeLog) {
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const lease = validateExecution(bundle, bundle);
  if (lease.contextProtocolVersion === 2 && bundle.executionInstructionsVersion !== EXECUTION_INSTRUCTIONS_VERSION)
    throw new Error('Invalid execution instruction version');
  const raw = readFileSync(resultPath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 64000) throw new Error('Result is too large');
  let result = JSON.parse(raw);
  if (!result || typeof result.summary !== 'string' || !result.summary.trim()) throw new Error('Result needs a summary');
  // Self-check evidence goes to Canvas only in the exact shape it validates; anything else is left out, never the whole result refused.
  if (result.selfChecks !== undefined && !validSelfChecks(result.selfChecks)) {
    delete result.selfChecks;
    process.stderr.write('result.selfChecks was left out: it does not match the self-check shape (headSha, checks[name, command, exitCode, status]).\n');
  }
  // Plan steps: the commits come from git (`step <id>:` messages), never from the agent; Canvas would refuse a bad shape, so it's refused here first.
  if (result.stepResults !== undefined) {
    const steps = pinnedSteps(lease.assignment);
    const checked = withStepCommits(result, steps, steps.length ? commitsFromLog(log(), steps) : new Map());
    if (checked.problem) throw new ResultShapeError(`result.stepResults: ${checked.problem}. Fix the result file and run the helper again.`);
    if (!steps.length) process.stderr.write('result.stepResults was left out: this assignment has no plan steps.\n');
    result = checked.result;
  }
  const response = await transport(new URL(`/api/oporahub/executions/${encodeURIComponent(bundle.executionId)}/results`, bundle.base), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json', Origin: new URL(bundle.base).origin, 'X-Opora-Actor': bundle.actor },
    body: JSON.stringify({ project: bundle.project, workspace: bundle.workspace, token: bundle.token, epoch: bundle.epoch,
      requestId: bundle.resultRequestId, result }),
  });
  if (!response.ok) throw new Error(`Canvas refused result (${response.status})`);
  const receipt = await response.json() as Record<string, unknown>;
  if (receipt.executionId !== bundle.executionId || receipt.state !== 'reported' || typeof receipt.receiptId !== 'string') throw new Error('Invalid receipt');
  if (lease.executionProtocolVersion === 2 && (receipt.executionProtocolVersion !== 2
    || !sameBudget(validateBudget(receipt.budget), lease.budget!))) throw new Error('Invalid Canvas budget receipt');
  if (validateContextVersion(receipt.contextProtocolVersion) !== (lease.contextProtocolVersion ?? 1)) throw new Error('Invalid Canvas context receipt');
  if (lease.contextProtocolVersion === 2) validateContextProof(receipt.contextValidation, lease.acceptedRevision);
  // The office opens the pull request from this (pull-request-handoff.ts); failing to write it never fails the result.
  try {
    writeFileSync(path.join(path.dirname(bundlePath), `${bundle.executionId}-reported.json`),
      JSON.stringify({ receiptId: receipt.receiptId, result }, null, 2), { mode: 0o600 });
  } catch { /* the office then skips the pull request; the receipt stands */ }
  return { receiptId: receipt.receiptId, executionId: bundle.executionId, state: 'reported', verification: 'agent-reported; not independently verified' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reportExecution(process.argv[2], process.argv[3]).then(receipt => process.stdout.write(JSON.stringify(receipt) + '\n'))
    .catch((error) => { if (error instanceof ResultShapeError) { process.stderr.write(error.message + '\n'); process.exitCode = 1; return; }
      process.stderr.write('Canvas result was not confirmed. Keep the same result file and retry; do not continue work without authority.\n'); process.exitCode = 1; });
}

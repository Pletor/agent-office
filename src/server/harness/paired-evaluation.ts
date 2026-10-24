import { randomUUID } from 'node:crypto';
import { preparePair, type PairReceipt } from './paired-plan.js';

type Side = 'baseline' | 'candidate';
type Outcome = 'pass' | 'fail' | 'unknown';
type Result = {
  invocationId: string; execution: PairReceipt['execution']; resource: { id: string; digest: string };
  adapter: string; nodeVersion: string; exitCode: number | null; reason: string; durationMs: number;
  outputBytes: number; outcome: string; authorityCurrentAtCompletion: boolean; cleanupComplete: boolean;
  stdout: string;
};
export type PairAdapter = (read: () => Promise<PairReceipt>, resource: string, args: string[], cwd: string,
  options: { timeoutMs: number }) => Promise<Result>;
type Trial = { case: string; side: Side; order: number; outcome: Outcome; reason: string; invocationId: string | null };
type Observation = Omit<Result, 'stdout'> & { schema: string; evidence: string; independentlyVerified: false;
  causalContribution: false; promotionAllowed: false; tokens: null; cost: null };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const reasons = new Set(['completed', 'nonzero-exit', 'timeout', 'output-limit', 'execution-changed', 'execution-unavailable', 'spawn-failed']);

/** Uses the existing accepted-script adapter only; quality is a local fixture observation, never review authority. */
export async function evaluatePair(read: () => Promise<PairReceipt>, invoke: PairAdapter, resourceId: string, cwd: string) {
  const pinned = await preparePair(await read(), resourceId), signature = JSON.stringify(pinned);
  const started = performance.now(), trials: Trial[] = [], observations: Observation[] = [];
  let stopped = '', order = 0;
  const current = async () => {
    const value = await read();
    if (JSON.stringify(await preparePair(value, resourceId)) !== signature) throw new Error('Paired execution changed.');
    return value;
  };
  for (const [index, example] of pinned.plan.cases.entries()) {
    const sides: Side[] = index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    for (const side of sides) {
      const trial: Trial = { case: example.id, side, order: ++order, outcome: 'unknown', reason: stopped || 'adapter-error', invocationId: null };
      trials.push(trial);
      if (stopped) continue;
      const remaining = 60_000 - (performance.now() - started);
      if (remaining <= 0) { stopped = trial.reason = 'launch-budget-exhausted'; continue; }
      try {
        const result = await invoke(current, pinned[side].id, [...example.args], cwd, { timeoutMs: Math.min(5000, remaining) });
        const e = result.execution;
        const execution = e && { executionId: e.executionId, epoch: e.epoch, project: e.project, workspace: e.workspace,
          nodeId: e.nodeId, acceptedRevision: e.acceptedRevision, assignmentDigest: e.assignmentDigest };
        if (!same(execution, pinned.execution) || !same(result.resource, pinned[side])
          || typeof result.invocationId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![\s\S])/.test(result.invocationId)
          || observations.some(o => o.invocationId === result.invocationId)
          || result.adapter !== 'node-readonly/1' || typeof result.nodeVersion !== 'string' || result.nodeVersion.length > 64
          || !/^v\d+\.\d+\.\d+(?![\s\S])/.test(result.nodeVersion) || !reasons.has(result.reason)
          || !(result.exitCode === null || (Number.isInteger(result.exitCode) && result.exitCode >= -2147483648 && result.exitCode <= 2147483647))
          || !Number.isFinite(result.durationMs) || result.durationMs < 0 || result.durationMs > 60000
          || !Number.isSafeInteger(result.outputBytes) || result.outputBytes < 0 || result.outputBytes > 1024 ** 3
          || typeof result.authorityCurrentAtCompletion !== 'boolean' || typeof result.cleanupComplete !== 'boolean'
          || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 256 * 1024) throw new Error('Invalid adapter result.');
        const passed = result.reason === 'completed' && result.exitCode === 0 && result.authorityCurrentAtCompletion && result.cleanupComplete;
        if (result.outcome !== (passed ? 'pass' : 'fail')) throw new Error('Inconsistent adapter result.');
        // Explicit projection: never persist raw output, arguments, callback errors or arbitrary adapter fields.
        observations.push({ schema: 'harness.invocation-metadata/1', invocationId: result.invocationId,
          execution: { ...pinned.execution }, resource: { ...pinned[side] }, adapter: result.adapter, nodeVersion: result.nodeVersion,
          exitCode: result.exitCode, reason: result.reason, durationMs: result.durationMs, outputBytes: result.outputBytes,
          outcome: result.outcome, authorityCurrentAtCompletion: result.authorityCurrentAtCompletion, cleanupComplete: result.cleanupComplete,
          evidence: 'worker-observed', independentlyVerified: false, causalContribution: false, promotionAllowed: false, tokens: null, cost: null });
        trial.invocationId = result.invocationId;
        trial.outcome = passed && result.stdout === example.expectedStdout ? 'pass' : 'fail';
        trial.reason = trial.outcome === 'pass' ? 'expected-output' : passed ? 'output-mismatch' : result.reason;
        if (!result.authorityCurrentAtCompletion || result.reason.startsWith('execution-') || !result.cleanupComplete) {
          stopped = !result.authorityCurrentAtCompletion || result.reason.startsWith('execution-') ? 'authority-not-current' : 'cleanup-incomplete';
          trial.reason = stopped;
        }
      } catch {
        // The adapter may have launched before failing. Retain an unknown attempt and stop; do not invent an invocation.
        stopped = trial.reason = 'adapter-error-or-authority-unavailable';
      }
    }
  }
  let authorityCurrentAtCompletion = false;
  try { await current(); authorityCurrentAtCompletion = true; } catch { /* Historical results stay visible, no current endorsement. */ }
  const counts = (side: Side) => {
    const rows = trials.filter(t => t.side === side);
    return { planned: rows.length, pass: rows.filter(t => t.outcome === 'pass').length,
      fail: rows.filter(t => t.outcome === 'fail').length, unknown: rows.filter(t => t.outcome === 'unknown').length };
  };
  const baseline = counts('baseline'), candidate = counts('candidate');
  let improvements = 0, regressions = 0, incomparable = 0;
  for (const example of pinned.plan.cases) {
    const a = trials.find(t => t.case === example.id && t.side === 'baseline')!;
    const b = trials.find(t => t.case === example.id && t.side === 'candidate')!;
    if (a.outcome === 'unknown' || b.outcome === 'unknown') incomparable++;
    else if (a.outcome === 'fail' && b.outcome === 'pass') improvements++;
    else if (a.outcome === 'pass' && b.outcome === 'fail') regressions++;
  }
  const complete = incomparable === 0 && authorityCurrentAtCompletion && !stopped;
  return { schema: 'harness.paired-result/1', evaluationId: randomUUID(), execution: pinned.execution,
    plan: pinned.resource, problem: pinned.plan.problem, nativeProblem: 'evaluation:paired-node',
    baseline: { ...pinned.baseline, ...baseline }, candidate: { ...pinned.candidate, ...candidate },
    status: complete ? 'complete' : 'incomplete', authorityCurrentAtCompletion,
    comparison: { improvements, regressions, incomparable, passDifference: candidate.pass - baseline.pass,
      conclusion: !complete ? 'incomplete' : regressions ? 'regression-on-fixtures' : improvements ? 'candidate-better-on-fixtures' : 'no-improvement-on-fixtures' },
    plannedInvocations: trials.length, observedInvocations: observations.length, trials, harnessInvocations: observations,
    evidence: 'worker-observed', independentlyVerified: false, causalContribution: false, promotionAllowed: false,
    coverage: 'all predeclared fixture cases; not independent production trials',
    outputComparison: 'exact adapter-normalized stdout plus successful exit, current authority and cleanup',
    durationMs: Math.max(0, performance.now() - started), tokens: null, cost: null };
}

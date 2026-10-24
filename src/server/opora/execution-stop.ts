import { EXECUTION_FINISHED } from './execution-controller.js';

/**
 * Report the stop adapter outcome without claiming descendant process exit. When Canvas finished the
 * execution because its result is in (EXECUTION_FINISHED), the worker is still sent home but the run
 * ends without an error and nobody is warned, unless the stop itself goes wrong.
 */
export function requestExecutionStop(
  run: { state: string; error?: string } | undefined, id: string, reason: string,
  stop: ((id: string) => Promise<unknown>) | undefined, changed: () => void,
  warn: (message: string) => void,
) {
  const finished = reason === EXECUTION_FINISHED;
  const update = (stage: string, trouble = false) => {
    if (!run) return;
    run.state = 'gone';
    if (!finished) run.error = `${reason}; ${stage}`;
    else if (trouble) run.error = `${reason}; ${stage}`;
    else delete run.error;
    changed();
  };
  update('worker stop requested');
  if (!finished) warn(reason);
  if (!stop) { update('stop adapter unavailable; inspect the process manually', true); return; }
  try {
    void stop(id).then(result => {
      const failed = !!result && typeof result === 'object' && 'error' in result && !!result.error;
      update(failed ? 'stop adapter reported an error; inspect the process manually'
        : 'stop adapter returned; descendant process exit is not verified', failed);
    }).catch(() => { update('stop adapter failed; inspect the process manually', true); warn('Worker stop failed; inspect the process manually'); });
  } catch { update('stop adapter failed; inspect the process manually', true); }
}

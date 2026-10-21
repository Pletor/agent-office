/** Report the stop adapter outcome without claiming descendant process exit. */
export function requestExecutionStop(
  run: { state: string; error?: string } | undefined, id: string, reason: string,
  stop: ((id: string) => Promise<unknown>) | undefined, changed: () => void,
  warn: (message: string) => void,
) {
  const update = (stage: string) => { if (run) { run.state = 'gone'; run.error = `${reason}; ${stage}`; changed(); } };
  update('worker stop requested');
  warn(reason);
  if (!stop) { update('stop adapter unavailable; inspect the process manually'); return; }
  try {
    void stop(id).then(result => {
      const failed = !!result && typeof result === 'object' && 'error' in result && !!result.error;
      update(failed ? 'stop adapter reported an error; inspect the process manually'
        : 'stop adapter returned; descendant process exit is not verified');
    }).catch(() => { update('stop adapter failed; inspect the process manually'); warn('Worker stop failed; inspect the process manually'); });
  } catch { update('stop adapter failed; inspect the process manually'); }
}

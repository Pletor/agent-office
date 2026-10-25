import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { childEnv } from './env.js';
import { binScript } from './process.js';
import type { RunAs, Worker } from './types.js';
import type { StagedWorker } from './staged-start.js';
import { withPreparationAccess } from './preparation-access.js';

export interface RuntimePreparationHost {
  hookUrl: string; dataDir: string; workers: ReadonlyMap<string, Worker>; runAs?: RunAs;
}

/** Node/documentation probes use the reserved directory and worker account, never provider stdio. */
export function attachRuntimePreparation(stage: StagedWorker, floorDir: string, host?: RuntimePreparationHost) {
  if (process.env.AGENT_OFFICE_HARNESS_PREPARE_WORKER !== '1') return stage;
  const script = binScript('harness-prepare-worker.js');
  if (!host || !script) throw new Error('Harness worker preparation module is unavailable');
  stage.verify = async signal => {
    const worker = host.workers.get(stage.worker.id);
    if (!worker?.preparing || stage.signal.aborted) throw new Error('Worker preparation reservation is unavailable');
    const env = childEnv();
    Object.assign(env, { AGENT_OFFICE_HOOK_URL: host.hookUrl, AGENT_OFFICE_WORKER_ID: worker.info.id,
      AGENT_OFFICE_HOOK_TOKEN: worker.hookToken });
    if (worker.owner && host.runAs) host.runAs.apply(worker.owner, env, [floorDir, stage.cwd]);
    const output = await withPreparationAccess(worker,
      () => !signal.aborted && !stage.signal.aborted && host.workers.get(worker.info.id) === worker,
      () => stage.prepare(cwd => new Promise<{ report: string; succeeded: boolean }>((resolve, reject) => {
      execFile(process.execPath, [script], { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 55_000,
        maxBuffer: 256 * 1024, signal: AbortSignal.any([signal, stage.signal]) }, (error, stdout) => {
        if (error && !stdout) reject(new Error('Harness worker preparation failed; provider was not started'));
        else resolve({ report: stdout, succeeded: !error });
      });
    })));
    const result = JSON.parse(output.report);
    if (result?.schema !== 'harness.preparation/1' || result.scope !== 'worker-process' || typeof result.ready !== 'boolean'
      || result.permissionsGranted !== false || result.resourceContentsExecuted !== false)
      throw new Error('Harness worker preparation did not prove readiness');
    if (signal.aborted || stage.signal.aborted || host.workers.get(worker.info.id) !== worker)
      throw new Error('Worker preparation was cancelled');
    const directory = path.join(host.dataDir, 'preparation-results');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, createHash('sha256').update(worker.info.id).digest('hex') + '.json'), output.report,
      { flag: 'wx', mode: 0o600 });
    if (!output.succeeded || result.ready !== true || result.authorityCurrentAtCompletion !== true || result.cleanupComplete !== true)
      throw new Error('Harness worker equipment is unavailable; inspect preparation-results');
  };
  return stage;
}

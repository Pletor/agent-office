import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Worker } from './types.js';
import type { StagedWorker } from './staged-start.js';
import { attachRuntimePreparation, type RuntimePreparationHost } from './runtime-preparation.js';

/** Structural capability supplied by the existing worktree-setup module when installed. */
interface DependencySetup {
  ensure(cwd: string): Promise<{ exitCode: number } | undefined>;
}

/** Prepare the actual reserved directory; a configured but unavailable/failed installer refuses dispatch. */
export async function prepareTaskWorker(allocate: () => StagedWorker | string, trees: object, floorDir: string, runtime?: RuntimePreparationHost): Promise<StagedWorker> {
  const worker = allocate();
  if (typeof worker === 'string') throw new Error(worker);
  try {
    if (existsSync(path.join(floorDir, '.agent-office', 'worktree-setup.json'))) {
      if (!worker.worker.worktree) throw new Error('Configured dependency setup requires an isolated worker worktree');
      const setup = (trees as { setup?: DependencySetup }).setup;
      if (!setup || typeof setup.ensure !== 'function') throw new Error('Configured worktree dependency installer is unavailable');
      await worker.prepare(async cwd => {
        const result = await setup.ensure(cwd);
        if (!result || result.exitCode !== 0) throw new Error('Worker dependency preparation failed; execution was not claimed');
      });
    }
    if (worker.signal.aborted) throw new Error('Worker preparation was cancelled');
    return attachRuntimePreparation(worker, floorDir, runtime);
  } catch (error) { await worker.cancel(); throw error; }
}

/** Opt-in until provider environment and full Harness readiness are integrated. */
export function stagedOporaEnabled() {
  const runtime = process.env.AGENT_OFFICE_HARNESS_PREPARE_WORKER;
  if (runtime !== undefined && (runtime !== '1' || process.env.AGENT_OFFICE_OPORA_PREPARE_WORKER !== '1'
    || process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION !== '2'))
    throw new Error('Harness worker preparation requires both preparation flags set to 1 and context version 2');
  return process.env.AGENT_OFFICE_OPORA_PREPARE_WORKER === '1';
}

/** Ordinary hires keep setup-before-launch; staged hires wait for their owning handle. */
export function launchAllocatedWorker(worker: Worker, prompt: string | undefined,
  prepare: () => Promise<string | undefined> | undefined, current: () => boolean,
  launch: (prompt: string | undefined) => void) {
  if (worker.preparing) { worker.info.status = 'exited'; worker.info.activity = 'Preparing worker environment'; return; }
  const setup = prepare();
  if (!setup) { launch(prompt); return; }
  // Until the setup is done it is `settingUp`: resume and launch refuse it, so its prompt isn't lost.
  worker.settingUp = true;
  void setup.then(p => {
    worker.settingUp = undefined;
    if (current() && !worker.pty && !worker.dsh) launch(p);
  });
}

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { StagedWorker } from './staged-start.js';

/** Structural capability supplied by the existing worktree-setup module when installed. */
interface DependencySetup {
  ensure(cwd: string): Promise<{ exitCode: number } | undefined>;
}

/** Prepare the actual reserved directory; a configured but unavailable/failed installer refuses dispatch. */
export async function prepareTaskWorker(allocate: () => StagedWorker | string, trees: object, floorDir: string): Promise<StagedWorker> {
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
    return worker;
  } catch (error) { await worker.cancel(); throw error; }
}

/** Opt-in until provider environment and full Harness readiness are integrated. */
export const stagedOporaEnabled = () => process.env.AGENT_OFFICE_OPORA_PREPARE_WORKER === '1';

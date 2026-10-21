// What the preparation runner (prepare.ts) does for the bridge besides preparing: the task it hands the
// bridge for a card, and the recovery a bridge runs at each poll. The recovery finds the runs an office
// left when it stopped, and finishes each the one safe way: a run interrupted before it was prepared is
// rolled back; a prepared run stays to be taken up by the next take of its card, until it is stale; a
// claimed run whose worker was seated is recorded as seated (and handed to the bridge when it doesn't
// hold it), and one whose worker never came has its lease released and is rolled back. Nothing is
// prepared, claimed or seated by the recovery. Final records are swept by age.
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { prepareRun, finishRollback, runsInFlight, type PrepareOptions } from './prepare.js';
import { deleteRecord, listRecords, ownerAlive, OWNER_FRESH_MS, preparedDir, PrepareFenceError, updateRecord, type PreparedRecord } from './prepare-store.js';
import { harnessRepoKey } from './profiles.js';
import type { AdoptedRun, PreparedTask, RunRecovery } from '../opora/prepared.js';
import type { HierarchyNode } from '../../shared/harness-hierarchy.js';
import type { OporaPlace } from '../../shared/opora-identity.js';
import type { AgentProvider } from '../../shared/providers.js';

const HOUR = 60 * 60_000;
/** How long records are kept: a prepared run nobody claims, a run whose owning process seems alive, and a final record. */
export const PREPARE_RETENTION = { preparedMs: 30 * 60_000, ownerMs: OWNER_FRESH_MS, finalMs: 7 * 24 * HOUR };

/**
 * The task for a card, prepared by the runner: the worker's prompt section, the run, and the moves the
 * bridge makes with it (claimed, seated, discard = roll back). Throws when the run can't be prepared.
 */
export async function preparedCardRun(dataDir: string, repo: string, place: OporaPlace, card: string, nodes: readonly HierarchyNode[], local: boolean, options: PrepareOptions & { runner?: AgentProvider } = {}): Promise<PreparedTask & { resumed: boolean }> {
  const { runner, ...rest } = options;
  const run = await prepareRun({ dataDir, repo, place, card, nodes, local, ...(runner ? { runner } : {}) }, rest);
  return {
    context: run.context,
    snapshot: { runId: run.runId, digest: run.digest },
    state: 'prepared',
    resumed: run.resumed,
    ...(run.launch ? { runner: run.launch.runner } : {}),
    claimed: (lease) => run.claimed(lease),
    seated: (workerId) => run.seated(workerId),
    discard: (reason) => run.rollback(reason ?? 'the card was not taken'),
  };
}

/** A worker on the floor seated for this run: by the id recorded, or by the run its contract names. */
function seatedWorker(r: PreparedRecord, deps: RunRecovery) {
  return deps.workers().find((w) => (r.workerId && w.id === r.workerId) || (w.prompt ?? '').includes('\nRun: ' + r.runId + '\n'));
}

/**
 * Recovers the runs of the floor checked out at `repo` that no live process has under way, and sweeps
 * old ones. Returns the seated runs the bridge doesn't hold, for it to hold, and what was done to each run.
 */
export async function recoverRuns(dataDir: string, repo: string, deps: RunRecovery, now = Date.now(), retention = PREPARE_RETENTION): Promise<{ adopted: AdoptedRun[]; done: { runId: string; action: string }[] }> {
  const key = harnessRepoKey(repo);
  const adopted: AdoptedRun[] = [], done: { runId: string; action: string }[] = [];
  const { records, damaged } = listRecords(dataDir);
  const inFlight = runsInFlight();
  for (const r of records.filter((x) => x.repo === key)) {
    if (inFlight.has(r.runId)) continue;
    const age = now - Date.parse(r.updatedAt);
    // Another office process working on it right now (two offices on one data dir): left alone while it is fresh.
    const elsewhere = ownerAlive(r.owner, inFlight, r.runId) && age < retention.ownerMs;
    try {
      if (r.state === 'planned' || r.state === 'preparing') {
        if (elsewhere) continue;
        await finishRollback(dataDir, r.runId, 'interrupted before it was prepared (the office stopped)');
        done.push({ runId: r.runId, action: 'rolled back (interrupted while preparing)' });
      } else if (r.state === 'prepared') {
        if (age <= retention.preparedMs || elsewhere) continue;
        await finishRollback(dataDir, r.runId, `prepared ${Math.round(age / 60_000)} min ago and never claimed`);
        done.push({ runId: r.runId, action: 'rolled back (stale)' });
      } else if (r.state === 'claimed') {
        if (elsewhere) continue;
        // Decided under the run's lock on the record as it is now, never on the listing above: a take of
        // this office that has the run in flight, or seated it meanwhile, is never touched.
        let worker: ReturnType<typeof seatedWorker>;
        await updateRecord(dataDir, r.runId, ['claimed'], undefined, (x) => {
          if (inFlight.has(x.runId)) throw new PrepareFenceError(`run ${x.runId} is under way in this office`);
          worker = seatedWorker(x, deps);
        });
        if (worker) {
          const found = worker;
          const seated = await updateRecord(dataDir, r.runId, ['claimed'], 'seated', (x) => { x.workerId = found.id; }, 'the worker was seated before the office stopped: recorded, not seated again');
          if (!deps.held.has(r.runId)) adopted.push(adopt(seated, found));
          done.push({ runId: r.runId, action: 'recorded as seated' });
          continue;
        }
        const released = r.lease ? await deps.release(r.card, r.card.nodeId, r.lease.token) : 'released';
        if (released === 'unreachable') {
          await updateRecord(dataDir, r.runId, ['claimed'], undefined, (x) => { x.error = { step: 'recover', reason: 'Opora did not answer to release the lease; tried again at the next poll' }; });
          continue;
        }
        await finishRollback(dataDir, r.runId, 'claimed by an office that stopped before the worker was seated: the lease was released', [], 'seat');
        done.push({ runId: r.runId, action: 'lease released and rolled back' });
      } else if (r.state === 'failed') {
        if (elsewhere) continue;
        await finishRollback(dataDir, r.runId, r.error?.reason ?? 'failed');
        done.push({ runId: r.runId, action: 'rollback finished' });
      } else if (r.state === 'seated') {
        const worker = seatedWorker(r, deps);
        if (worker && !deps.held.has(r.runId)) { adopted.push(adopt(r, worker)); done.push({ runId: r.runId, action: 'held again' }); }
        else if (!worker && age > retention.finalMs) { deleteRecord(dataDir, r.runId); done.push({ runId: r.runId, action: 'swept' }); }
      } else if (age > retention.finalMs) { deleteRecord(dataDir, r.runId); done.push({ runId: r.runId, action: 'swept' }); }
    } catch (err) {
      done.push({ runId: r.runId, action: 'left as it is: ' + (err as Error).message });
    }
  }
  for (const d of damaged) if (d.ageMs > retention.finalMs) try { unlinkSync(d.file); } catch { /* gone */ }
  sweepTemps(dataDir, now);
  return { adopted, done };
}

function adopt(r: PreparedRecord, worker: ReturnType<RunRecovery['workers']>[number]): AdoptedRun {
  return { runId: r.runId, digest: r.digest ?? '', card: { ...r.card }, ...(r.cardMeta ? { cardMeta: { ...r.cardMeta } } : {}), worker: { id: worker.id, name: worker.name, deskId: worker.deskId }, ...(r.lease ? { lease: { token: r.lease.token, agent: r.lease.agent } } : {}) };
}

/** Temporary files a crash left between writing a record and renaming it into place, after an hour. */
function sweepTemps(dataDir: string, now: number) {
  const dir = preparedDir(dataDir);
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names.filter((n) => n.endsWith('.tmp'))) try { if (now - statSync(path.join(dir, name)).mtimeMs > HOUR) unlinkSync(path.join(dir, name)); } catch { /* gone */ }
}

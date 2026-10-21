// What the preparation runner (prepare.ts) does for the bridge besides preparing: the task it hands the
// bridge for a card, and the recovery a bridge runs at each poll. The recovery finds the runs an office
// left when it stopped, and finishes each the one safe way: a run interrupted before it was prepared is
// rolled back; a prepared run stays to be taken up by the next take of its card, until it is stale; a
// run the office stopped claiming has the lease it may hold released; a claimed run whose worker was
// seated (that worker id at the run's desk) is recorded as seated (and handed to the bridge when it
// doesn't hold it), and one whose worker never came has its lease released and is rolled back. Nothing
// is prepared, claimed or seated by the recovery. It reads the index of active runs only (in full,
// never capped), and sweeps final records by age and count within a time budget (prepare-index.ts).
import { readFileSync } from 'node:fs';
import { prepareRun, finishRollback, runsInFlight, type PrepareOptions } from './prepare.js';
import { claimFile, deleteRecord, ownerAlive, OWNER_FRESH_MS, PrepareFenceError, updateRecord, type PreparedRecord } from './prepare-store.js';
import { activeRecords, FINAL_RETENTION, sweepFinal } from './prepare-index.js';
import { harnessRepoKey } from './profiles.js';
import type { AdoptedRun, PreparedTask, RunRecovery } from '../opora/prepared.js';
import type { HierarchyNode } from '../../shared/harness-hierarchy.js';
import type { OporaPlace } from '../../shared/opora-identity.js';

/** How long records are kept: a prepared run nobody claims, a run whose owning process seems alive, a final record, and how many final records at most. */
export const PREPARE_RETENTION = { preparedMs: 30 * 60_000, ownerMs: OWNER_FRESH_MS, finalMs: FINAL_RETENTION.finalMs, finalKeep: FINAL_RETENTION.keep, budgetMs: FINAL_RETENTION.budgetMs };

/**
 * The task for a card, prepared by the runner: the worker's prompt section, the run, and the moves the
 * bridge makes with it (claiming, claimed, seated, discard = roll back). Throws when the run can't be prepared.
 */
export async function preparedCardRun(dataDir: string, repo: string, place: OporaPlace, card: string, nodes: readonly HierarchyNode[], local: boolean, options: PrepareOptions = {}, floor?: string): Promise<PreparedTask & { resumed: boolean }> {
  const run = await prepareRun({ dataDir, repo, place, card, nodes, local, ...(floor ? { floor } : {}) }, options);
  return {
    context: run.context,
    snapshot: { runId: run.runId, digest: run.digest },
    state: 'prepared',
    resumed: run.resumed,
    claiming: (agent, deskId) => run.claiming(agent, deskId),
    granted: (lease) => run.granted(lease),
    claimed: (lease) => run.claimed(lease),
    seated: (workerId) => run.seated(workerId),
    releaseFailed: (reason) => run.releaseFailed(reason),
    discard: (reason) => run.rollback(reason ?? 'the card was not taken'),
  };
}

/**
 * The worker seated for this run: the recorded worker id at the recorded desk, or (seated by an office
 * that stopped before it recorded the worker) the worker at the run's desk whose contract names the run.
 * A `Run:` line alone, at another desk or without a desk recorded, is no one's.
 */
function seatedWorker(r: PreparedRecord, deps: RunRecovery) {
  const workers = deps.workers();
  // A record from before the desk was kept (no deskId) is matched by its worker id alone.
  if (r.workerId) return workers.find((w) => w.id === r.workerId && (!r.deskId || w.deskId === r.deskId));
  if (!r.deskId) return undefined;
  return workers.find((w) => w.deskId === r.deskId && (w.prompt ?? '').includes('\nRun: ' + r.runId + '\n'));
}

/** Whether a record is this floor's: by its floor id; an older record without one only while no other floor shares the checkout. */
const ofFloor = (r: PreparedRecord, key: string, deps: RunRecovery) => r.repo === key && (r.floor ? !deps.floor || r.floor === deps.floor : !deps.sharedCheckout);

/** The token a take wrote the moment its claim answered, when the office stopped before recording it. */
function pendingClaim(dataDir: string, runId: string): string | undefined {
  try { const t = (JSON.parse(readFileSync(claimFile(dataDir, runId), 'utf8')) as { token?: unknown }).token; return typeof t === 'string' && t ? t : undefined; } catch { return undefined; }
}

/**
 * Recovers the runs of the floor checked out at `repo` that no live process has under way, and sweeps
 * old ones. Returns the seated runs the bridge doesn't hold, for it to hold, and what was done to each run.
 */
export async function recoverRuns(dataDir: string, repo: string, deps: RunRecovery, now = Date.now(), retention: Partial<typeof PREPARE_RETENTION> = {}): Promise<{ adopted: AdoptedRun[]; done: { runId: string; action: string }[] }> {
  const keep = { ...PREPARE_RETENTION, ...retention };
  const key = harnessRepoKey(repo);
  const adopted: AdoptedRun[] = [], done: { runId: string; action: string }[] = [];
  const inFlight = runsInFlight();
  // Decided again under the run's lock: a take of this office that picked the run up since the listing, or any move since, wins.
  const unchanged = (listed: PreparedRecord) => (x: PreparedRecord) => { if (inFlight.has(x.runId) || x.revision !== listed.revision) throw new PrepareFenceError(`run ${x.runId} moved since the recovery read it`); };
  const unreachable = (r: PreparedRecord, from: PreparedRecord['state']) => updateRecord(dataDir, r.runId, [from], undefined, (x) => { x.error = { step: 'recover', reason: 'Opora did not answer to release the lease; tried again at the next poll' }; });
  for (const r of (await activeRecords(dataDir)).filter((x) => ofFloor(x, key, deps))) {
    if (inFlight.has(r.runId)) continue;
    const age = now - Date.parse(r.updatedAt);
    // Another office process working on it right now (two offices on one data dir): left alone while it is fresh.
    const elsewhere = ownerAlive(r.owner, inFlight, r.runId) && age < keep.ownerMs;
    try {
      if (r.state === 'planned' || r.state === 'preparing') {
        if (elsewhere) continue;
        await finishRollback(dataDir, r.runId, 'interrupted before it was prepared (the office stopped)', [], 'recover', false, unchanged(r));
        done.push({ runId: r.runId, action: 'rolled back (interrupted while preparing)' });
      } else if (r.state === 'prepared' && r.claiming) {
        if (elsewhere) continue;
        // Stopped between asking for the claim and recording it: the token written when it answered is released.
        const token = pendingClaim(dataDir, r.runId);
        if (token && await deps.release(r.card, r.card.nodeId, token) === 'unreachable') { await unreachable(r, 'prepared'); continue; }
        await finishRollback(dataDir, r.runId, token ? 'the office stopped right after its claim: the lease was released' : 'the office stopped while claiming, before Opora answered: a lease granted then runs out with its TTL', [], 'claim', false, unchanged(r));
        done.push({ runId: r.runId, action: token ? 'lease released and rolled back (stopped while claiming)' : 'rolled back (stopped while claiming)' });
      } else if (r.state === 'prepared') {
        if (age <= keep.preparedMs || elsewhere) continue;
        await finishRollback(dataDir, r.runId, `prepared ${Math.round(age / 60_000)} min ago and never claimed`, [], 'recover', false, unchanged(r));
        done.push({ runId: r.runId, action: 'rolled back (stale)' });
      } else if (r.state === 'claimed') {
        // The bridge holds it (a seat it recorded as failed whose worker came and went): the bridge lets it go, not the recovery.
        if (elsewhere || deps.held.has(r.runId)) continue;
        // Decided under the run's lock on the record as it is now, never on the listing above: a take of
        // this office that has the run in flight, or seated it meanwhile, is never touched.
        let worker: ReturnType<typeof seatedWorker>;
        const current = await updateRecord(dataDir, r.runId, ['claimed'], undefined, (x) => {
          if (inFlight.has(x.runId)) throw new PrepareFenceError(`run ${x.runId} is under way in this office`);
          worker = seatedWorker(x, deps);
        });
        if (worker) {
          const found = worker;
          const seated = await updateRecord(dataDir, r.runId, ['claimed'], 'seated', (x) => { x.workerId = found.id; x.deskId = found.deskId; }, 'the worker was seated before the office stopped: recorded, not seated again');
          if (!deps.held.has(r.runId)) adopted.push(adopt(seated, found));
          done.push({ runId: r.runId, action: 'recorded as seated' });
          continue;
        }
        const token = current.lease?.token;
        // Only Opora saying the lease isn't there (404, 409, 410) counts as released: anything else keeps the run claimed.
        if (token && await deps.release(r.card, r.card.nodeId, token) === 'unreachable') { await unreachable(r, 'claimed'); continue; }
        await finishRollback(dataDir, r.runId, 'claimed by an office that stopped before the worker was seated: the lease was released', [], 'seat', true);
        done.push({ runId: r.runId, action: 'lease released and rolled back' });
      } else if (r.state === 'failed') {
        if (elsewhere) continue;
        await finishRollback(dataDir, r.runId, r.error?.reason ?? 'failed');
        done.push({ runId: r.runId, action: 'rollback finished' });
      } else if (r.state === 'seated') {
        const worker = seatedWorker(r, deps);
        if (worker && !deps.held.has(r.runId)) { adopted.push(adopt(r, worker)); done.push({ runId: r.runId, action: 'held again' }); }
        else if (!worker && age > keep.finalMs) { deleteRecord(dataDir, r.runId, r); done.push({ runId: r.runId, action: 'swept' }); }
      }
    } catch (err) {
      done.push({ runId: r.runId, action: 'left as it is: ' + (err as Error).message });
    }
  }
  for (const runId of await sweepFinal(dataDir, now, { finalMs: keep.finalMs, keep: keep.finalKeep, budgetMs: keep.budgetMs })) done.push({ runId, action: 'swept' });
  return { adopted, done };
}

function adopt(r: PreparedRecord, worker: ReturnType<RunRecovery['workers']>[number]): AdoptedRun {
  return { runId: r.runId, digest: r.digest ?? '', card: { ...r.card }, ...(r.cardMeta ? { cardMeta: { ...r.cardMeta } } : {}), worker: { id: worker.id, name: worker.name, deskId: worker.deskId }, ...(r.lease?.token ? { lease: { token: r.lease.token, agent: r.lease.agent } } : {}) };
}

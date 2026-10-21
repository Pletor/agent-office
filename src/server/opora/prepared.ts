// The bridge's side of a prepared run (harness/prepare.ts, docs/harness.md "Preparation runner"): what
// the task preparation hands the bridge, the claim and the seat done in that order and undone together,
// and the runs a restarted office finds already seated. The bridge itself only calls these.
import type { OporaRun, WorkerInfo } from '../../shared/protocol.js';
import type { OporaPlace } from '../../shared/opora-identity.js';
import type { Lease } from './client.js';

/** A run snapshot's id and digest (docs/harness.md "Run snapshot and lazy reads"). */
export interface RunRef { runId: string; digest: string }

/** Task context for a card's worker, and the run it was prepared as, when there is one. */
export interface PreparedTask {
  context: string;
  snapshot?: RunRef;
  /** The run's state from the preparation runner: the card is claimed only when it is `prepared`. Absent for plain context. */
  state?: string;
  /** Records the lease once the card is claimed (refused when the run was moved meanwhile: the bridge lets the lease go then). */
  claimed?(lease: { token: string; agent: string; card?: { name: string; group: 'dev' | 'design'; sectorName?: string } }): Promise<void> | void;
  /** Records the worker once it is seated; the bridge calls it after it holds the run, so a poll never finds the run seated and not held. */
  seated?(workerId: string): Promise<void> | void;
  /** Drops what was prepared when the card is not taken after all (the claim or the seat failed). */
  discard?(reason?: string): Promise<void> | void;
}

/** The office's side of a card it took: what it needs to keep the lease and let it go. */
export interface Held extends OporaRun {
  token?: string;
  owner?: string;
  /** The run snapshot the worker was seated with: the only one its lazy reads may come from. */
  snapshot?: RunRef;
}

/** What a restarted bridge hands the preparation runner to recover the runs an earlier office left. */
export interface RunRecovery {
  /** The floor's workers now (read again under a run's lock): a run whose worker is here (by id, or by the run named in its prompt) was seated. */
  workers(): readonly Pick<WorkerInfo, 'id' | 'name' | 'deskId' | 'prompt'>[];
  /** The run ids the bridge holds (not gone). */
  held: ReadonlySet<string>;
  /** Lets a lease go: 'unreachable' when Opora didn't answer (the recovery tries again at the next poll). */
  release(place: OporaPlace, card: string, token: string): Promise<'released' | 'unreachable'>;
}
/** A run the recovery found seated that the bridge doesn't hold: the bridge holds it from now on. */
export interface AdoptedRun {
  runId: string; digest: string; card: OporaPlace & { nodeId: string };
  cardMeta?: { name: string; group: 'dev' | 'design'; sectorName?: string };
  worker: Pick<WorkerInfo, 'id' | 'name' | 'deskId'>;
  lease?: { token: string; agent: string };
}

const undo = async (prepared: PreparedTask, why: string) => { try { await prepared.discard?.(why); } catch { /* the recovery finishes it */ } };

/**
 * Claims the card and seats its worker for a prepared task, in that order and only for a run in
 * `prepared` (or plain context). A refused claim drops what was prepared; anything that fails after the
 * claim (recording it, the seat refusing or throwing) lets the lease go and drops it too, so a failed
 * take never keeps a lease. Resolves to the lease and the worker, or to why it couldn't. The caller
 * holds the run and then calls `prepared.seated` (until then the run stays in flight, untouched by a recovery).
 */
export async function claimAndSeat(prepared: PreparedTask, card: { name: string; group: 'dev' | 'design'; sectorName?: string }, agent: string, ops: {
  claim(): Promise<Lease>;
  release(token: string): Promise<void>;
  seat(lease: Lease): Promise<WorkerInfo | string>;
  /** The reply for a claim Opora refused. */
  refused(err: unknown): string;
}): Promise<{ lease: Lease; worker: WorkerInfo } | string> {
  if (prepared.state !== undefined && prepared.state !== 'prepared') {
    await undo(prepared, 'not prepared');
    return `Task context: the run is ${prepared.state}, not prepared; the card was not claimed`;
  }
  let lease: Lease;
  try { lease = await ops.claim(); } catch (err) {
    await undo(prepared, 'the claim was refused: ' + (err as Error).message);
    return ops.refused(err);
  }
  const fail = async (why: string) => {
    await ops.release(lease.token).catch(() => undefined);
    await undo(prepared, why);
    return why;
  };
  try { await prepared.claimed?.({ token: lease.token, agent, card }); } catch (err) { return fail('Task context: ' + (err as Error).message); }
  let worker: WorkerInfo | string;
  try { worker = await ops.seat(lease); } catch (err) { worker = (err as Error).message || 'The worker could not be seated'; }
  if (typeof worker === 'string') return fail(worker);
  return { lease, worker };
}

/** The bridge's run for a run the recovery adopted (seated by an office that stopped before it saved its runs). */
export function adoptedHeld(a: AdoptedRun): Held {
  return {
    cardId: a.card.nodeId, cardName: a.cardMeta?.name ?? a.card.nodeId, ...(a.cardMeta?.sectorName ? { sectorName: a.cardMeta.sectorName } : {}),
    group: a.cardMeta?.group ?? 'dev', workerId: a.worker.id, workerName: a.worker.name, deskId: a.worker.deskId, by: 'restart', startedAt: Date.now(), state: 'working',
    workspace: a.card.workspace, ...(a.lease ? { token: a.lease.token, owner: a.lease.agent } : {}), snapshot: { runId: a.runId, digest: a.digest },
  };
}

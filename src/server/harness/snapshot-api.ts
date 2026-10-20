// The worker's lazy read: GET /office/harness?worker=ID&read=ELEMENT[&run=RUN] with the hook bearer
// token (hooks/server.ts → api.ts officeHarness). A worker reads only the snapshot of the run it was
// seated with (the bridge's record of its card, never the request), only elements that snapshot
// holds, and always the snapshot's text; the reply says whether the library has changed since.
import type http from 'node:http';
import type { Ctx } from '../office/context.js';
import type { Floor } from '../floor.js';
import { send } from '../http/util.js';
import { HarnessError } from './profiles.js';
import { HarnessLibrary, harnessSources } from './catalog.js';
import { HarnessRegistry } from './registry.js';
import { loadSnapshot, readFromSnapshot, type SnapshotRead } from './snapshot.js';
import type { RunRef } from '../opora/bridge.js';

/**
 * One element of the worker's own run snapshot. `own` is the run the office seated the worker with;
 * `run`, when given, must be that run (403 otherwise: another worker's run is never readable). The
 * snapshot must load whole and match the digest the office recorded at seating (409 otherwise). The
 * library is listed only to say whether the element changed since; it never supplies the text.
 */
export async function snapshotRead(dataDir: string, floorDir: string, own: RunRef | undefined, id: string, run: string): Promise<SnapshotRead> {
  if (!id) throw new HarnessError('--read takes an element id from your run contract.', 400);
  if (!own) throw new HarnessError('This worker has no run snapshot: it was not seated from an Opora card (or its card is finished). Use office-harness --effective for the profile.', 404);
  if (run && run !== own.runId) throw new HarnessError(`Run ${run} is not this worker's run; a worker reads only the snapshot it was seated with (${own.runId}).`, 403);
  const snapshot = loadSnapshot(dataDir, own.runId);
  if (snapshot.digest !== own.digest) throw new HarnessError(`Run snapshot ${own.runId} does not match the digest recorded when the worker was seated; it is refused, not served.`, 409);
  if (!snapshot.elements.some((e) => e.id === id)) return readFromSnapshot(snapshot, id);
  let current: { version: number; digest: string } | undefined;
  try {
    const library = new HarnessLibrary(harnessSources(floorDir, true), new HarnessRegistry(dataDir));
    await library.list();
    const found = library.resolve(id);
    if (found.status === 'available') current = { version: found.entry.version, digest: found.entry.digest };
  } catch { /* the library can't be listed now: the element reads as no longer available, and the snapshot's text still comes back */ }
  return readFromSnapshot(snapshot, id, current);
}

/** The HTTP side of snapshotRead for an authenticated worker of `floor`. */
export async function officeSnapshotRead(ctx: Ctx, floor: Floor, workerId: string, res: http.ServerResponse, url: URL) {
  try {
    send(res, 200, await snapshotRead(ctx.cfg.dataDir, floor.dir, floor.opora.snapshotOf(workerId), url.searchParams.get('read') ?? '', url.searchParams.get('run') ?? ''));
  } catch (err) {
    send(res, err instanceof HarnessError ? err.status : 500, { error: (err as Error).message });
  }
}

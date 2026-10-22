// Small adapters the Opora machinery's taps call, so each tap stays one line in its own module.
import { emitProcess } from './hub.js';
import { upkeepEvents } from './opora-events.js';

/** What an upkeep pass did, for the floor's journal; the guard only when its verdict for a head changes. */
export function upkeepTap(floorId: string) {
  let lastGuard: string | undefined;
  return (pass: Parameters<typeof upkeepEvents>[0]) => {
    for (const e of upkeepEvents(pass, lastGuard)) emitProcess(floorId, e);
    if (pass.guard) lastGuard = `${pass.guard.state}@${pass.guard.head}`;
  };
}

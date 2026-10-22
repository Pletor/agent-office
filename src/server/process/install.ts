// Puts the process journal into the office: the hub finds the building's floors, every new event goes
// to the browsers on its floor at once, and (unless AGENT_OFFICE_PROCESS_PUSH=0) to the floor's Opora;
// and each floor linked to an Opora project follows Opora's event stream into its journal (unless
// AGENT_OFFICE_PROCESS_PUSH=0 or AGENT_OFFICE_OPORA_STREAM=0).

import type { ServerMsg } from '../../shared/protocol.js';
import type { Floor } from '../floor.js';
import { processHub } from './hub.js';
import { forgetObserved, observeProcess } from './observe.js';
import { ProcessPushers } from './push.js';
import { OporaStreams } from './opora-stream.js';

interface ProcessOffice {
  floors: Map<string, Floor>;
  toFloor(floor: Floor, msg: ServerMsg, droppable?: boolean): void;
}

let pushers: ProcessPushers | undefined;
let off: (() => void) | undefined;
let streams: OporaStreams | undefined;
let sweep: NodeJS.Timeout | undefined;

/** Stops every floor's Opora event stream (the office is closing). */
export function stopProcessStreams() {
  clearInterval(sweep);
  streams?.stopAll();
}

/** Drops everything kept for floors that are gone. */
export function sweepFloors(office: Pick<ProcessOffice, 'floors'>, live?: OporaStreams, hub = processHub) {
  live?.retain((id) => office.floors.has(id));
  for (const id of hub.journalIds()) {
    if (office.floors.has(id)) continue;
    hub.forget(id);
    forgetObserved(id);
  }
}

/** Wires the hub up once; hands back the floor outlet that also feeds the journal. */
export function installProcess(office: ProcessOffice, env: NodeJS.ProcessEnv = process.env) {
  processHub.floors = (id) => office.floors.get(id);
  pushers?.stop();
  pushers = env.AGENT_OFFICE_PROCESS_PUSH === '0' ? undefined : new ProcessPushers();
  const push = pushers;
  stopProcessStreams();
  streams = env.AGENT_OFFICE_PROCESS_PUSH === '0' || env.AGENT_OFFICE_OPORA_STREAM === '0' ? undefined
    : new OporaStreams(processHub, (floorId, stream) => {
      const floor = office.floors.get(floorId);
      if (floor) office.toFloor(floor, { t: 'process.stream', ...(stream ? { stream } : {}) });
    });
  const live = streams;
  // A floor taken off the building takes its stream, journal and baseline with it, so a floor id made again starts fresh.
  sweep = setInterval(() => sweepFloors(office, live), 15_000);
  sweep.unref?.();
  off?.();
  off = processHub.onEvent((floorId, event) => {
    const floor = office.floors.get(floorId);
    if (!floor) return;
    // Droppable: a browser too far behind skips events and catches up with process.since.
    office.toFloor(floor, { t: 'process.event', event }, true);
    if (push) {
      let base: string | undefined;
      try {
        base = floor.opora.view().url;
      } catch {
        base = undefined;
      }
      push.add(base, event);
    }
  });
  return (floor: Floor, msg: ServerMsg, droppable?: boolean) => {
    office.toFloor(floor, msg, droppable);
    if (msg.t === 'opora') live?.sync(floor.id, msg.state);
    observeProcess(floor, msg);
  };
}

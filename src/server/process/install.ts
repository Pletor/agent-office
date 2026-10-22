// Puts the process journal into the office: the hub finds the building's floors, every new event goes
// to the browsers on its floor at once, and (unless AGENT_OFFICE_PROCESS_PUSH=0) to the floor's Opora.

import type { ServerMsg } from '../../shared/protocol.js';
import type { Floor } from '../floor.js';
import { processHub } from './hub.js';
import { observeProcess } from './observe.js';
import { ProcessPushers } from './push.js';

interface ProcessOffice {
  floors: Map<string, Floor>;
  toFloor(floor: Floor, msg: ServerMsg, droppable?: boolean): void;
}

let pushers: ProcessPushers | undefined;
let off: (() => void) | undefined;

/** Wires the hub up once; hands back the floor outlet that also feeds the journal. */
export function installProcess(office: ProcessOffice, env: NodeJS.ProcessEnv = process.env) {
  processHub.floors = (id) => office.floors.get(id);
  pushers?.stop();
  pushers = env.AGENT_OFFICE_PROCESS_PUSH === '0' ? undefined : new ProcessPushers();
  const push = pushers;
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
    observeProcess(floor, msg);
  };
}

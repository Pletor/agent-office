import type { PlanningState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** The planning room: the plan on the board, and the ones before. */
    planning: PlanningState;
  }
  interface Topics {
    planning: true;
  }
}

export const planning: Slice = {
  init(s) {
    s.planning = { current: null, past: [] };
  },
  on: {
    planning(s, m) {
      s.planning = m.state;
      return ['planning'];
    },
  },
  enter(s, v) {
    s.planning = v.planning;
    return ['planning'];
  },
};

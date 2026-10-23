import type { OrchestratorState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** The card picked for the orchestrator at the Opora Control Center's right board, and the overview its planner gets. */
    orchestrator: OrchestratorState;
  }
  interface Topics {
    orchestrator: true;
  }
}

export const orchestrator: Slice = {
  init(s) {
    s.orchestrator = { focus: null, brief: null };
  },
  on: {
    orchestrator(s, m) {
      s.orchestrator = m.state;
      return ['orchestrator'];
    },
  },
  enter(s, v) {
    s.orchestrator = v.orchestrator ?? { focus: null, brief: null };
    return ['orchestrator'];
  },
};

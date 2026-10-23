import type { SessionsState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** The floor's sessions for the planning room's third screen: checklists, sub-sessions, context, what they ask. */
    sessions: SessionsState;
  }
  interface Topics {
    sessions: true;
  }
}

export const sessions: Slice = {
  init(s) {
    s.sessions = { sessions: [], at: 0 };
  },
  on: {
    sessions(s, m) {
      s.sessions = m.state;
      return ['sessions'];
    },
  },
  enter(s, v) {
    s.sessions = v.sessions ?? { sessions: [], at: 0 };
    return ['sessions'];
  },
};

import type { ReaState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** Which workers get 🔬 REA's MCP server (⚙️ Settings); null until the server has said. */
    rea: ReaState | null;
  }
  interface Topics {
    rea: true;
  }
}

export const rea: Slice = {
  init(s) {
    s.rea = null;
  },
  on: {
    rea(s, m) {
      s.rea = m.state;
      return ['rea'];
    },
  },
};

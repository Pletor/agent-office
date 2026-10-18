import type { StatusState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** 🚦 The status wall: the office and Opora, each with its light and reasons; null until the server has said. */
    status: StatusState | null;
  }
  interface Topics {
    status: true;
  }
}

export const status: Slice = {
  init(s) {
    s.status = null;
  },
  on: {
    status(s, m) {
      s.status = m.state;
      return ['status'];
    },
  },
};

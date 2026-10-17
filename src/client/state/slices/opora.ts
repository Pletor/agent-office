import { EMPTY_OPORA } from '../../../shared/opora';
import type { OporaState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** The link to Opora Canvas: its cards, and the ones the office is carrying out. */
    opora: OporaState;
  }
  interface Topics {
    opora: true;
  }
}

export const opora: Slice = {
  init(s) {
    s.opora = EMPTY_OPORA;
  },
  on: {
    opora(s, m) {
      s.opora = m.state;
      return ['opora'];
    },
  },
  enter(s, v) {
    s.opora = v.opora;
    return ['opora'];
  },
};

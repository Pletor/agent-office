// 🚦 The status wall: its state for a page that asks, and a check now when its window opens (see status/).
import { statusWall } from '../../status/index.js';
import type { StatusClientMsg } from '../../../shared/protocol.js';
import type { HandlerMap } from './types.js';

export const statusHandlers = {
  'status.get'(ctx, c) {
    const wall = statusWall();
    if (wall) ctx.sendTo(c, { t: 'status', state: wall.state });
  },
  'status.refresh'() {
    // Everyone gets the result: the wall is the same on every floor.
    void statusWall()?.refreshSoon();
  },
} satisfies HandlerMap<StatusClientMsg>;

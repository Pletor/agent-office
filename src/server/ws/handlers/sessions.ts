// The planning room's third screen: putting a worker's session on an Opora card by hand, or taking it off.
import type { SessionsClientMsg } from '../../../shared/protocol.js';
import { here } from './common.js';
import type { HandlerMap, ViewPieces } from './types.js';

export const sessionsView: ViewPieces['sessions'] = (_ctx, floor) => floor?.sessions.state() ?? { sessions: [], at: 0 };

export const sessionsHandlers = {
  'sessions.assign'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor || typeof msg.workerId !== 'string') return;
    const card = msg.cardId === null ? null : typeof msg.cardId === 'string' ? msg.cardId : undefined;
    if (card === undefined) return;
    ctx.warn(c, floor.sessions.assign(msg.workerId, card, c.peer.name));
  },
} satisfies HandlerMap<SessionsClientMsg>;

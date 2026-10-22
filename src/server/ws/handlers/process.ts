// The floor's live process journal: catching up from a seq, and what someone arriving is handed.
import type { ProcessClientMsg } from '../../../shared/protocol.js';
import { processHub } from '../../process/hub.js';
import type { HandlerMap, ViewPieces } from './types.js';

export const processView: ViewPieces['process'] = (_ctx, floor) => (floor ? processHub.snapshot(floor.id) : { events: [], seq: 0 });

export const processHandlers = {
  'process.since'(ctx, c, msg) {
    const floor = ctx.floorOf(c);
    if (!floor) return;
    const seq = typeof msg.seq === 'number' && Number.isSafeInteger(msg.seq) && msg.seq >= 0 ? msg.seq : 0;
    ctx.sendTo(c, { t: 'process.snapshot', ...processHub.snapshot(floor.id, seq) });
  },
} satisfies HandlerMap<ProcessClientMsg>;

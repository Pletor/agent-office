// The orchestrator's focused card: picking it at the Opora Control Center's right board, or letting go.
import type { OrchestratorClientMsg } from '../../../shared/protocol.js';
import { here } from './common.js';
import type { HandlerMap, ViewPieces } from './types.js';

export const orchestratorView: ViewPieces['orchestrator'] = (_ctx, floor) => floor?.orchestrator.state() ?? { focus: null, brief: null };

export const orchestratorHandlers = {
  'orchestrator.focus'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    const id = msg.cardId === null ? null : typeof msg.cardId === 'string' ? msg.cardId.slice(0, 200) : '';
    ctx.warn(c, floor.orchestrator.set(id, c.peer.name));
  },
} satisfies HandlerMap<OrchestratorClientMsg>;

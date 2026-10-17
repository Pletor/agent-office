// The bridge to Opora Canvas: reading the canvas again, taking a card, the autopilot, linking the floor to a project, and starting Opora.
import type { OporaClientMsg } from '../../../shared/protocol.js';
import { EMPTY_OPORA } from '../../../shared/opora.js';
import { str } from '../../office/input.js';
import { oporaProcess } from '../../opora/process.js';
import { here } from './common.js';
import type { HandlerMap, ViewPieces } from './types.js';

export const oporaView: ViewPieces['opora'] = (_ctx, floor) => floor?.opora.view() ?? EMPTY_OPORA;

export const oporaHandlers = {
  'opora.refresh'(ctx, c) {
    void here(ctx, c)?.opora.poll();
  },
  'opora.take'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    // Its worker runs on the sign-ins of whoever took the card.
    ctx.withSignIn(c, ctx.claudeFor(floor.workers.officeDefault.provider), () => {
      void floor.opora.take(str(msg.cardId, 64), c.peer.name, c.accountId).then((err) => ctx.warn(c, err));
    });
  },
  'opora.autopilot'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    const max = typeof msg.maxRuns === 'number' ? msg.maxRuns : undefined;
    if (msg.on !== true) return floor.opora.setAutopilot(false, max, c.peer.name);
    // The cards it takes run on the sign-ins of whoever put it on.
    ctx.withSignIn(c, ctx.claudeFor(floor.workers.officeDefault.provider), () => floor.opora.setAutopilot(true, max, c.peer.name, c.accountId));
  },
  'opora.link'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    const id = msg.projectId;
    if (id !== null && (typeof id !== 'string' || !id || id.length > 64)) return ctx.warn(c, 'That isn’t an Opora project');
    const err = floor.opora.link(id);
    if (err) return ctx.warn(c, err);
    const name = id === null ? 'the Opora project for its folder' : (floor.opora.view().projects.find((p) => p.id === id)?.name ?? id);
    ctx.toastFloor(floor, `🛰️ ${c.peer.name} linked this floor to ${name}`);
    void floor.opora.repoll();
  },
  'opora.start'(ctx, c) {
    const floor = here(ctx, c);
    if (!floor) return;
    if (!ctx.meOf(c.accountId).admin) return ctx.warn(c, 'Only admins can start Opora');
    const ready = () =>
      fetch(new URL('/api/health', floor.opora.view().url), { signal: AbortSignal.timeout(3000) }).then(
        (r) => r.ok,
        () => false,
      );
    ctx.toastFloor(floor, `🛰️ ${c.peer.name} is starting Opora…`);
    void oporaProcess.start(ready).then((err) => {
      if (err) ctx.warn(c, err);
      else ctx.toastFloor(floor, '🛰️ Opora is up');
      void floor.opora.poll();
    });
    void floor.opora.poll();
  },
} satisfies HandlerMap<OporaClientMsg>;

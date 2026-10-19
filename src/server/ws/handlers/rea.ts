// 🔬 REA in ⚙️ Settings: which workers get its MCP server (admins only), the same on every floor (see rea/).
import { isReaMode, reaPackage, reaSetting } from '../../rea/index.js';
import type { ReaClientMsg, ReaMode } from '../../../shared/protocol.js';
import type { HandlerMap } from './types.js';

const SAID: Record<ReaMode, string> = {
  off: 'turned 🔬 REA off: no worker gets it',
  opora: 'gave 🔬 REA to the workers working for Opora (its cards and its planner)',
  all: 'gave 🔬 REA to every worker the office starts',
};

export const reaHandlers = {
  'rea.get'(ctx, c) {
    ctx.sendTo(c, { t: 'rea', state: reaSetting()?.state() ?? { mode: 'off', package: reaPackage() } });
  },
  'rea.set'(ctx, c, msg) {
    const who = c.peer.name;
    if (!ctx.meOf(c.accountId).admin) return ctx.warn(c, 'Only admins can change who gets REA');
    const s = reaSetting();
    if (!s || !isReaMode(msg.mode) || msg.mode === s.mode) return;
    const err = s.set(msg.mode, who);
    if (err) return ctx.warn(c, err);
    ctx.toastAll(`⚙️ ${who} ${SAID[msg.mode]}. It applies from each worker's next start.`);
  },
} satisfies HandlerMap<ReaClientMsg>;

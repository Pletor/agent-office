// Droppable process.event frames can be lost on a slow connection. This notices a hole in the
// journal's seq (or a reconnect) and asks the server for what came after, once, not per event.

import type { Ctx } from '../../core/context';
import { store } from '../../state';

/** How long one request for missed events stays outstanding before another may go out. */
export const CATCHUP_RETRY_MS = 3000;

export interface CatchUp {
  /** A process.event is about to be applied: ask for the missed ones if its seq skips ahead. */
  onEvent(seq: number): void;
  /** The snapshot (the answer) arrived. */
  answered(): void;
  /** The socket came back. */
  reconnected(): void;
}

export function makeCatchUp(deps: { seq(): number; ready(): boolean; send(seq: number): void; now(): number }): CatchUp {
  let askedAt = -Infinity;
  const ask = () => {
    const now = deps.now();
    if (now - askedAt < CATCHUP_RETRY_MS) return;
    askedAt = now;
    deps.send(deps.seq());
  };
  return {
    onEvent(seq) {
      if (deps.ready() && seq > deps.seq() + 1) ask();
    },
    answered() {
      askedAt = -Infinity;
    },
    reconnected() {
      askedAt = -Infinity;
      if (deps.ready()) ask();
    },
  };
}

export function watchProcessGaps(ctx: Ctx) {
  const c = makeCatchUp({
    seq: () => store.process.seq,
    ready: () => store.process.connected,
    send: (seq) => ctx.net.send({ t: 'process.since', seq }),
    now: () => Date.now(),
  });
  ctx.messages.on('process.event', (m) => c.onEvent(m.event.seq), 'before');
  ctx.messages.on('process.snapshot', () => c.answered());
  let was = ctx.net.up;
  ctx.net.onStatus((up) => {
    if (up && !was) c.reconnected();
    was = up;
  });
}

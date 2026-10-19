import type { Ctx } from '../../core/context';
import { hintTitle, aside, key, onE } from '../../core/hint';
import { store } from '../../state';
import { toast } from '../../ui/dom';
import { openHarness } from './ui';

declare module '../../world/types' {
  interface InteractKinds {
    harness: true;
  }
}
export function installHarness(ctx: Ctx) {
  ctx.interactions.define('harness', {
    reach: 4,
    hint: () => ({ k: 'harness', parts: [hintTitle('📚 Harness'), aside('Instructions · tools · memory'), key('E', 'Open library')] }),
    use: onE(() => store.floor ? openHarness(store.floor) : toast('Take the elevator to a floor first')),
  });
}

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
  const show = () => { if (store.floor) openHarness(store.floor); else toast('Take the elevator to a floor first'); };
  ctx.keys.bind({ code: 'F8', repeat: false, preventDefault: true, run: show });
  ctx.interactions.define('harness', {
    reach: 4,
    hint: () => ({ k: 'harness', parts: [hintTitle('📚 Harness'), aside('Instructions · tools · memory'), key('E', 'Open library')] }),
    use: onE(show),
  });
}

import type { Ctx } from '../../core/context';
import { h, modalOpen } from '../../ui/dom';
import { openGenerals } from './ui';

/** The boss's existing PC gets an online game without taking over its other apps. */
export function installGenerals(ctx: Ctx) {
  const seated = () => ctx.player.seat?.seatId === 'boss-chair';
  const launcher = h('button.btn.generals-launch.hidden', { type: 'button', onclick: () => openGenerals() }, 'J · Play generals.io');
  document.body.append(launcher);
  ctx.ticks.add('hud', () => launcher.classList.toggle('hidden', !seated() || modalOpen()));
  ctx.keys.bind({ code: 'KeyJ', when: seated, repeat: false, preventDefault: true, run: () => { openGenerals(); } });
}

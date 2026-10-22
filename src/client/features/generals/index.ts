import type { Ctx } from '../../core/context';
import { $, h, modalOpen } from '../../ui/dom';
import { openGenerals } from './ui';

/** The boss's existing PC gets an online game without taking over its other apps. */
export function installGenerals(ctx: Ctx) {
  const seated = () => ctx.player.seat?.seatId === 'boss-chair';
  const launcher = h('button.btn.generals-launch.hidden', { type: 'button', onclick: () => openGenerals() },
    h('kbd', {}, 'J'), h('span', {}, 'Play generals.io'));
  const hint = $('hint');
  document.body.append(launcher);
  ctx.ticks.add('hud', () => {
    const visible = seated() && !modalOpen();
    launcher.classList.toggle('hidden', !visible);
    if (!visible) return;
    // The hint wraps on small windows and moves above the mobile controls.
    const bottom = hint.classList.contains('hidden') ? 110 : innerHeight - hint.getBoundingClientRect().top + 12;
    const offset = `${Math.ceil(bottom)}px`;
    if (launcher.style.bottom !== offset) launcher.style.bottom = offset;
  });
  ctx.keys.bind({ code: 'KeyJ', when: seated, repeat: false, preventDefault: true, run: () => { openGenerals(); } });
}

import type { Ctx } from '../../core/context';
import { $, h, modalOpen } from '../../ui/dom';
import { openGenerals } from './ui';

/** The boss's existing PC gets an online game without taking over its other apps. */
export function installGenerals(ctx: Ctx, deps: { openWork(): void }) {
  const accessible = () => {
    const chair = ctx.plan().seatingById.get('boss-chair');
    const p = ctx.player.pos;
    return !!chair && Math.abs(p.y - chair.y) < 0.8 && Math.hypot(p.x - chair.x, p.z - chair.z) <= 3;
  };
  const launcher = h('div.boss-pc-launcher.hidden', { role: 'group', 'aria-label': 'Boss PC — personal apps' },
    h('button.btn.generals-launch', { type: 'button', onclick: () => { if (accessible()) openGenerals(); } },
      h('kbd', {}, 'J'), h('span', {}, 'Play generals.io')),
    h('button.btn.boss-pc-work', { type: 'button', onclick: () => { if (accessible()) deps.openWork(); } },
      h('kbd', {}, 'O'), h('span', {}, 'Open Opora')));
  const hint = $('hint');
  document.body.append(launcher);
  ctx.ticks.add('hud', () => {
    const visible = accessible() && !modalOpen();
    launcher.classList.toggle('hidden', !visible);
    if (!visible) return;
    // The hint wraps on small windows and moves above the mobile controls.
    const bottom = hint.classList.contains('hidden') ? 110 : innerHeight - hint.getBoundingClientRect().top + 12;
    const offset = `${Math.ceil(bottom)}px`;
    if (launcher.style.bottom !== offset) launcher.style.bottom = offset;
  });
  ctx.keys.bind({ code: 'KeyJ', when: accessible, repeat: false, preventDefault: true, run: () => { openGenerals(); } });
  // O belongs to the nearby PC even when another visitor has its chair.
  // Outside this area, let the usual desk interaction keep the key.
  ctx.keys.add('activity', e => {
    if (e.code !== 'KeyO' || !accessible()) return false;
    e.preventDefault();
    if (!e.repeat) deps.openWork();
    return true;
  });
}

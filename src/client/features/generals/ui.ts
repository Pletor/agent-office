import { h, openModal, type Modal } from '../../ui/dom';
import './ui.css';

const URL = 'https://generals.io/';
let active: Modal | undefined;

export function openGenerals(): Modal {
  if (active) return active;
  let wasFullscreen = false;
  const frame = h('iframe', { src: URL, title: 'generals.io online game', allow: 'fullscreen', referrerpolicy: 'no-referrer' });
  const status = h('p.generals-status', {}, 'Online game · Click the game to play. Esc in this bar closes it; inside the game use ✕. Closing leaves the game.');
  const expand = h('button.btn', { type: 'button', onclick: () => {
    if (!el.requestFullscreen) {
      el.classList.toggle('generals-expanded');
      return;
    }
    void el.requestFullscreen().then(() => { wasFullscreen = true; }).catch(() => {
      el.classList.add('generals-expanded');
      status.textContent = 'Expanded to this window. Browser fullscreen is unavailable; use ✕ to return to the office.';
    });
  } }, '⛶ Full screen');
  const el = h('section.modal.generals', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'generals.io — Boss PC' },
    h('header', {}, h('h2', {}, 'generals.io'), expand,
      h('a.btn', { href: URL, target: '_blank', rel: 'noopener noreferrer' }, '↗ Open in a tab')),
    status, frame,
    h('p.generals-fallback', {}, 'Game not loading? Check your connection or use Open in a tab. ',
      h('a', { href: '/userscripts/generals-hide-ads.user.js', download: 'generals-hide-ads.user.js', title: 'Install in Tampermonkey, then reopen the game. Hides containers; does not block ad requests.' }, 'Hide ad containers (userscript)')));
  const fullscreenChanged = () => {
    if (document.fullscreenElement === el) wasFullscreen = true;
    else if (wasFullscreen) active?.close();
  };
  document.addEventListener('fullscreenchange', fullscreenChanged);
  active = openModal(el, { backdropCloses: false, doing: 'playing generals.io', onClose: () => {
    document.removeEventListener('fullscreenchange', fullscreenChanged);
    if (document.fullscreenElement === el) void document.exitFullscreen().catch(() => {});
    frame.src = 'about:blank';
    active = undefined;
  } });
  expand.focus();
  return active;
}

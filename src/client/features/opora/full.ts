import './full.css';
import { OPORA_ESCAPE_WINDOW_MS, OPORA_TAB, browserOporaUrl, oporaCanvasUrl, oporaEscapeLeaves } from '../../../shared/opora';
import type { OporaState } from '../../../shared/protocol';
import { h, openModal, type Modal } from '../../ui/dom';

/** The floor's Opora canvas as this page's browser reaches it (see browserOporaUrl). */
export function oporaPageUrl(s: Pick<OporaState, 'url' | 'project' | 'workspace'>): string {
  return browserOporaUrl(oporaCanvasUrl(s), location.hostname);
}

/** Opora in its own browser tab (the same one each time, by name). Call it straight from a key or a click, or the browser blocks it. */
export function openOporaTab(s: Pick<OporaState, 'url' | 'project' | 'workspace'>) {
  window.open(oporaPageUrl(s), OPORA_TAB)?.focus();
}

/**
 * Opora on the whole screen, inside the office: the real Opora Canvas in a frame over everything,
 * on the floor's linked project, working just as it does in a tab of its own. A slim bar over it has
 * the project, ↗ to take it to a tab instead, and ✕. Esc in the office's bar here closes it at once.
 * Inside Opora, which tells the page it's framed in (`opora:escape`), it takes Esc twice in a row, as
 * Opora's own panels close on Esc too: the first shows "Esc again to leave Opora" in the bar. Only a
 * message from Opora's own frame counts. The frame goes with the window, so each open loads it afresh.
 */
export function openOporaFull(s: Pick<OporaState, 'url' | 'project' | 'workspace'>): Modal {
  const src = oporaPageUrl(s);
  const origin = new URL(src).origin;
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
  const tab = h('button.btn.small', { type: 'button', title: `Open Opora (${src}) in a tab of its own instead` }, '↗ Open in a tab');
  // The office's pages send no referrer; the frame sends Opora the office's origin, which is where
  // Opora addresses its `opora:escape` to (it reads it from document.referrer).
  const frame = h('iframe.opora-frame', { src, title: 'Opora Canvas', allow: 'clipboard-read; clipboard-write; fullscreen', allowfullscreen: true, referrerpolicy: 'origin' }) as HTMLIFrameElement;
  const again = h('span.opora-esc-again', { role: 'status', 'aria-live': 'polite' }, 'Esc again to leave Opora');
  const el = h('div.modal.opora-full', { role: 'dialog', 'aria-label': 'Opora Canvas' }, h('header', {}, h('h2', {}, s.project ? `🛰️ Opora · ${s.project.name}` : '🛰️ Opora'), again, tab, close), frame);
  let lastEscape: number | undefined;
  let hideAgain: ReturnType<typeof setTimeout> | undefined;
  const onMessage = (e: MessageEvent) => {
    if (e.origin !== origin || e.source !== frame.contentWindow) return;
    if ((e.data as { type?: unknown } | null)?.type !== 'opora:escape') return;
    const now = performance.now();
    if (oporaEscapeLeaves(lastEscape, now)) return modal.close();
    lastEscape = now;
    again.classList.add('shown');
    clearTimeout(hideAgain);
    hideAgain = setTimeout(() => again.classList.remove('shown'), OPORA_ESCAPE_WINDOW_MS);
  };
  window.addEventListener('message', onMessage);
  const modal = openModal(el, {
    doing: '🛰️ in Opora',
    backdropCloses: false,
    onClose: () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(hideAgain);
      frame.remove();
    },
  });
  modal.backdrop.classList.add('opora-full-backdrop');
  close.addEventListener('click', () => modal.close());
  tab.addEventListener('click', () => {
    modal.close();
    openOporaTab(s);
  });
  // Opora has the keyboard as soon as it's there, as it would in a tab.
  frame.addEventListener('load', () => frame.focus());
  return modal;
}

// The Výstupy window's pictures, shared by the list and the diary: a picture from a trusted host you can
// click to see large, any other address only as a link (never an <img>), and "Před" and "Po" side by
// side with a switch (vedle sebe · před · po). Rules: docs/vystupy-board.md.

import type { OutputMedia, PrOutputs } from '../../../shared/outputs';
import { h, openModal } from '../../ui/dom';

export const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const link = (url: string, text: string, cls = 'vo-link') => h(`a.${cls}` as 'a.x', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text);

/** A picture, large, over the window. */
function zoom(m: OutputMedia, label: string) {
  const img = h('img.vo-zoom-img', { src: m.url, alt: label, referrerpolicy: 'no-referrer' });
  openModal(h('section.vo-zoom', { role: 'dialog', 'aria-modal': 'true', 'aria-label': label }, h('header.vo-zoom-h', {}, h('b', {}, label), link(m.url, 'otevřít originál')), img), { doing: '🗂️ prohlíží výstup' });
}

/** A picture you can click to see large, or (another host, or not written as a picture) just its link. */
export function media(m: OutputMedia, label: string): HTMLElement {
  if (!m.image) return h('div.vo-media.vo-media--link', {}, h('span.vo-k', {}, label), link(m.url, m.url));
  return h('figure.vo-media', {},
    h('button.vo-shot', { type: 'button', title: `${label}: zvětšit`, onclick: () => zoom(m, label) }, h('img', { src: m.url, alt: label, loading: 'lazy', referrerpolicy: 'no-referrer' })),
    h('figcaption', {}, label));
}

type Compare = 'both' | 'before' | 'after';

export function beforeAfter(o: PrOutputs, n: number): HTMLElement | undefined {
  if (!o.before && !o.after) return undefined;
  let mode: Compare = 'both';
  const stage = h('div.vo-ba');
  const buttons = new Map<Compare, HTMLButtonElement>();
  const draw = () => {
    for (const [id, b] of buttons) b.classList.toggle('on', id === mode);
    const parts = [mode !== 'after' && o.before ? media(o.before, `Před · #${n}`) : null, mode !== 'before' && o.after ? media(o.after, `Po · #${n}`) : null].filter((x): x is HTMLElement => !!x);
    stage.classList.toggle('vo-ba--one', parts.length < 2);
    stage.replaceChildren(...(parts.length ? parts : [h('p.vo-none', {}, mode === 'before' ? 'Snímek „před“ chybí.' : 'Snímek „po“ chybí.')]));
  };
  const sw = h('div.vo-switch', { role: 'group', 'aria-label': 'Před a po' });
  for (const [id, label] of [['both', 'vedle sebe'], ['before', 'před'], ['after', 'po']] as [Compare, string][]) {
    const b = h('button.vo-sw', { type: 'button', onclick: () => { mode = id; draw(); } }, label) as HTMLButtonElement;
    buttons.set(id, b);
    sw.append(b);
  }
  draw();
  return h('div.vo-block', {}, h('div.vo-block-h', {}, h('span.vo-k', {}, 'Před / Po'), sw), stage);
}

/** Artifact links, as buttons. */
export const artifacts = (urls: readonly string[]) =>
  h('div.vo-block', {}, h('span.vo-k', {}, 'Artefakt'), h('div.vo-arts', {}, ...urls.map((u, i) => link(u, urls.length > 1 ? `🔗 artefakt ${i + 1}` : '🔗 otevřít artefakt', 'vo-art'))));

/** Diagrams and animations. */
export const diagrams = (list: readonly OutputMedia[], n: number) =>
  h('div.vo-block', {}, h('span.vo-k', {}, 'Diagram / animace'), h('div.vo-diagrams', {}, ...list.map((d, i) => media(d, list.length > 1 ? `Diagram ${i + 1} · #${n}` : `Diagram · #${n}`))));

/** The PR's explanation, as plain text. */
export const explanation = (text: string) => h('p.vo-why', {}, text);

// A Lens card's popover (features/lens/diagram.ts): its kind and state, summary, files with line
// ranges, and the edges in and out (each one jumps to the card at its other end). A ✕ in the top
// right; Esc is handled by the diagram so it closes only this. All spec text goes in as text.

import { h } from '../../ui/dom';
import type { LensNode } from '../../../shared/opora-lens';
import type { LayoutEdge } from './layout';
import { DELTA, deltaMark, planStatus, STATUS, type Mode } from './parts';

let seq = 0;

export interface PopoverArgs {
  n: LensNode;
  mode: Mode;
  ins: LayoutEdge[];
  outs: LayoutEdge[];
  name: (id: string) => string;
  go: (id: string) => void;
  close: () => void;
}

export function popover({ n, mode, ins, outs, name, go, close }: PopoverArgs): { el: HTMLElement; x: HTMLButtonElement } {
  const titleId = `lxp-${++seq}`;
  const link = (e: LayoutEdge, dir: 'in' | 'out') => {
    const other = dir === 'in' ? e.e.from : e.e.to;
    return h('li', {}, h('button', { type: 'button', onclick: () => go(other) },
      h('span.ar', { 'aria-hidden': 'true' }, dir === 'in' ? '←' : '→'), h('span.nm', {}, name(other)), e.e.label ? h('span.el', {}, e.e.label) : null));
  };
  const x = h('button.lx-btn.x', { type: 'button', 'aria-label': 'Zavřít', title: 'Zavřít (Esc)', onclick: close }, '✕');
  const el = h('div.lx-pop', { role: 'dialog', 'aria-labelledby': titleId },
    h('div.lx-pop-h', {}, deltaMark(n.delta), h('b', { id: titleId }, n.label)),
    x,
    h('div.lx-pop-meta', {}, h('span', {}, n.kind), '·', h('span', {}, mode === 'plan' ? STATUS[planStatus(n)] : DELTA[n.delta][1]), ...n.badges.map((b) => h('span.bd', {}, b))));
  if (n.summary) el.append(h('p', {}, n.summary));
  if (n.files.length) {
    el.append(h('div.k', {}, 'Soubory'), h('ul.lx-files', {}, ...n.files.map((f) => h('li', {}, h('code', {}, f.path), f.lines ? h('span.ln', {}, f.lines) : null))));
  }
  el.append(h('div.k', {}, `Vstupy · ${ins.length}`), ins.length ? h('ul.lx-links', {}, ...ins.map((e) => link(e, 'in'))) : h('span.pw-note', {}, 'žádné'));
  el.append(h('div.k', {}, `Výstupy · ${outs.length}`), outs.length ? h('ul.lx-links', {}, ...outs.map((e) => link(e, 'out'))) : h('span.pw-note', {}, 'žádné'));
  return { el, x };
}

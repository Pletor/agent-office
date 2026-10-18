import './ui.css';
import { ancestry, cleanFocus, focusLine, focusPaths, inFocus, SCOPE_LEVEL_NAME } from '../../../shared/opora-scope';
import type { OporaCard, OporaState } from '../../../shared/protocol';
import type { Net } from '../../net';
import { store } from '../../state';
import { h, openModal, type Modal } from '../../ui/dom';
import { scopeColumns } from './screen';

const CARD_WORDS: Record<OporaCard['status'], string> = {
  frontier: 'volná',
  claimed: 'v práci',
  blocked: 'blokovaná',
  waiting: 'čeká na člověka',
  closed: 'hotová',
  needsRouting: 'bez pipeline',
};

/**
 * The 🎚️ switchboard's window: the project's architecture in cascading columns (environment →
 * domain → page → subpage), each with its switch. Switching a node on switches on everything above
 * it; off, everything under it. The deepest ones on are what the cell works on: its cards, its
 * autopilot and its planner stay inside them. A name opens its column without switching it.
 */
export function openScope(net: Net) {
  const close = h('button.btn.close', { 'aria-label': 'Zavřít' }, '✕');
  const body = h('div.body.scope-body');
  const el = h('div.modal.scope-window', { role: 'dialog', 'aria-label': 'Zaměření buňky' }, h('header', {}, h('h2', {}, '🎚️ Zaměření buňky · na čem se pracuje'), close), body);
  // The way down the columns being looked at: the first focus's until you open another.
  let open: string[] | undefined;
  // One switch at a time, applied on the server to the focus as it is then (see OporaBridge.switchFocus).
  const send = (id: string | null, on: boolean, only = false) => net.send({ t: 'opora.focus', id, on, only });
  const render = () => paint(store.opora, body, open, {
    send,
    open: (id) => {
      open = ancestry(store.opora.scope, id).reverse();
      render();
    },
  });
  const offs = [store.on('opora', render)];
  const modal: Modal = openModal(el, { doing: '🎚️ u přepínače zaměření', onClose: () => offs.forEach((off) => off()) });
  close.addEventListener('click', () => modal.close());
  render();
}

function paint(s: OporaState, body: HTMLElement, open: string[] | undefined, act: { send(id: string | null, on: boolean, only?: boolean): void; open(id: string): void }) {
  if (!s.scope.length) {
    body.replaceChildren(h('p.muted', {}, !s.connected ? 'Opora neběží: spusť ji v okně 🛰️ Opora.' : !s.project ? 'Patro ještě není propojené s projektem: vyber ho v okně 🛰️ Opora.' : 'Načítám architekturu projektu…'));
    return;
  }
  const focus = cleanFocus(s.scope, s.focus);
  const on = new Set(focus);
  const way = open ?? focusPaths(s.scope, focus)[0]?.map((n) => n.id) ?? [];
  const cards = new Map(s.cards.map((c) => [c.id, c]));
  const line = focusLine(s.scope, focus);
  const top = h(
    'div.scope-top',
    {},
    h('span', {}, h('b', {}, 'Pracuje se na: '), line || 'celém projektu'),
    h('button.btn.small', { type: 'button', disabled: !focus.length, title: 'Vypnout vše: buňka pracuje na celém projektu', onclick: () => act.send(null, false) }, '⟲ Celý projekt'),
  );
  const cols = scopeColumns(s.scope, focus, way).map((col) =>
    h(
      'div.scope-col',
      {},
      h('h3', {}, SCOPE_LEVEL_NAME[col.nodes[0].level]),
      ...col.nodes.map((n) => {
        const card = cards.get(n.id);
        const lit = on.has(n.id);
        const box = h('input', { type: 'checkbox', checked: lit, 'aria-label': `${n.name}: ${lit ? 'zapnuto' : 'vypnuto'}`, onchange: () => act.send(n.id, !lit) });
        return h(
          'div.scope-row',
          { class: [lit ? 'on' : '', way.includes(n.id) ? 'open' : '', !inFocus(s.scope, focus, n.id) ? 'out' : ''].filter(Boolean).join(' ') },
          h('label.scope-switch', {}, box, h('span.knob')),
          h('button.scope-name', { type: 'button', title: 'Ukázat, co je pod tím', onclick: () => act.open(n.id) }, n.name, n.host ? h('small', {}, n.host) : null),
          card ? h('span.scope-card', { class: card.status }, CARD_WORDS[card.status]) : null,
          h('button.btn.small.scope-only', { type: 'button', title: 'Izolovat: pracovat jen na tomhle', onclick: () => act.send(n.id, true, true) }, '◎'),
        );
      }),
    ),
  );
  body.replaceChildren(top, h('div.scope-cols', {}, ...cols), h('p.muted', {}, 'Zapnutím se zapne i vše nad tím, vypnutím i vše pod tím. Nejhlubší zapnuté je zaměření: buňka bere karty jen odtud a plánovač u stolu se drží jen jich. ◎ izoluje jediný prvek.'));
}

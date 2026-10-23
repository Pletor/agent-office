// The right board's window (E at the plate over the switchboard): every card of the floor's Opora project,
// searchable and grouped by area, as the "Lens plánu" tab lists them. Picking one makes it the card the
// orchestrator focuses on, for everyone in the room: the server keeps it and gives its planner the
// overview, shown here exactly as the planner gets it. The full detail is on the purple board.

import type { Net } from '../../net';
import { store } from '../../state';
import { h, openModal, type Modal } from '../../ui/dom';
import { groupCards, STATUS_CZ } from '../opora-plan/cards';
import { focusedCard } from './board';
import '../opora-plan/ui.css';

export function openPicker(net: Net, deps: { openDetail(): void }) {
  const search = h('input.pw-sel.op-q', { type: 'search', placeholder: 'Hledat kartu nebo oblast…', 'aria-label': 'Hledat kartu' }) as HTMLInputElement;
  const count = h('span.sub');
  const list = h('div.pw-scroll.op-list.oc-list');
  const side = h('div.oc-side');
  const el = h('section.pw-modal.oc-picker', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Karta pro orchestrátora' },
    h('header.pw-head', {}, h('h2', {}, '🎯 Karta pro orchestrátora · pravá tabule')),
    h('div.pw-body.oc-pick-body', {},
      h('section.pw-panel.op-cards', { 'aria-label': 'Karty projektu' }, h('div.pw-ph', {}, 'Karty projektu', count), h('div.pw-tools', {}, search), list),
      h('section.pw-panel.oc-now', { 'aria-label': 'Vybraná karta' }, h('div.pw-ph', {}, 'Jak karta funguje'), h('div.pw-scroll', {}, side))));
  let sig = '';

  const pick = (id: string | null) => net.send({ t: 'orchestrator.focus', cardId: id });

  function renderList() {
    const o = store.opora, focus = store.orchestrator.focus?.cardId, q = search.value;
    const next = JSON.stringify([q, focus, o.project?.id ?? null, o.connected, o.cards.map((c) => [c.id, c.name, c.sectorName, c.status])]);
    if (next === sig) return;
    sig = next;
    const groups = groupCards(o.cards, q);
    const shown = groups.reduce((n, g) => n + g.cards.length, 0);
    count.textContent = o.cards.length ? (q.trim() ? `${shown} z ${o.cards.length}` : `${o.cards.length} karet`) : '';
    const empty = !o.project ? `Patro není propojené s projektem Opory${o.error ? ` (${o.error})` : ''}: propoj ho v okně 🛰️ Opora.`
      : !o.cards.length ? (o.connected ? 'Projekt v Opoře zatím nemá žádné karty.' : `Opora nedostupná${o.error ? `: ${o.error}` : ''}. Karty teď nejdou načíst.`)
        : !groups.length ? 'Žádná karta neodpovídá hledání.' : '';
    if (empty) { list.replaceChildren(h('p.pw-empty', {}, empty)); return; }
    list.replaceChildren(...groups.map((g) => h('div.op-group', { role: 'group', 'aria-label': g.area },
      h('h4', {}, h('span', {}, g.area), h('span', {}, String(g.cards.length))),
      ...g.cards.map((c) => h('button', {
        type: 'button', class: `op-card${c.id === focus ? ' on' : ''}`, 'data-card': c.id, 'aria-pressed': String(c.id === focus),
        title: c.id === focus ? 'Tuhle kartu orchestrátor právě sleduje' : 'Vybrat pro orchestrátora', onclick: () => pick(c.id),
      }, h('span', { class: `op-dot s-${c.status}`, 'aria-hidden': 'true' }), h('span.nm', {}, c.name),
      c.group === 'design' || c.profile === 'design' ? h('span.op-live', { title: 'Karta je na design pipeline' }, 'design') : null,
      h('span.op-st', {}, STATUS_CZ[c.status] ?? c.status))))));
  }

  function renderSide() {
    const s = store.orchestrator, shown = focusedCard({ state: s, opora: store.opora });
    if (!shown) {
      side.replaceChildren(h('p.pw-empty', {}, 'Vyber vlevo kartu. Orchestrátor u stolu ji pak dostane do svého zadání jako přehled (data, ne pokyny), aby věděl, komu práci předat. Celý detail obou návrhů je na fialové tabuli.'));
      return;
    }
    const c = shown.card, run = c ? store.opora.runs.find((r) => r.cardId === c.id && r.state !== 'gone') : undefined;
    const facts: [string, string][] = [
      ['Oblast', c?.sectorName || 'bez oblasti'], ['Stav', c ? STATUS_CZ[c.status] ?? c.status : 'není na canvasu'],
      ['Pipeline', c?.profile ? `${c.profile}${c.stage ? ` · etapa ${c.stage}` : ''}` : 'bez pipeline'], ['Desky', c?.group === 'design' ? 'Design' : 'Vývoj'],
      ['Pracovník', run ? `${run.workerName ?? 'pracovník'} (${run.state === 'working' ? 'pracuje' : run.state === 'done' ? 'dokončil tah' : run.state})` : 'nikdo z kanceláře'],
      ['Vybral', `${s.focus!.by} · ${new Date(s.focus!.at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}`],
    ];
    side.replaceChildren(
      h('h3.oc-name', {}, shown.name),
      h('dl.oc-facts', {}, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      h('div.oc-acts', {},
        h('button.btn.small.primary', { type: 'button', onclick: () => deps.openDetail() }, '🔎 Detail na fialové tabuli'),
        h('button.btn.small', { type: 'button', onclick: () => pick(null) }, 'Zrušit výběr')),
      h('div.oc-k', {}, 'Co z toho vidí orchestrátor'),
      s.brief ? h('pre.oc-brief', { 'aria-label': 'Přehled pro orchestrátora' }, s.brief) : h('p.pw-note', {}, 'Kancelář čte Lens a náhled karty z Opory…'),
    );
  }

  const render = () => { renderList(); renderSide(); };
  search.addEventListener('input', renderList);
  const offs = [store.on('opora', render), store.on('orchestrator', render)];
  const modal: Modal = openModal(el, { doing: '🎯 vybírá kartu pro orchestrátora', onClose: () => offs.forEach((off) => off()) });
  render();
  search.focus();
  return modal;
}

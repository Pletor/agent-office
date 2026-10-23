// The window's "Lens plánu" tab: on the left every card of the floor's Opora project, searchable and
// grouped by area (from the store, which the office already keeps); on the right the project's plan
// Lens, or, for a picked card, the inspector's sections for it (its PR Lens, area map, area plan and,
// for a design card, Jak to bude vypadat), whether a worker runs it or not.

import { store } from '../../state';
import { h } from '../../ui/dom';
import { inspectorSections } from '../process-wall/inspector';
import type { PanelData, Tab } from '../process-wall/view';
import { cardLane, groupCards, STATUS_CZ } from './cards';
import { ProjectPlan } from './plan';
import './ui.css';

export class OporaPlanTab implements Tab {
  readonly root = h('div.op-tab');
  private search = h('input.pw-sel.op-q', { type: 'search', placeholder: 'Hledat kartu nebo oblast…', 'aria-label': 'Hledat kartu' });
  private count = h('span.sub');
  private list = h('div.pw-scroll.op-list');
  private title = h('span.op-title', {}, 'Plán projektu');
  private back = h('button.pw-btn.op-back', { type: 'button', hidden: true }, '← Plán projektu');
  private detail = h('div.pw-insp.op-detail');
  private scroller = h('div.pw-scroll', {}, this.detail);
  private plan = new ProjectPlan();
  private picked?: string;
  private data?: PanelData;
  private listSig = '';

  constructor() {
    this.search.addEventListener('input', () => this.renderList());
    this.back.addEventListener('click', () => this.pick(undefined));
    this.root.append(
      h('section.pw-panel.op-cards', { 'aria-label': 'Karty projektu' },
        h('div.pw-ph', {}, 'Karty projektu', this.count), h('div.pw-tools', {}, this.search), this.list),
      h('section.pw-panel.op-main', { 'aria-label': 'Lens plánu' }, h('div.pw-ph', {}, this.title, this.back), this.scroller),
    );
  }

  update(data: PanelData) {
    this.data = data;
    this.renderList();
    this.renderDetail();
  }

  destroy() { this.plan.destroy(); }

  private pick(id: string | undefined) {
    this.picked = id;
    for (const b of this.list.querySelectorAll<HTMLElement>('.op-card')) {
      const on = b.dataset.card === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    this.renderDetail();
    this.scroller.scrollTop = 0;
  }

  /** Why there are no cards to list, or nothing when there are. */
  private emptyReason(): string | undefined {
    const o = store.opora;
    if (!o.project) return `Patro není propojené s projektem Opory${o.error ? ` (${o.error})` : ''}. Karty ani plán tu nejsou k dispozici.`;
    if (!o.cards.length) return o.connected ? 'Projekt v Opoře zatím nemá žádné karty.' : `Opora nedostupná${o.error ? `: ${o.error}` : ''}. Karty projektu teď nejdou načíst.`;
    return undefined;
  }

  private renderList() {
    const cards = store.opora.cards, q = this.search.value;
    const groups = groupCards(cards, q);
    const onWall = new Set(this.data?.board.lanes.map((l) => l.cardId).filter(Boolean));
    const sig = JSON.stringify([q, store.opora.project?.id ?? null, store.opora.connected, cards.map((c) => [c.id, c.name, c.sectorName, c.status, onWall.has(c.id)])]);
    if (sig === this.listSig) return;
    this.listSig = sig;
    const shown = groups.reduce((n, g) => n + g.cards.length, 0);
    this.count.textContent = cards.length ? (q.trim() ? `${shown} z ${cards.length}` : `${cards.length} karet`) : '';
    const empty = this.emptyReason();
    if (empty) { this.list.replaceChildren(h('p.pw-empty', {}, empty)); return; }
    if (!groups.length) { this.list.replaceChildren(h('p.pw-empty', {}, 'Žádná karta neodpovídá hledání.')); return; }
    this.list.replaceChildren(...groups.map((g) => h('div.op-group', { role: 'group', 'aria-label': g.area },
      h('h4', {}, h('span', {}, g.area), h('span', {}, String(g.cards.length))),
      ...g.cards.map((c) => h('button', {
        type: 'button', class: `op-card${c.id === this.picked ? ' on' : ''}`, 'data-card': c.id, 'aria-pressed': String(c.id === this.picked),
        onclick: () => this.pick(c.id),
      }, h('span', { class: `op-dot s-${c.status}`, 'aria-hidden': 'true' }), h('span.nm', {}, c.name),
      onWall.has(c.id) ? h('span.op-live', { title: 'Karta má dráhu v toku práce' }, 'v toku') : null,
      h('span.op-st', {}, STATUS_CZ[c.status] ?? c.status))))));
  }

  private renderDetail() {
    const card = this.picked ? store.opora.cards.find((c) => c.id === this.picked) : undefined;
    this.back.hidden = !card;
    if (!card) {
      this.title.textContent = 'Plán projektu';
      this.plan.refresh(store.floor);
      if (this.detail.firstChild !== this.plan.root || this.detail.childNodes.length !== 1) this.detail.replaceChildren(this.plan.root);
      return;
    }
    this.title.textContent = 'Karta';
    const { lane, onWall } = cardLane(card, this.data?.board.lanes ?? []);
    const facts = [card.sectorName ? `oblast ${card.sectorName}` : 'bez oblasti', STATUS_CZ[card.status] ?? card.status, card.profile ? `profil ${card.profile}` : '', card.stage ? `fáze ${card.stage}` : ''].filter(Boolean);
    const sections = inspectorSections(lane);
    this.detail.replaceChildren(
      h('h3', {}, card.name),
      h('div.lens-meta', {}, facts.join(' · ')),
      h('p.pw-notice', {}, onWall ? 'Karta má dráhu v toku práce: celý inspektor s událostmi je v záložce Proces.' : 'Na kartě teď nikdo nepracuje: Lens a náhled se čtou přímo z Opory.'),
      ...(sections.length ? sections : [h('p.pw-note', {}, 'K této kartě kancelář nemá co ukázat.')]),
    );
  }
}

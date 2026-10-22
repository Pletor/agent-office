// The window's Události tab: the floor's journal as a live list, newest first, filtered by card or
// worker. "Pozastavit čtení" holds the list still while events keep arriving; a counter says how
// many are waiting, and resuming shows them.

import type { ProcessEvent } from '../../../shared/protocol';
import { h } from '../../ui/dom';
import { LaneResolver, SOURCE_CZ, type Board } from './lanes';
import { clock, eventMark, phasePill, type PanelData, type Tab } from './view';

const SHOWN = 300;

export class StreamTab implements Tab {
  readonly root = h('section.pw-panel.pw-stream');
  private card = h('select.pw-sel', { 'aria-label': 'Filtr podle karty' });
  private worker = h('select.pw-sel', { 'aria-label': 'Filtr podle pracovníka' });
  private count = h('span.pw-count');
  private pause = h('button.pw-btn', { type: 'button' });
  private notice = h('div.pw-buf', { hidden: true });
  private list = h('div.pw-scroll.pw-events', { role: 'log', 'aria-live': 'off' });
  /** The seq the list stands at while reading is paused. */
  private pausedAt: number | null = null;
  private data?: PanelData;
  private rendered = '';

  constructor(private resolver: () => LaneResolver) {
    this.card.addEventListener('change', () => this.render());
    this.worker.addEventListener('change', () => this.render());
    this.pause.addEventListener('click', () => {
      this.pausedAt = this.pausedAt === null ? this.newest() : null;
      this.render();
    });
    this.root.append(h('div.pw-tools', {}, this.card, this.worker, this.count, this.pause), this.notice, this.list);
  }

  update(data: PanelData) {
    this.data = data;
    this.options(this.card, 'Všechny karty', data.board.lanes.map((l) => [l.key, `${l.chip} · ${l.name}`]));
    const names = new Map<string, string>();
    for (const e of data.events) if (e.actor?.kind === 'worker' && e.actor.id) names.set(e.actor.id, e.actor.name ?? e.actor.id);
    this.options(this.worker, 'Všichni pracovníci', [...names].sort((a, b) => a[1].localeCompare(b[1], 'cs')));
    this.render();
  }

  private newest() {
    const ev = this.data?.events;
    return ev?.length ? ev[ev.length - 1].seq : 0;
  }

  private options(select: HTMLSelectElement, all: string, items: [string, string][]) {
    const sig = JSON.stringify(items);
    if (select.dataset.sig === sig) return;
    const value = select.value;
    select.replaceChildren(h('option', { value: '' }, all), ...items.map(([v, label]) => h('option', { value: v }, label)));
    select.value = items.some(([v]) => v === value) ? value : '';
    select.dataset.sig = sig;
  }

  private render() {
    const data = this.data;
    if (!data) return;
    const resolver = this.resolver();
    const card = this.card.value, worker = this.worker.value;
    const match = (e: ProcessEvent) => (!card || resolver.key(e) === card) && (!worker || e.refs.workerId === worker || e.actor?.id === worker);
    const all = data.events.filter(match);
    const paused = this.pausedAt;
    const visible = paused === null ? all : all.filter((e) => e.seq <= paused);
    const waiting = all.length - visible.length;
    this.pause.className = `pw-btn${paused === null ? '' : ' on'}`;
    this.pause.replaceChildren(paused === null ? 'Pozastavit čtení' : 'Pokračovat ve čtení', ...(paused !== null && waiting ? [h('span.c', {}, `+${waiting}`)] : []));
    this.pause.setAttribute('aria-pressed', String(paused !== null));
    this.notice.hidden = paused === null;
    this.notice.textContent = `Čtení pozastaveno — data dál přicházejí, ${waiting} ${waiting === 1 ? 'nová událost čeká' : waiting >= 2 && waiting <= 4 ? 'nové události čekají' : 'nových událostí čeká'}.`;
    this.count.textContent = `${all.length} událostí${card || worker ? ' · filtr' : ''} · posledních ${data.events.length} na patře`;
    const shown = visible.slice(-SHOWN).reverse();
    const sig = `${card}|${worker}|${paused}|${shown.length}|${shown[0]?.id ?? ''}|${data.board.lanes.length}`;
    if (sig === this.rendered) return;
    this.rendered = sig;
    if (!shown.length) {
      this.list.replaceChildren(h('p.pw-empty', {}, data.events.length ? 'Filtru neodpovídá žádná událost.' : 'Zatím žádná událost — kancelář ani Opora nic nehlásí.'));
      return;
    }
    this.list.replaceChildren(...shown.map((e) => this.row(e, data.board, resolver)));
  }

  private row(e: ProcessEvent, board: Board, resolver: LaneResolver) {
    const key = resolver.key(e);
    const lane = key ? board.lanes.find((l) => l.key === key) : undefined;
    const target = e.tool?.target ? ` · ${e.tool.target}` : '';
    return h('div', { class: `pw-erow ${e.state}` },
      h('span.tm', {}, clock(e.at)),
      h('span.src', {}, SOURCE_CZ[e.source]),
      phasePill(e.phase),
      h('span.tx', {}, eventMark(e), h('span', { title: [e.title + target, e.detail].filter(Boolean).join('\n') }, e.title + target), h('span.kd', {}, e.kind)),
      lane ? h('span.pw-id', { title: lane.name }, lane.chip) : h('span'));
  }
}

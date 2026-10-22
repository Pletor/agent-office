// The window's Paměť tab: on the left what the journal says about memory (recalls, writes, cards
// committed to memory), on the right the live OpenViking read through Opora (memory.ts).

import { h } from '../../ui/dom';
import { MemoryPane } from './memory';
import { LaneResolver } from './lanes';
import { clock, eventMark, type PanelData, type Tab } from './view';

export class MemoryTab implements Tab {
  readonly root = h('div.pw-mem');
  private list = h('div.pw-scroll');
  private pane: MemoryPane;
  private rendered = '';

  constructor(report: (label: string, ok: boolean) => void, private resolver: () => LaneResolver) {
    this.pane = new MemoryPane(report);
    this.root.append(
      h('section.pw-panel', {}, h('div.pw-ph', {}, 'Paměť v žurnálu', h('span.sub', {}, 'fáze Paměť · memory.*')), this.list,
        h('div.pw-foot', {}, 'Vybavení nemění fázi karty — je to čtení.')),
      h('section.pw-panel', {}, h('div.pw-ph', {}, 'OpenViking · živě', h('span.sub', {}, 'čtení přes Oporu')), h('div.pw-scroll', {}, this.pane.root)),
    );
  }

  update(data: PanelData) {
    const items = data.events.filter((e) => e.phase === 'memory').slice(-60).reverse();
    const sig = items.map((e) => e.id).join(',');
    if (sig === this.rendered && this.list.childElementCount) return;
    this.rendered = sig;
    if (!items.length) {
      this.list.replaceChildren(h('p.pw-empty', {}, 'Žurnál patra zatím nemá žádnou událost paměti. Zápisy do OpenVikingu hlásí Opora sama; vybavení najdete vpravo.'));
      return;
    }
    const resolver = this.resolver();
    this.list.replaceChildren(...items.map((e) => {
      const key = resolver.key(e);
      const lane = key ? data.board.lanes.find((l) => l.key === key) : undefined;
      return h('div.pw-memit', {},
        h('div.h', {}, eventMark(e), clock(e.at), lane ? h('span.pw-id', {}, lane.chip) : null, e.actor?.name ?? '', h('span.kd', {}, e.kind)),
        h('div.t', {}, e.title), e.detail ? h('code', {}, e.detail) : null);
    }));
  }

  destroy() { this.pane.destroy(); }
}

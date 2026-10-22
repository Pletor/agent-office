// The window's Proces tab: the blockers on top, the flow map (a row per lane, its trail through the
// seven phases and the marker where its latest event put it) and the inspector of the chosen lane.
// Rows are kept by lane, so a marker slides to a new phase instead of being redrawn there; they
// reorder with a short slide, held while the pointer is over the list.

import { h } from '../../ui/dom';
import { renderInspector } from './inspector';
import { PHASE_CZ, type Lane } from './lanes';
import { clock, trailEl, type PanelData, type Tab } from './view';

interface Row {
  el: HTMLElement;
  name: HTMLElement;
  chip: HTMLElement;
  who: HTMLElement;
  cells: HTMLElement[];
  marker: HTMLElement;
  last: HTMLElement;
  lastId?: string;
}

const LAST_CLASS: Record<string, string> = { fail: 'fail', blocked: 'blocked', wait: 'wait' };

export class FlowTab implements Tab {
  readonly root = h('div.pw-flow');
  private blockers = h('div.pw-blk');
  private sub = h('span.sub');
  private head = h('div.pw-grid.pw-phh');
  private list = h('div.pw-list', { role: 'list' });
  private inspector = h('div.pw-insp');
  private inspectorChip = h('span.pw-id');
  private inspectorSub = h('span.sub');
  private rows = new Map<string, Row>();
  private order: string[] = [];
  private hold = false;
  private selected?: string;
  private data?: PanelData;

  constructor() {
    this.list.addEventListener('pointerenter', () => (this.hold = true));
    this.list.addEventListener('pointerleave', () => { this.hold = false; if (this.data) this.arrange(this.data); });
    const legend = h('div.pw-legend', {},
      h('span', {}, trailEl('ok'), 'potvrzeno'), h('span', {}, trailEl('fail'), 'selhalo'), h('span', {}, trailEl('wait'), 'čeká'),
      h('span', {}, trailEl('seen'), 'probíhá'), h('span', {}, trailEl('skip'), 'bez události'),
      h('span.note', {}, 'značka se hýbe jen při skutečné události'));
    const map = h('section.pw-panel.pw-map', {}, h('div.pw-ph', {}, 'Tok práce', this.sub), this.head, this.list, legend);
    const side = h('section.pw-panel.pw-side', { 'aria-label': 'Vybraná karta' }, h('div.pw-ph', {}, 'Karta', this.inspectorChip, this.inspectorSub), h('div.pw-scroll', {}, this.inspector));
    this.root.append(this.blockers, h('div.pw-split', {}, map, side));
  }

  update(data: PanelData) {
    this.data = data;
    const b = data.board;
    this.blockers.replaceChildren();
    if (b.blockers.length) {
      this.blockers.append(h('span.lbl', {}, `Blokace · ${b.blockers.length}`));
      for (const blk of b.blockers) {
        this.blockers.append(h('button', { type: 'button', class: `pw-bi ${blk.severity === 'wait' ? 'w' : ''}`, title: `${blk.chip} ${blk.text}`, onclick: () => this.select(blk.lane) },
          h('b', {}, blk.chip), h('span', {}, blk.text)));
      }
    } else this.blockers.append(h('span.lbl.calm', {}, b.lanes.length ? 'Bez blokací' : ''));
    this.sub.textContent = `${b.lanes.length} karet · nejdřív blokace, pak poslední událost`;
    this.head.replaceChildren(h('span.pw-phl', {}, 'Karta · pracovník'),
      ...PHASE_CZ.map((name, i) => h('span.pw-phn', { title: name }, h('span.n', {}, i + 1), h('span.nm', {}, name), b.phaseCounts[i] ? h('span.c', {}, b.phaseCounts[i]) : null)));
    for (const key of [...this.rows.keys()]) if (!b.lanes.some((l) => l.key === key)) { this.rows.get(key)!.el.remove(); this.rows.delete(key); }
    for (const lane of b.lanes) this.paint(lane, data.reduced);
    if (!this.selected || !b.lanes.some((l) => l.key === this.selected)) this.selected = b.lanes[0]?.key;
    this.arrange(data);
    this.renderSide();
  }

  private select(key: string) {
    this.selected = key;
    for (const [k, row] of this.rows) { row.el.classList.toggle('sel', k === key); row.el.setAttribute('aria-current', String(k === key)); }
    this.rows.get(key)?.el.scrollIntoView({ block: 'nearest' });
    this.renderSide();
  }

  private renderSide() {
    const lane = this.data?.board.lanes.find((l) => l.key === this.selected);
    this.inspectorChip.textContent = lane?.chip ?? '';
    this.inspectorChip.hidden = !lane;
    this.inspectorSub.textContent = lane?.blocker?.text ?? '';
    this.inspector.replaceChildren(...renderInspector(lane));
  }

  /** Puts the rows in the board's order (unless the pointer is over them), sliding them there. */
  private arrange(data: PanelData) {
    const keys = data.board.lanes.map((l) => l.key);
    if (!keys.length) {
      this.list.replaceChildren(h('p.pw-empty', {}, 'Zatím žádná událost — kancelář ani Opora nic nehlásí.'));
      this.order = [];
      return;
    }
    this.list.querySelector(':scope > .pw-empty')?.remove();
    const fresh = keys.filter((k) => !this.order.includes(k));
    const next = this.hold ? [...this.order.filter((k) => keys.includes(k)), ...fresh] : keys;
    if (next.join('\n') === this.order.join('\n') && this.list.childElementCount === next.length) return;
    const before = new Map<string, number>();
    if (!data.reduced) for (const [k, r] of this.rows) if (r.el.isConnected) before.set(k, r.el.getBoundingClientRect().top);
    for (const k of next) this.list.append(this.rows.get(k)!.el);
    this.order = next;
    if (data.reduced) return;
    for (const [k, top] of before) {
      const el = this.rows.get(k)?.el;
      if (!el) continue;
      const dy = top - el.getBoundingClientRect().top;
      if (!dy) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      void el.offsetHeight;
      el.style.transition = 'transform 300ms ease-out';
      el.style.transform = '';
    }
  }

  private paint(lane: Lane, reduced: boolean) {
    let row = this.rows.get(lane.key);
    const isNew = !row;
    if (!row) row = this.makeRow(lane.key);
    const r = row;
    r.name.textContent = lane.name;
    r.name.title = lane.name;
    r.chip.textContent = lane.chip;
    r.who.textContent = `${lane.worker ?? 'bez pracovníka'} · ${lane.source}`;
    r.el.classList.toggle('blocked', !!lane.blocker);
    r.el.classList.toggle('sel', lane.key === this.selected);
    r.el.setAttribute('aria-label', `${lane.name}: ${lane.marker === 'none' ? 'bez události' : PHASE_CZ[lane.phase]}${lane.blocker ? ', ' + lane.blocker.text : ''}`);
    const first = lane.trail.findIndex((m) => m);
    lane.trail.forEach((mark, i) => {
      const cell = r.cells[i];
      cell.className = `pw-cell${i < lane.phase ? ' past' : i === lane.phase && lane.marker !== 'none' ? ' cur' : ''}`;
      const show = i === lane.phase && lane.marker !== 'none' ? null : i < lane.phase ? mark ?? (i > first ? 'skip' : null) : mark;
      cell.replaceChildren(...(show ? [trailEl(show, i > lane.phase ? 'ahead' : '')] : []));
    });
    r.marker.style.left = `${((lane.phase + 0.5) / 7) * 100}%`;
    r.marker.className = `pw-mk ${lane.marker}`;
    r.marker.replaceChildren(lane.marker === 'none' ? '—' : lane.initials, ...(lane.blocker?.human ? [h('span.bang', { 'aria-hidden': 'true' }, '!')] : []));
    const last = lane.last;
    r.last.className = `pw-last ${last ? LAST_CLASS[last.state] ?? '' : ''}`;
    r.last.replaceChildren(h('span.tm', {}, last ? clock(last.at) : '—:—'), h('span.tx', { title: last?.detail ?? '' }, last ? last.title : 'Zatím bez události'));
    // Motion only for a new event on a row already shown.
    if (!isNew && last && last.id !== r.lastId && !reduced) {
      const cls = last.state === 'fail' ? 'shake' : last.kind === 'tool.use' ? 'pulse' : '';
      if (cls) {
        r.marker.classList.remove('pulse', 'shake');
        void r.marker.offsetWidth;
        r.marker.classList.add(cls);
      }
    }
    if (isNew) r.marker.classList.add('still');
    r.lastId = last?.id;
  }

  private makeRow(key: string): Row {
    const name = h('span.t'), chip = h('span.pw-id'), who = h('span');
    const cells = PHASE_CZ.map(() => h('span.pw-cell'));
    const marker = h('span.pw-mk');
    const last = h('div.pw-last');
    marker.addEventListener('animationend', () => marker.classList.remove('pulse', 'shake'));
    const el = h('div.pw-row', { role: 'listitem', tabindex: 0, onclick: () => this.select(key), onkeydown: (e: Event) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'Enter' || k === ' ') { e.preventDefault(); this.select(key); }
    } },
    h('div.pw-lab', {}, name, h('span.w', {}, chip, who)),
    h('div.pw-track', {}, ...cells, marker),
    last);
    // The first paint places the marker; from then on it slides.
    requestAnimationFrame(() => marker.classList.remove('still'));
    const row: Row = { el, name, chip, who, cells, marker, last };
    this.rows.set(key, row);
    return row;
  }
}

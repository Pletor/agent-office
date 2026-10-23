// The wall's window (E): "Živý proces · patro …", tabs Proces / Události / Paměť (and the ones other
// features add with addWindowTab, like Lens plánu), the health of each source, and the ✕ that openModal puts at the end of the header. Closing it (✕ or Esc) goes through
// openModal, which hands the player straight back to mouse-look.

import { h, openModal, type Modal } from '../../ui/dom';
import { FlowTab } from './flow';
import type { LaneResolver } from './lanes';
import type { SourceHealth } from './live';
import { MemoryTab } from './memtab';
import { StreamTab } from './stream';
import type { PanelData, Tab } from './view';
import './ui.css';
import './flow.css';

type TabId = string;
const TABS: [TabId, string][] = [['flow', 'Proces'], ['stream', 'Události'], ['memory', 'Paměť']];

/** A tab another feature adds after Paměť (features/opora-plan): its id, its label and how it opens. */
export interface WindowTab { id: string; label: string; open(resolver: () => LaneResolver): Tab }
const added: WindowTab[] = [];
export function addWindowTab(tab: WindowTab): () => void {
  added.push(tab);
  return () => { const i = added.indexOf(tab); if (i >= 0) added.splice(i, 1); };
}

export class ProcessWallPanel {
  private modal?: Modal;
  private tabId: TabId = 'flow';
  private tab?: Tab;
  private title = h('h2');
  private sources = h('div.pw-srcs', { 'aria-label': 'Zdraví zdrojů' });
  private body = h('div.pw-body');
  private buttons = new Map<TabId, HTMLButtonElement>();
  private data?: PanelData;

  constructor(private resolver: () => LaneResolver, private reportMemory: (label: string, ok: boolean) => void) {}

  get open() { return !!this.modal; }

  show(data: PanelData, tab: TabId = 'flow') {
    if (this.modal) return;
    this.data = data;
    const tabs = h('nav.pw-tabs', { role: 'tablist', 'aria-label': 'Pohled na proces' });
    this.buttons.clear();
    for (const [id, label] of [...TABS, ...added.map((t): [TabId, string] => [t.id, t.label])]) {
      const b = h('button.pw-tab', { type: 'button', role: 'tab', onclick: () => this.switch(id) }, label);
      this.buttons.set(id, b);
      tabs.append(b);
    }
    const panel = h('section.pw-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Živý proces' },
      h('header.pw-head', {}, this.title, tabs, this.sources), this.body);
    this.modal = openModal(panel, { doing: 'sleduje živý proces', onClose: () => {
      this.tab?.destroy?.();
      this.tab = undefined;
      this.body.replaceChildren();
      this.modal = undefined;
    } });
    this.switch(tab);
    this.buttons.get(tab)?.focus();
  }

  close() { this.modal?.close(); }

  /** New data: an event, the store or the connection changed. */
  update(data: PanelData) {
    this.data = data;
    if (!this.modal) return;
    this.title.textContent = `Živý proces · patro ${data.floor}`;
    this.health(data.health);
    this.tab?.update(data);
  }

  /** The once-a-second clock: only the ages in the source chips. */
  tick(health: SourceHealth[]) {
    if (this.modal) this.health(health);
  }

  private switch(id: TabId) {
    if (!this.modal || !this.data) return;
    if (this.tab && id === this.tabId) return;
    this.tab?.destroy?.();
    this.tabId = id;
    const other = added.find((t) => t.id === id);
    this.tab = other ? other.open(this.resolver) : id === 'flow' ? new FlowTab() : id === 'stream' ? new StreamTab(this.resolver) : new MemoryTab(this.reportMemory, this.resolver);
    this.body.replaceChildren(this.tab.root);
    for (const [k, b] of this.buttons) {
      b.classList.toggle('on', k === id);
      b.setAttribute('aria-selected', String(k === id));
    }
    this.update(this.data);
  }

  private health(list: SourceHealth[]) {
    const sig = JSON.stringify(list);
    if (this.sources.dataset.sig === sig) return;
    this.sources.dataset.sig = sig;
    this.sources.replaceChildren(...list.map((s) => h('span', { class: `pw-pill ${s.tone}` }, h('b', {}, s.name), h('span.age', {}, s.text))));
  }
}

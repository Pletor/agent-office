// The Výstupy ledge's window (E at it), in two modes switched at the top (docs/vystupy-board.md):
// Seznam, every PR merged into main, newest first, with a filter for those "bez výstupu" (list.ts), and
// Deník, the project's change diary over 7, 30 or 90 days (diary.ts). Pictures open large on a click.

import { countsLine } from '../../../shared/outputs';
import { h, openModal, type Modal } from '../../ui/dom';
import type { OutputsView } from './board';
import { diaryView } from './diary';
import { prCard } from './list';

export interface DetailDeps {
  view(): OutputsView;
  refresh(): void;
  onChange(fn: () => void): () => void;
  days(): number;
  setDays(days: number): void;
  setDiary(url: string): Promise<string | undefined>;
}

type Mode = 'list' | 'diary';

export function openOutputs(deps: DetailDeps, start: Mode = 'list'): Modal {
  let mode: Mode = start;
  let onlyNone = false;
  const title = h('h2');
  const modes = new Map<Mode, HTMLButtonElement>();
  const modeBar = h('div.vo-modes', { role: 'tablist', 'aria-label': 'Pohled' });
  for (const [id, label] of [['list', '📋 Seznam'], ['diary', '📔 Deník']] as [Mode, string][]) {
    const b = h('button.pw-tab', { type: 'button', role: 'tab', onclick: () => { mode = id; render(); } }, label) as HTMLButtonElement;
    modes.set(id, b);
    modeBar.append(b);
  }
  const filter = h('button.pw-tab', { type: 'button', 'aria-pressed': 'false', onclick: () => { onlyNone = !onlyNone; render(); } }, 'jen bez výstupu') as HTMLButtonElement;
  const again = h('button.pw-tab', { type: 'button', onclick: () => deps.refresh() }, '↻ obnovit');
  const list = h('div.pw-body.vo-body');
  const el = h('section.pw-modal.vo-detail', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Výstupy Čisté linie' }, h('header.pw-head', {}, title, modeBar, filter, again), list);

  function render() {
    const v = deps.view();
    const d = v.data;
    for (const [id, b] of modes) {
      b.classList.toggle('on', id === mode);
      b.setAttribute('aria-selected', String(id === mode));
    }
    filter.hidden = mode !== 'list';
    filter.classList.toggle('on', onlyNone);
    filter.setAttribute('aria-pressed', String(onlyNone));
    title.textContent = d ? `🗂️ Výstupy · ${d.repo.label} · ${countsLine(d.counts)}` : '🗂️ Výstupy · Čistá linie';
    if (!d) {
      list.replaceChildren(h('p.vo-empty', {}, v.error ?? (v.loading ? 'Čtu sloučené PR…' : 'Žádná data.')));
      return;
    }
    const top = list.scrollTop;
    if (mode === 'diary') {
      list.replaceChildren(...diaryView(d, { days: deps.days(), setDays: deps.setDays, setDiary: deps.setDiary }));
    } else {
      const prs = onlyNone ? d.prs.filter((p) => !p.outputs) : d.prs;
      list.replaceChildren(
        h('p.vo-lead', {}, `Sloučeno do ${d.repo.main} za posledních ${d.days} dní. Výstup = sekce „## Výstup“ v těle PR (Artefakt, Před, Po, Diagram, Vysvětlení).`),
        ...[d.note, d.error].filter((x): x is string => !!x).map((t) => h('p.vo-note', {}, t)),
        ...(prs.length ? prs.map(prCard) : [h('p.vo-empty', {}, onlyNone ? 'Každý sloučený PR má výstup.' : 'Za tu dobu se nic nesloučilo.')]),
      );
    }
    list.scrollTop = top;
  }

  const off = deps.onChange(render);
  const modal = openModal(el, { doing: '🗂️ čte výstupy Čisté linie', onClose: off });
  render();
  deps.refresh();
  return modal;
}

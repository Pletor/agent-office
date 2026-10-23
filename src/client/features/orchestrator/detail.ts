// The purple board's window (E at its ledge): the full detail of the card picked for the orchestrator, in
// both designs. "Lens (návrh 1)": the card's PR Lens, area map and area plan Lens with the diagram's
// popovers and step-through (features/lens), beside the card's facts and the overview the orchestrator
// gets. "Design karta (návrh 2)": the seven stages of a design card (design.ts). Read-only, like Opora's
// readers behind it; a person's actions open Opora.

import { store } from '../../state';
import { h, openModal, type Modal } from '../../ui/dom';
import { LensSection } from '../lens/ui';
import { STATUS_CZ, cardLane } from '../opora-plan/cards';
import { buildBoard } from '../process-wall/lanes';
import { DesignDrawer, isDesign } from './design';

type TabId = 'lens' | 'design';

/** The process wall's lanes, built the same way the wall builds them, for the focused card's phase, branch and PR. */
function lanes() {
  return buildBoard({ events: store.process.events, workers: [...store.workers.values()], tasks: store.queue.tasks, pulls: store.pulls.items, runs: store.opora.runs, cards: store.opora.cards }).lanes;
}

export function openDetail(deps: { openPicker(): void }): Modal | undefined {
  const floor = store.floor;
  if (!floor) return undefined;
  const title = h('h2');
  const tabs = h('nav.pw-tabs', { role: 'tablist', 'aria-label': 'Návrh' });
  const body = h('div.pw-body.oc-body');
  const el = h('section.pw-modal.oc-detail', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Detail karty pro orchestrátora' }, h('header.pw-head', {}, title, tabs), body);
  const base = () => store.opora.url || undefined;
  const drawer = new DesignDrawer(floor, base);
  let lens: { card: string; s: LensSection } | undefined;
  let tab: TabId = isDesign(store.opora.cards.find((c) => c.id === store.orchestrator.focus?.cardId)) ? 'design' : 'lens';
  const buttons = new Map<TabId, HTMLButtonElement>();
  for (const [id, label] of [['lens', 'Lens (návrh 1)'], ['design', 'Design karta (návrh 2)']] as [TabId, string][]) {
    const b = h('button.pw-tab', { type: 'button', role: 'tab', onclick: () => { tab = id; render(); } }, label) as HTMLButtonElement;
    buttons.set(id, b);
    tabs.append(b);
  }

  function lensTab(cardId: string) {
    const card = store.opora.cards.find((c) => c.id === cardId);
    if (lens?.card !== cardId) {
      lens?.s.destroy();
      lens = { card: cardId, s: new LensSection(floor!, cardId, () => store.opora.cards.find((c) => c.id === cardId)?.sectorId, base) };
    }
    lens.s.refresh();
    const run = store.opora.runs.find((r) => r.cardId === cardId && r.state !== 'gone');
    const s = store.orchestrator;
    const facts: [string, string][] = [
      ['Oblast', card?.sectorName || 'bez oblasti'], ['Stav', card ? STATUS_CZ[card.status] ?? card.status : 'není na canvasu'],
      ['Pipeline', card?.profile ? `${card.profile}${card.stage ? ` · etapa ${card.stage}` : ''}` : 'bez pipeline'],
      ['Pracovník', run ? `${run.workerName ?? 'pracovník'} · ${run.state === 'working' ? 'pracuje' : run.state === 'done' ? 'dokončil tah' : run.state}` : 'nikdo z kanceláře'],
    ];
    return h('div.oc-lens', {},
      h('div.oc-lens-main.pw-insp', {}, lens.s.root),
      h('aside.oc-lens-side.pw-insp', {},
        h('div.oc-k', {}, 'Karta'),
        h('dl.oc-facts', {}, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
        h('div.oc-k', {}, 'Co vidí orchestrátor'),
        s.brief ? h('pre.oc-brief', {}, s.brief) : h('p.pw-note', {}, 'Kancelář přehled ještě skládá z Opory…'),
        h('p.pw-note', {}, 'Přehled jde plánovači u stolu do zadání jako data, ne pokyny, a kancelář ho drží aktuální, dokud je karta vybraná.')));
  }

  let lensKept: HTMLElement | undefined;
  function render() {
    const f = store.orchestrator.focus;
    const card = f ? store.opora.cards.find((c) => c.id === f.cardId) : undefined;
    title.textContent = f ? `🔎 Detail karty · ${card?.name ?? f.name}` : '🔎 Detail karty pro orchestrátora';
    for (const [id, b] of buttons) { b.classList.toggle('on', id === tab); b.setAttribute('aria-selected', String(id === tab)); }
    if (!f) {
      lensKept = undefined;
      body.replaceChildren(h('div.oc-empty', {}, h('p', {}, 'Orchestrátor zatím nemá vybranou kartu. Vyber ji na pravé tabuli (deska nad přepínačem na severním skle).'),
        h('button.btn.primary', { type: 'button', onclick: () => deps.openPicker() }, '🎯 Vybrat kartu')));
      return;
    }
    if (tab === 'lens') {
      // The Lens section keeps its diagram (and its popover or step-through) across redraws.
      const next = lensTab(f.cardId);
      if (lensKept && lensKept.isConnected) lensKept.replaceWith(next); else body.replaceChildren(next);
      lensKept = next;
      return;
    }
    lensKept = undefined;
    const lane = card ? cardLane(card, lanes()).lane : undefined;
    const run = card ? store.opora.runs.find((r) => r.cardId === card.id && r.state !== 'gone') : undefined;
    drawer.update(card, lane, run?.state === 'working' ? run.workerName : undefined);
    if (body.firstChild !== drawer.root) body.replaceChildren(drawer.root);
  }

  let frame = 0;
  const later = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };
  const offs = (['opora', 'orchestrator', 'process', 'workers', 'pulls'] as const).map((t) => store.on(t, later));
  const modal = openModal(el, { doing: '🔎 čte detail karty pro orchestrátora', onClose: () => { offs.forEach((off) => off()); cancelAnimationFrame(frame); lens?.s.destroy(); drawer.destroy(); } });
  render();
  buttons.get(tab)?.focus();
  return modal;
}

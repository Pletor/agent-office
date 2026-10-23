// The purple board's window (E at the board): the orchestrator's card as the board shows it, to act on.
// Its plan by layers (area → sector → node) with what a person can do to each sector and the whole page,
// all through the office's own ways to Opora: ⏸ Pozastavit stops the cell taking more cards (autopilot
// and hand-out off) and points at the terminals of the workers still on it (⎋ Esc there interrupts);
// ↻ Přeplánovat starts the planner at the table on it (a plan onto the canvas, the card's overview in
// its brief); 👤 Přidat stůl takes its next free card (a lease on Opora and a worker at a desk). Anything
// else opens Opora. Beside it "Design karta v procesu", the ledge's design drawer (orchestrator/design.ts).

import type { Net } from '../../net';
import { store } from '../../state';
import { h, openModal, type Modal } from '../../ui/dom';
import { DesignDrawer, isDesign, laneFor } from '../orchestrator/design';
import '../orchestrator/ui.css';
import type { CardReads, RoomNotes } from './data';
import { planView, TONE, type NodeView, type PlanView } from './model';
import './ui.css';

export interface WindowDeps {
  net: Net;
  reads: CardReads;
  notes: RoomNotes;
  /** Something happened here: the board redraws. */
  changed(): void;
  openFull(): void;
  showPlanning(): void;
  openTerminal(workerId: string): void;
}

export function openLiveWindow(d: WindowDeps): Modal | undefined {
  const floor = store.floor;
  if (!floor) return undefined;
  const title = h('h2');
  const path = h('div.ol-path');
  const plan = h('section.ol-plan', { 'aria-label': 'Plán po vrstvách' });
  const side = h('section.ol-side', { 'aria-label': 'Design karta v procesu' });
  const said = h('p.ol-said', { role: 'status' });
  const el = h('section.pw-modal.ol-window', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Canvas živě' },
    h('header.pw-head', {}, h('div.ol-hd', {}, title, path)), h('div.pw-body.ol-body', {}, h('div.ol-col', {}, said, plan), side));
  const drawer = new DesignDrawer(floor, () => store.opora.url || undefined);
  let sig = '';

  const note = (what: string) => { d.notes.add('Ty', what); said.textContent = `Ty ${what}`; d.changed(); };
  const where = (v: PlanView, label?: string) => [v.path.map((n) => n.name).join(' › '), label].filter(Boolean).join(' › ');

  function pause(nodes: NodeView[], label: string) {
    const o = store.opora;
    if (o.autopilot) d.net.send({ t: 'opora.autopilot', on: false, maxRuns: o.maxRuns });
    if (o.handOut) d.net.send({ t: 'opora.handout', on: false });
    const still = nodes.filter((n) => n.workerId);
    note(`pozastavil(a) „${label}“: buňka si nové karty nebere${still.length ? `, ${still.map((n) => n.worker).join(', ')} přeruš v terminálu (⎋ Esc)` : ''}`);
    if (still[0]?.workerId) d.openTerminal(still[0].workerId);
  }
  function replan(v: PlanView, label: string) {
    d.net.send({ t: 'planning.start', mode: 'opora', goal: `Přeplánuj ${where(v, label)} na canvasu Opory po vrstvách: oblasti → sektory → uzly (karty) uvnitř stránky ${v.name ?? ''}. Drž se jen této cesty.` });
    note(`poslal(a) „${label}“ k přeplánování plánovači u stolu`);
  }
  function addDesk(nodes: NodeView[], label: string) {
    const free = nodes.find((n) => n.free);
    if (!free) return;
    d.net.send({ t: 'opora.take', cardId: free.node.id });
    note(`přidal(a) stůl na „${free.node.name}“ (${label})`);
  }

  function actions(v: PlanView, nodes: NodeView[], label: string): HTMLElement {
    const o = store.opora;
    const pausable = o.autopilot || o.handOut || nodes.some((n) => n.workerId);
    const planning = store.planning.current?.status === 'planning';
    const free = nodes.some((n) => n.free);
    return h('div.ol-acts', {},
      h('button.btn.small', { type: 'button', disabled: !pausable, title: pausable ? 'Buňka si přestane brát nové karty; běžící pracovníky přerušíš v jejich terminálu' : 'Nic tu neběží a buňka sama nic nebere', onclick: () => pause(nodes, label) }, '⏸ Pozastavit'),
      h('button.btn.small', { type: 'button', disabled: planning, title: planning ? 'Plánovač u stolu už plánuje' : 'Plánovač u stolu to rozplánuje na canvas Opory', onclick: () => replan(v, label) }, '↻ Přeplánovat'),
      h('button.btn.small', { type: 'button', disabled: !free, title: free ? 'Vzít další volnou kartu: zámek v Opoře a pracovník u stolu' : 'Tady teď žádná volná karta není', onclick: () => addDesk(nodes, label) }, '👤 Přidat stůl'));
  }

  function nodeRow(n: NodeView): HTMLElement {
    const [color, words] = TONE[n.tone];
    const dot = h('span.ol-dot', { 'aria-hidden': 'true' });
    dot.style.background = color;
    return h('li.ol-node', {}, dot, h('span.ol-nm', {}, n.node.name, h('small', {}, [words, n.node.card?.layer, n.node.checks ? `${n.node.checks} kontrol` : ''].filter(Boolean).join(' · '))),
      n.workerId ? h('button.btn.small', { type: 'button', title: `Terminál: ${n.worker}`, onclick: () => d.openTerminal(n.workerId!) }, `⎋ ${n.worker}`) : h('span.ol-av', { title: 'nikdo z kanceláře' }, n.worker ?? '?'));
  }

  function render() {
    const o = store.opora, orch = store.orchestrator;
    const v = planView(o, orch, d.reads.layers);
    const card = o.cards.find((c) => c.id === v.cardId);
    const next = JSON.stringify([v, card ?? null, o.autopilot, o.handOut, store.planning.current?.status ?? null, d.reads.preview ? 1 : 0]);
    if (next !== sig) {
      sig = next;
      title.textContent = v.cardId ? `🛰️ Canvas živě · 🎯 ${v.name}` : '🛰️ Canvas živě';
      path.textContent = v.path.length ? v.path.map((n) => (n.host ? `${n.name} (${n.host})` : n.name)).join(' › ') : 'Zapni stránku nebo podstránku na 🎚️ Zaměření buňky: nejhlubší zapnutá je karta pro orchestrátora.';
      const all = v.areas.flatMap((a) => a.sectors.flatMap((s) => s.nodes));
      const head = h('div.ol-ph', {}, h('b', {}, 'Plán po vrstvách'), h('span', {}, `oblasti ${v.counts.area} → sektory ${v.counts.sector} → uzly ${v.counts.node}`),
        h('button.btn.small', { type: 'button', onclick: () => d.showPlanning() }, '🧭 Plán u stolu'), h('button.btn.small', { type: 'button', onclick: () => d.openFull() }, 'Editor Opory ↗'));
      const body: Node[] = [head];
      if (!v.cardId) body.push(h('p.pw-note', {}, 'Orchestrátor zatím nemá kartu.'));
      else {
        body.push(h('div.ol-page', {}, h('b', {}, `Celá stránka · ${v.name}`), actions(v, all, v.name ?? '')));
        if (v.read === 'reading') body.push(h('p.pw-note', {}, 'Čtu z Opory, co je uvnitř stránky…'));
        else if (v.read !== 'ok') body.push(h('p.pw-note', {}, v.read === 'missing' ? 'Stránka teď není na canvasu Opory.' : 'Opora teď neodpovídá.'));
        else if (!v.areas.length) body.push(h('p.pw-note', {}, 'Uvnitř stránky zatím nic není: ↻ Přeplánovat ji nechá rozvrhnout plánovačem na oblasti → sektory → uzly.'));
        for (const a of v.areas) {
          body.push(h('div.ol-area', {}, h('h3', {}, a.area ? `Oblast · ${a.name}` : 'Mimo oblasti', a.area?.purpose ? h('small', {}, a.area.purpose) : null),
            ...a.sectors.map((s) => h('div', { class: `ol-sec${s.working ? ' hot' : ''}` },
              h('div.ol-sh', {}, h('b', {}, s.sector ? `Sektor · ${s.name}` : s.name), h('span', {}, `${s.nodes.length ? Math.round((s.done / s.nodes.length) * 100) : 0} % · ${s.working} běží`)),
              h('ul.ol-nodes', {}, ...s.nodes.map(nodeRow)),
              actions(v, s.nodes, s.name)))));
        }
      }
      plan.replaceChildren(...body);
    }
    const lane = laneFor(card);
    if (card && isDesign(card)) {
      drawer.update(card, lane.lane, lane.worker);
      if (side.firstChild !== drawer.root) side.replaceChildren(drawer.root);
    } else if (!side.querySelector('.pw-note') || side.dataset.card !== (v.cardId ?? '')) {
      side.dataset.card = v.cardId ?? '';
      side.replaceChildren(h('div.oc-dr', {}, h('div.oc-dr-h', {}, h('h2', {}, 'Design karta v procesu')),
        h('div.oc-dr-b', {}, h('p.pw-note', {}, v.cardId ? 'Tahle karta není na design pipeline: sedm etap, náhled a brand patří design kartám. Lens karty je na římse pod tabulí (E).' : 'Až orchestrátor dostane design kartu, uvidíš tu její etapy, jak bude vypadat a brand.'))));
    }
  }

  let frame = 0;
  const later = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };
  const offs = (['opora', 'orchestrator', 'planning', 'process', 'workers', 'pulls'] as const).map((t) => store.on(t, later));
  const poll = setInterval(later, 2000);
  const modal = openModal(el, { doing: '🛰️ u Canvasu živě', onClose: () => { offs.forEach((off) => off()); clearInterval(poll); cancelAnimationFrame(frame); drawer.destroy(); } });
  render();
  return modal;
}

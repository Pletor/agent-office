// "Design karta (návrh 2)": the wide card drawer of the design "Design karta v procesu", for the focused
// card. Where the card is as seven stages on a rail (the current one working), the read-only mode, the
// stage's preview (the sketch × screenshot slider at Review), the project's DESIGN.md brand, the
// evidence slots, a sentence on who's on turn, and the person's actions, which live in Opora. Read from
// the office (GET /api/opora-preview) with the pieces of features/design-preview; a card that isn't on
// the design pipeline gets the rail greyed and why.

import { oporaLensUrl } from '../../../shared/opora-lens';
import type { OporaPreviewReply } from '../../../shared/opora-preview';
import type { OporaCard } from '../../../shared/protocol';
import { h } from '../../ui/dom';
import { brandPanel, modeChip } from '../design-preview/parts';
import { designStage, evidence, shownHead, STAGES, type Evidence, type StageInput } from '../design-preview/stage';
import { preview } from '../design-preview/view';
import { buildBoard, type Lane } from '../process-wall/lanes';
import { cardLane } from '../opora-plan/cards';
import { store } from '../../state';
import '../design-preview/ui.css';

/** What each stage yields, from the design's rail. */
export const YIELDS = ['cíl a inspirace', 'drátěný model', 'snímky pohybu', 'živý náhled', 'screenshoty', 'před / po', 'potvrzeno'];
export const NAMES = ['Zadání', 'Návrh / skica', 'Storyboard', 'Implementace', 'Kontroly', 'Review', 'Hotovo'];
const SLOT_TITLE: Record<Evidence['state'], string> = { full: 'doloženo', human: 'potvrzeno člověkem', half: 'deklarováno bez dokladu', none: 'chybí' };

export const isDesign = (c?: OporaCard) => !!c && (c.group === 'design' || c.profile === 'design');

/** The card's lane on the process wall (built as the wall builds it: its phase, branch and PR) and the worker on it now. */
export function laneFor(card: OporaCard | undefined): { lane?: Lane; worker?: string } {
  if (!card) return {};
  const lanes = buildBoard({ events: store.process.events, workers: [...store.workers.values()], tasks: store.queue.tasks, pulls: store.pulls.items, runs: store.opora.runs, cards: store.opora.cards }).lanes;
  const run = store.opora.runs.find((r) => r.cardId === card.id && r.state !== 'gone');
  return { lane: cardLane(card, lanes).lane, worker: run?.state === 'working' ? run.workerName : undefined };
}

/** Who's on turn at a stage, in a sentence, and whether it waits on a person (`wait`) or is done (`ok`). */
export function turnSentence(stage: number, worker: string | undefined, confirmed: boolean): [string, '' | 'wait' | 'ok'] {
  switch (stage) {
    case 0: return ['Čeká na člověka: dopsat zadání', 'wait'];
    case 1: return ['Čeká na člověka: skica obrazovky', 'wait'];
    case 2: return ['Storyboard hotový · čeká na implementaci', ''];
    case 3: return [worker ? `Pracuje ${worker}` : 'Na řadě: implementace', ''];
    case 4: return ['Na řadě: kontroly · screenshoty', ''];
    case 5: return ['Ke schválení: shoda s návrhem', 'wait'];
    default: return [confirmed ? 'Uzavřeno · vzhled potvrzen' : 'Uzavřeno', 'ok'];
  }
}

function previewUrl(base: string | undefined, card: string): string | undefined {
  const lens = oporaLensUrl(base, card);
  if (!lens) return undefined;
  const u = new URL(lens);
  u.searchParams.set('ohTab', 'preview');
  return u.href;
}

const link = (href: string | undefined, label: string, cls: string, enabled = true) =>
  href && enabled ? h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer' }, label) : h('button', { type: 'button', class: cls, disabled: true }, label);

export class DesignDrawer {
  readonly root = h('div.oc-dr');
  private reply?: OporaPreviewReply;
  private failed = false;
  private at = 0;
  private loading?: AbortController;
  private card?: string;
  private picked?: number;
  private cut = 50;
  private drawn = '';
  private playing?: ReturnType<typeof setInterval>;

  constructor(private floor: string, private base: () => string | undefined) {}

  destroy() { this.loading?.abort(); this.stop(); }

  /** The focused card and its lane; reads the preview again when it's a new card or older than 30 s. */
  update(card: OporaCard | undefined, lane: Lane | undefined, worker: string | undefined, now = Date.now()) {
    if (card?.id !== this.card) { this.card = card?.id; this.reply = undefined; this.failed = false; this.at = 0; this.picked = undefined; this.stop(); this.loading?.abort(); this.loading = undefined; }
    this.render(card, lane, worker);
    if (!card || !isDesign(card) || this.loading || now - this.at < 30_000) return;
    this.at = now;
    const ctl = (this.loading = new AbortController());
    fetch(`/api/opora-preview?${new URLSearchParams({ floor: this.floor, card: card.id })}`, { signal: ctl.signal, cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<OporaPreviewReply>) : Promise.reject(new Error(String(r.status)))))
      .then((reply) => { this.reply = reply; this.failed = false; this.render(card, lane, worker); })
      .catch(() => { if (!ctl.signal.aborted && !this.reply) { this.failed = true; this.render(card, lane, worker); } })
      .finally(() => { if (this.loading === ctl) this.loading = undefined; });
  }

  private stop() { if (this.playing) clearInterval(this.playing); this.playing = undefined; }

  private rail(stage: number, shown: number, na: boolean, pick: (i: number) => void): HTMLElement {
    return h('div', { class: `oc-rail${na ? ' na' : ''}`, role: 'group', 'aria-label': na ? 'Etapy návrhu (pro tuto kartu neplatí)' : `Etapa ${stage + 1} ze 7: ${NAMES[stage]}` },
      ...STAGES.map((_, i) => {
        const cls = ['oc-seg', !na && (i < stage || stage === 6) ? 'done' : '', !na && i === stage && stage !== 6 ? 'cur' : '', !na && i === shown ? 'shown' : ''].filter(Boolean).join(' ');
        return h('button', { type: 'button', class: cls, disabled: na || i > stage, 'aria-pressed': String(!na && i === shown), ...(!na && i === stage ? { 'aria-current': 'step' } : {}), onclick: () => pick(i) },
          h('span.n', {}, `${i + 1}/7`), h('span.t', {}, NAMES[i]), h('span.bead', { 'aria-hidden': 'true' }, h('i')), h('span.y', {}, YIELDS[i]));
      }));
  }

  private render(card: OporaCard | undefined, lane: Lane | undefined, worker: string | undefined) {
    const r = this.reply;
    const input: StageInput = { status: card?.status, stage: card?.stage, phase: lane?.phase ?? 0, moved: !!lane && lane.marker !== 'none', branch: lane?.branch, pr: lane?.pr, working: !!lane?.working,
      preview: r?.state === 'ok' ? r : r ? { ...r, heads: [] } : undefined };
    const key = JSON.stringify([card ?? null, input, worker ?? null, this.picked ?? null, this.failed, !!this.playing]);
    if (key === this.drawn) return;
    this.drawn = key;
    if (!card) { this.root.replaceChildren(h('p.pw-empty', {}, 'Vyber kartu na pravé tabuli: tady pak bude, jak její návrh prochází sedmi etapami.')); return; }
    const head = h('div.oc-dr-h', {},
      h('div.oc-dr-meta', {}, h('span', { class: `oc-tag${isDesign(card) ? ' acc' : ''}` }, isDesign(card) ? 'design' : card.profile || 'bez pipeline'), card.sectorName ? h('span.oc-tag', {}, card.sectorName) : null),
      h('h2', {}, card.name));
    if (!isDesign(card)) {
      this.root.replaceChildren(head, h('div.oc-dr-b', {},
        h('div.oc-flow', {}, h('div.oc-flow-h', {}, h('b', {}, 'Kde karta je'), h('span', {}, 'sedm etap návrhu se jí netýká')), this.rail(0, -1, true, () => undefined)),
        h('div.oc-sent', {}, `Karta není na design pipeline (${card.profile ? `profil ${card.profile}` : 'zatím bez pipeline'}, desky vývoje). Etapy Zadání → Skica → Storyboard → Implementace → Kontroly → Review → Hotovo, náhled a brand patří jen design kartám. Jak karta stojí, ukazuje záložka Lens (návrh 1).`)));
      return;
    }
    if (!r) {
      this.root.replaceChildren(head, h('div.oc-dr-b', {}, h('span.pw-note', {}, this.failed ? 'Náhled se nepodařilo načíst z kanceláře.' : 'Načítám náhled karty z Opory…')));
      return;
    }
    if (!r.linked) { this.root.replaceChildren(head, h('div.oc-dr-b', {}, h('span.pw-note', {}, 'Patro není propojené s projektem Opory.'))); return; }
    const stage = designStage(input);
    if (this.picked !== undefined && this.picked > stage) this.picked = undefined;
    const shown = this.picked ?? stage;
    const pick = (i: number) => { this.stop(); this.picked = i === stage ? undefined : i; this.render(card, lane, worker); };
    const hd = shownHead(r);
    const [sentence, tone] = turnSentence(stage, worker, !!hd?.confirmed);
    const href = previewUrl(r.base ?? this.base(), card.id);
    const play = h('button.btn.small', { type: 'button', 'aria-pressed': String(!!this.playing), onclick: () => this.togglePlay(stage, card, lane, worker) }, this.playing ? '❚❚ Zastavit' : '▶ Projít etapy');
    const ev = evidence(input, shown === stage ? stage : shown);
    const explore = r.mode === 'explore';
    const box = r.state === 'ok' || r.sketch || r.drawing
      ? preview({ floor: this.floor, card: card.id, r: input.preview!, stage: shown, cut: this.cut, setCut: (v) => { this.cut = v; } })
      : h('div.dp-calm', { role: 'status' }, h('b', {}, 'Náhled zatím není k dispozici.'), h('span', {}, r.state === 'missing' ? ' Tahle Opora ho ještě neumí vydat.' : ' Opora teď neodpovídá, zkusím to znovu.'));
    box.classList.add('oc-swap');
    this.root.replaceChildren(head, h('div.oc-dr-b', {},
      h('div.oc-mrow', {}, r.state === 'ok' ? modeChip(r.mode) : null, h('p.oc-otxt', {}, explore
        ? 'Experiment: záměrně ignoruje současný brand a navrhuje nový. Brand projektu se mění až přijetím v Opoře.'
        : 'Staví podle DESIGN.md projektu: stejné písmo, barvy a komponenty.'), play),
      h('div.oc-flow', {}, h('div.oc-flow-h', {}, h('b', {}, 'Kde karta je'), h('span', {}, `${stage + 1}. ${NAMES[stage]} · ${sentence}`)), this.rail(stage, shown, false, pick)),
      h('div.oc-grid', {},
        h('div.oc-box.oc-big', {}, box),
        h('aside.oc-aside', {},
          h('div.oc-box', {}, h('div.oc-box-h', {}, 'Brand projektu', h('span.src', {}, 'DESIGN.md')), h('div.oc-box-b', {}, r.state === 'ok' ? brandPanel(r) : h('span.pw-note', {}, 'Brand se čte s náhledem.'))),
          h('div.oc-box', {}, h('div.oc-box-h', {}, 'Důkazy náhledu'), h('div.oc-box-b.oc-slots', { role: 'list' }, ...ev.map((e) =>
            h('div', { class: `oc-slot ${e.state}`, role: 'listitem', title: SLOT_TITLE[e.state] }, h('span.q', { 'aria-hidden': 'true' }), h('span.l', {}, e.name), h('span.r', {}, e.state === 'none' ? 'chybí' : e.note ?? SLOT_TITLE[e.state]))))),
          h('div', { class: `oc-sent ${tone}` }, sentence),
          h('div.oc-btns', {},
            stage === 6 && hd?.confirmed ? h('button.oc-obtn', { type: 'button', disabled: true }, 'Vzhled potvrzen') : link(href, 'Potvrdit vzhled v Opoře ↗', 'oc-obtn', stage === 5),
            explore && stage === 6 ? link(href, 'Přijmout jako nový brand ↗', 'oc-obtn') : null,
            link(href, 'Komentovat snímek ↗', 'oc-obtn ghost')),
          h('p.oc-otxt', {}, stage === 5 ? 'Potvrzením v Opoře přidáš doklad „Potvrzeno člověkem“ k tomuto commitu.' : stage < 3 ? 'Náhled se plní z karty: kresba, storyboard, obrázky z bloků.' : stage === 6 ? 'Screenshoty zůstávají u karty i po uzavření.' : 'Náhled se obnoví s každým novým screenshotem od agenta.'),
          lane?.branch || lane?.pr ? h('p.oc-otxt.oc-links', {}, [lane.branch ? `větev ${lane.branch}` : '', lane.pr ? `PR #${lane.pr}` : ''].filter(Boolean).join(' · ')) : null))));
  }

  /** Replays the stages the card went through, one by one, up to where it is. */
  private togglePlay(stage: number, card: OporaCard, lane: Lane | undefined, worker: string | undefined) {
    if (this.playing) { this.stop(); this.picked = undefined; this.render(card, lane, worker); return; }
    let i = 0;
    this.picked = 0;
    this.playing = setInterval(() => {
      i++;
      if (i > stage) { this.stop(); this.picked = undefined; } else this.picked = i === stage ? undefined : i;
      this.drawn = '';
      this.render(card, lane, worker);
    }, 1600);
    this.drawn = '';
    this.render(card, lane, worker);
  }
}

import { PIPELINE } from './pipeline-model';
import type { StudioState } from './model';
import { $, dom } from './panels';
import './pipeline.css';

/** Projection of the same replayable state as the graph, never a second timer. */
export class DeliveryPipeline {
  private selected: string | null = null;
  private state?: StudioState;
  private buttons = new Map<string, HTMLButtonElement>();
  constructor() {
    const host = $('#delivery-lanes');
    for (const phase of new Set(PIPELINE.map(step => step.phase))) {
      const lane = dom('section', 'delivery-lane'); lane.append(dom('h3', '', phase));
      for (const step of PIPELINE.filter(step => step.phase === phase)) {
        const button = dom('button', 'delivery-step'); button.type = 'button'; button.dataset.stage = step.id;
        button.append(dom('span', 'delivery-status', '○'), dom('span', '', step.title));
        button.addEventListener('click', () => { this.selected = step.id; if (this.state) this.update(this.state); });
        this.buttons.set(step.id, button); lane.append(button);
      }
      host.append(lane);
    }
    $('#pipeline-follow').addEventListener('click', () => { this.selected = null; if (this.state) this.update(this.state); });
  }
  update(s: StudioState) {
    this.state = s;
    const next = PIPELINE[s.pipeline.length];
    const selected = PIPELINE.find(step => step.id === this.selected) ?? next ?? PIPELINE[PIPELINE.length - 1];
    $('#pipeline-progress').textContent = `${s.pipeline.length} / ${PIPELINE.length} předání doloženo v ukázce`;
    $<HTMLProgressElement>('#pipeline-meter').value = s.pipeline.length;
    $<HTMLProgressElement>('#pipeline-meter').max = PIPELINE.length;
    for (const step of PIPELINE) {
      const button = this.buttons.get(step.id)!;
      const done = s.pipeline.includes(step.id), current = next?.id === step.id;
      button.classList.toggle('done', done); button.classList.toggle('current', current);
      button.classList.toggle('selected', selected.id === step.id);
      button.setAttribute('aria-pressed', String(selected.id === step.id));
      button.setAttribute('aria-label', `${step.title}: ${done ? 'doloženo v modelu' : current ? 'čeká na vstup / další událost' : 'čeká na předchozí kroky'}`);
      button.firstElementChild!.textContent = done ? '✓' : current ? '◉' : '○';
    }
    const detail = $('#pipeline-detail'); detail.replaceChildren();
    const heading = dom('div'); heading.append(dom('p', 'eyebrow', selected.phase + ' / ' + selected.owner), dom('h3', '', selected.title));
    detail.append(heading);
    for (const [label, value] of [['VSTUP', selected.input], ['VÝSTUP', selected.output], ['PODMÍNKA PŘEDÁNÍ', selected.gate]]) {
      const block = dom('div'); block.append(dom('span', 'pane-label', label), dom('p', '', value)); detail.append(block);
    }
    $('#delivery-chain').textContent = s.merged
      ? 'PR #214 · modelově sloučeno → UI / další moduly · navazující PR nejsou v této ukázce provedené'
      : s.prRevision ? 'PR #214 · kontrakt → UI · čeká na kontrakt → další modul · čeká na rozhraní'
      : 'Plán závislostí: kontrakt událostí → UI kanceláře → další repozitáře';
  }
}

// The small pieces of "Jak to bude vypadat": the stage dots, the read-only mode chip, the brand panel
// (fonts and swatches of DESIGN.md) and the evidence chips. Everything from Opora goes in as text, a
// validated hex colour, or a validated font family name.

import { h } from '../../ui/dom';
import type { DesignBrand, DesignMode, OporaPreviewReply } from '../../../shared/opora-preview';
import { shownHead, STAGES, type Evidence } from './stage';

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const FONT = /^[\p{L}\p{N}][\p{L}\p{N} -]{0,39}$/u;

/** Seven dots on a track: done ones filled, the current one marked; a click shows that stage's preview. */
export function track(stage: number, shown: number, pick: (i: number) => void): HTMLElement {
  const el = h('div.dp-trk', { role: 'group', 'aria-label': `Etapa ${stage + 1} ze 7: ${STAGES[stage].short}` });
  el.style.setProperty('--at', String(stage / 6));
  el.append(h('span.fill', { 'aria-hidden': 'true' }));
  STAGES.forEach((s, i) => {
    const cls = ['dp-st', i < stage || stage === 6 ? 'done' : '', i === stage && stage !== 6 ? 'cur' : '', i === shown ? 'shown' : ''].filter(Boolean).join(' ');
    el.append(h('button', {
      type: 'button', class: cls, disabled: i > stage, 'aria-pressed': String(i === shown), ...(i === stage ? { 'aria-current': 'step' } : {}),
      title: i > stage ? `${s.short}: ještě nedošla` : `Ukázat etapu ${s.short}`, onclick: () => pick(i),
    }, h('span.dot', {}, String(i + 1)), h('span.lb', {}, s.short)));
  });
  return el;
}

/** The mode as Opora has it. Read-only: only a person changes it, in Opora. */
export function modeChip(mode: DesignMode): HTMLElement {
  const seg = (m: DesignMode, label: string) => h('span', { class: `dp-m${m === mode ? ' on' : ''}`, ...(m === mode ? { 'aria-current': 'true' } : {}) }, label);
  return h('div.dp-mode-row', {},
    h('div.dp-mode', { role: 'group', 'aria-label': 'Směr návrhu (mění jen člověk v Opoře)', title: 'Režim mění jen člověk v Opoře' }, seg('brand', 'Podle brandu'), seg('explore', 'Nový směr')),
    h('span.pw-note', {}, mode === 'brand' ? 'podle DESIGN.md' : 'experiment mimo brand'));
}

function brandRow(label: string, b?: DesignBrand): HTMLElement {
  const row = h('div.dp-br', {}, h('span.lab', {}, label));
  const font = b?.fonts.find((f) => FONT.test(f));
  if (font) {
    const f = h('span.dp-fnt', { title: `Písmo ${font}` }, `Aa ${font}`);
    f.style.fontFamily = `"${font}", var(--font)`;
    row.append(f);
  }
  for (const c of b?.colors ?? []) {
    if (!HEX.test(c.hex)) continue;
    const sq = h('span.dp-sq', { title: c.name ? `${c.name} ${c.hex}` : c.hex, role: 'img', 'aria-label': c.name ? `${c.name} ${c.hex}` : c.hex });
    sq.style.background = c.hex;
    row.append(sq);
  }
  if (!font && !b?.colors.length) row.append(h('span.pw-note', {}, 'písmo ani barvy nenalezeny'));
  return row;
}

const rev = (v?: string) => (v ? v.slice(0, 7) : '');

/** DESIGN.md as fonts and swatches; on an explore card, now and the card's proposal under it. */
export function brandPanel(r: OporaPreviewReply): HTMLElement {
  const ds = r.designSystem, head = shownHead(r);
  const explore = r.mode === 'explore';
  const el = h('div', { class: `dp-brand${explore ? ' exp' : ''}`, 'aria-label': 'Brand projektu' });
  if (!ds?.available) {
    el.append(h('div.dp-br', {}, h('span.lab', {}, explore ? 'Teď' : 'Brand'), h('span.pw-note', {}, 'Projekt zatím nemá DESIGN.md.')));
  } else el.append(brandRow(explore ? 'Teď' : 'Brand', ds.brand));
  if (explore) el.append(head?.proposed ? brandRow('Návrh', head.proposed) : h('div.dp-br', {}, h('span.lab', {}, 'Návrh'), h('span.pw-note', {}, 'zatím žádný návrh DESIGN.md')));
  const line = h('span.dp-rev');
  if (ds?.available) {
    line.append('DESIGN.md · rev ', h('b', {}, rev(ds.revision) || '?'));
    if (ds.truncated) line.append(' · zkráceno');
    if (explore) line.append(head?.proposed ? ' → návrh (jen na kartě)' : '');
  } else line.append('DESIGN.md');
  el.append(line);
  return el;
}

const TITLE: Record<Evidence['state'], string> = { full: 'doloženo', human: 'potvrzeno člověkem', half: 'deklarováno bez dokladu', none: 'chybí' };

export function evidenceChips(ev: Evidence[]): HTMLElement {
  return h('div.dp-ev', { role: 'list', 'aria-label': 'Důkazy náhledu' }, ...ev.map((e) =>
    h('span', { class: `dp-e ${e.state}`, role: 'listitem', title: TITLE[e.state] }, h('i', { 'aria-hidden': 'true' }), e.name, e.note && e.state !== 'none' ? h('span.n', {}, ` ${e.note}`) : null)));
}

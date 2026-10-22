// The pieces around the Lens diagram (features/lens/diagram.ts): the plan's progress, the legend,
// the "Vazby jako text" fallback, and how a card and an edge are classed. Spec text only ever goes in
// as text (h() children are text nodes), never as markup.

import { h } from '../../ui/dom';
import type { LensDelta, LensEdge, LensNode, PlanLens } from '../../../shared/opora-lens';
import type { LensLayout } from './layout';

export type Mode = 'pr' | 'plan';
export type Status = 'done' | 'code' | 'plan' | 'ext';

export const DELTA: Record<LensDelta, [string, string]> = { added: ['+', 'přidáno'], modified: ['~', 'změněno'], removed: ['−', 'odebráno'], unchanged: ['=', 'beze změny'] };
export const STATUS: Record<Status, string> = { done: 'potvrzeno člověkem', code: 'kód existuje', plan: 'jen v plánu', ext: 'sousední oblast' };
/** Badges the plan view shows as the card's look instead of as a chip. */
const PLAN_MARKS = new Set(['plán', 'hotovo']);

const SVGNS = 'http://www.w3.org/2000/svg';
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** A plan card's evidence: a human closed it (`hotovo`), only planned (`plán`, no code), its code exists, or a neighbour area. */
export function planStatus(n: LensNode): Status {
  if (n.badges.includes('hotovo')) return 'done';
  if (n.badges.includes('plán')) return 'plan';
  if (n.kind === 'external') return 'ext';
  return n.delta === 'added' ? 'plan' : 'code';
}

export const shownBadges = (n: LensNode, mode: Mode) => (mode === 'plan' ? n.badges.filter((b) => !PLAN_MARKS.has(b)) : n.badges);

export function cardClass(n: LensNode, mode: Mode): string {
  return mode === 'plan' ? `s-${planStatus(n)}` : n.delta;
}

export function edgeClass(e: LensEdge, mode: Mode, node: (id: string) => LensNode | undefined): string {
  if (e.code) return 'm-code';
  if (mode === 'plan') {
    const a = node(e.from), b = node(e.to);
    return (a && planStatus(a) === 'plan') || (b && planStatus(b) === 'plan') ? 'm-plan' : 'm-done';
  }
  return `d-${e.delta}${e.hero ? ' hero' : ''}`;
}

export const deltaMark = (d: LensDelta) => h('span', { class: `lens-d ${d}`, 'aria-hidden': 'true' }, DELTA[d][0]);

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

/**
 * How far the plan is, in the evidence Opora has: code exists (`withCode`) and a human confirmed
 * it (`hotovo`). What agents claim isn't measured yet, so that row says so instead of a number.
 */
export function progress(plan: PlanLens): HTMLElement | null {
  const st = plan.stats, n = st?.cards;
  if (!st || !n) return null;
  const levels: [string, string, number | undefined][] = [['code', 'Kód existuje', st.withCode], ['human', 'Potvrzeno člověkem', st.confirmed]];
  const known = levels.filter((l): l is [string, string, number] => l[2] !== undefined);
  const bar = h('div.lx-bar', { role: 'img', 'aria-label': known.map(([, l, v]) => `${l} ${pct(v, n)} %`).join(', ') },
    ...known.map(([c, , v]) => h(`i.${c}`, { style: `width: ${pct(v, n)}%` })));
  const rows = h('div.lx-lv', {},
    h('span.sw.claim'), h('span.off', {}, 'Agent tvrdí'), h('span.n', {}, '—'), h('span.pc.off', {}, 'zatím neměřeno'),
    ...levels.flatMap(([c, l, v]) => [h(`span.sw.${c}`), h('span', {}, l), h('span.n', {}, v === undefined ? '—' : `${v}/${n}`), h('span.pc', {}, v === undefined ? '?' : `${pct(v, n)} %`)]));
  const notes: HTMLElement[] = [];
  if (st.planned) notes.push(h('p.lx-gap', {}, `Jen v plánu, bez kódu v main: ${st.planned}.`));
  if (plan.graphify && !plan.graphify.available) notes.push(h('p.lx-gap.muted', {}, 'Graphify mapa není k dispozici, vazby z kódu chybí.'));
  return h('div.lx-prog', {},
    h('div.lx-prog-h', {}, h('b', {}, plan.area ? 'Hotovo v oblasti' : 'Hotovo v projektu'), h('span', {}, `${n} karet`)),
    bar, rows, ...notes);
}

function line(cls: string): SVGSVGElement {
  const sv = s('svg', { width: 22, height: 8, 'aria-hidden': 'true' });
  const g = s('g', { class: `lx-e ${cls}` });
  g.append(s('path', { class: 'ln', d: 'M1 4H21' }));
  sv.append(g);
  return sv;
}

export function legend(mode: Mode, L: LensLayout, codeShown: boolean): HTMLElement {
  const box = (c: string, t: string) => h('span', {}, h(`span.bx.${c}`), t);
  const items = mode === 'plan'
    ? [box('s-done', 'potvrzeno'), box('s-code', 'kód existuje'), box('s-plan', 'jen v plánu'), h('span', {}, line('m-plan'), 'vazba v plánu')]
    : [...(Object.keys(DELTA) as LensDelta[]).map((d) => box(d, DELTA[d][1])), h('span', {}, line('d-added hero'), 'hlavní tok')];
  if (codeShown) items.push(h('span', {}, line('m-code'), 'kód (Graphify)'));
  if (L.hidden) items.push(h('span', {}, `skryto ${L.hidden} beze změny`));
  return h('div.lx-leg', { 'aria-label': 'Legenda' }, ...items);
}

/** The shown edges as a plain list, for screen readers and for anyone who'd rather read. */
export function textList(L: LensLayout, name: (id: string) => string): HTMLElement {
  return h('details.lx-txt', {}, h('summary', {}, `Vazby jako text · ${L.edges.length}`),
    h('ul', {}, ...L.edges.map((x) => h('li', {}, `${name(x.e.from)} → ${name(x.e.to)}`, x.e.label ? h('span.l', {}, ` · ${x.e.label}`) : null))));
}

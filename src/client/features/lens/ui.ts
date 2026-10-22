// The Lens section of the process wall's card inspector: the card's PR Lens (the change), its area
// map, and its area's plan Lens, as Opora keeps them (GET /api/opora-lens), one at a time behind
// small tabs, and a link that opens the card's Lens in Opora. A spec is data agents wrote: it is
// drawn as text in elements of our own, never as HTML or SVG markup.

import { h } from '../../ui/dom';
import { oporaLensUrl, type LensDelta, type LensGraph, type LensView, type OporaLensReply } from '../../../shared/opora-lens';
import './ui.css';

const DELTA: Record<LensDelta, [string, string]> = { added: ['+', 'přidáno'], modified: ['~', 'změněno'], removed: ['−', 'odebráno'], unchanged: ['=', 'beze změny'] };
const ABSENT: Record<string, string> = {
  none: 'Opora k ní zatím nic nemá.',
  missing: 'Tahle Opora ji ještě neumí vydat (404).',
  unavailable: 'Opora teď neodpovídá.',
};

type ViewId = 'pr' | 'area' | 'plan';
interface Shown { id: ViewId; label: string; view?: LensView; meta: string[]; absent?: string }

const badge = (d: LensDelta) => h('span', { class: `lens-d ${d}`, title: DELTA[d][1] }, DELTA[d][0]);

/** One graph: its title and summary, the lanes with their cards, the edges and the flows. */
export function graphEl(g: LensGraph): HTMLElement {
  const root = h('div.lens-graph', {}, h('div.lens-title', {}, g.title));
  if (g.summary) root.append(h('p.lens-sum', {}, g.summary));
  const lanes = h('div.lens-lanes');
  for (const lane of g.lanes) {
    const cards = h('div.lens-cards');
    for (const n of lane.nodes) {
      cards.append(h('div', { class: `lens-card ${n.delta}`, title: n.summary ?? '' },
        h('div.lens-ch', {}, badge(n.delta), h('b', {}, n.label), h('span.kd', {}, n.kind)),
        ...n.files.map((f) => h('code.lens-file', { title: f.path }, f.path, f.lines ? `:${f.lines}` : '')),
        n.badges.length ? h('div.lens-badges', {}, ...n.badges.map((b) => h('span', {}, b))) : null));
    }
    lanes.append(h('div.lens-lane', {}, h('div.lens-lh', {}, lane.delta ? badge(lane.delta) : null, lane.label), lane.nodes.length ? cards : h('span.pw-note', {}, 'bez karet')));
  }
  root.append(lanes);
  if (g.edges.length) {
    root.append(h('div.lens-k', {}, `Vazby · ${g.edges.length}`), h('ul.lens-edges', {}, ...g.edges.map((e) =>
      h('li', { class: e.hero ? 'hero' : '' }, badge(e.delta), h('span', {}, `${e.from} → ${e.to}`), h('span.kd', {}, e.kind), e.label ? h('span.lbl', {}, e.label) : null))));
  }
  for (const f of g.flows) {
    root.append(h('div.lens-k', {}, `Tok · ${f.title}`), h('ol.lens-flow', {}, ...f.steps.map((s) => h('li', {}, s))));
  }
  if (g.truncated) root.append(h('p.pw-note', {}, 'Zkráceno — celý diagram je v Opoře.'));
  return root;
}

function shown(r: OporaLensReply): Shown[] {
  const out: Shown[] = [];
  const pr = r.card.pr;
  out.push({ id: 'pr', label: 'Změna (PR)', view: pr, absent: pr ? undefined : r.card.state === 'ok' ? ABSENT.none : ABSENT[r.card.state],
    meta: pr ? [pr.number ? `PR #${pr.number}` : '', pr.prState ?? '', pr.current === false ? 'Lens je ze starší verze' : pr.current ? 'aktuální head' : '', pr.by ? `kreslil ${pr.by}` : ''].filter(Boolean) : [] });
  const area = r.card.area;
  out.push({ id: 'area', label: 'Mapa oblasti', view: area, absent: area ? undefined : r.card.state === 'ok' ? ABSENT.none : ABSENT[r.card.state],
    meta: area ? [area.acceptedRevision !== undefined ? `plán rev. ${area.acceptedRevision}` : '', area.by ? `kreslil ${area.by}` : ''].filter(Boolean) : [] });
  const plan = r.plan;
  out.push({ id: 'plan', label: 'Plán oblasti', view: plan.view, absent: plan.view ? undefined : ABSENT[plan.state === 'ok' ? 'none' : plan.state],
    meta: [plan.area ? `oblast ${plan.area}` : '', ...Object.entries(plan.stats ?? {}).map(([k, v]) => `${k} ${v}`), plan.digest ? `otisk ${plan.digest.slice(0, 12)}` : ''].filter(Boolean) });
  return out;
}

/** The Lens section of one card, kept while the window redraws, refreshed when asked and older than 30 s. */
export class LensSection {
  readonly root = h('section.pw-sec.lens', { 'aria-label': 'PR Lens' });
  private tabs = h('div.lens-tabs', { role: 'tablist', 'aria-label': 'Diagram' });
  private body = h('div.lens-body', {}, h('span.pw-note', {}, 'Načítám Lens z Opory…'));
  private link = h('a.lens-open', { target: '_blank', rel: 'noopener noreferrer', hidden: true }, 'Otevřít v Opoře ↗');
  private reply?: OporaLensReply;
  private pick?: ViewId;
  private at = 0;
  private loading?: AbortController;

  constructor(private floor: string, private card: string, private area: () => string | undefined, private base: () => string | undefined) {
    this.root.append(h('div.lens-top', {}, h('span.k', {}, 'Lens'), this.tabs, this.link), this.body);
    this.setLink(base());
  }

  /** Reads again unless the last answer is younger than 30 s (or still on its way). */
  refresh(now = Date.now()) {
    if (this.loading || now - this.at < 30_000) return;
    this.at = now;
    const ctl = (this.loading = new AbortController());
    const area = this.area();
    const q = new URLSearchParams({ floor: this.floor, card: this.card, ...(area ? { area } : {}) });
    fetch(`/api/opora-lens?${q}`, { signal: ctl.signal, cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<OporaLensReply>) : Promise.reject(new Error(String(r.status)))))
      .then((reply) => { this.reply = reply; this.render(); })
      .catch(() => { if (!ctl.signal.aborted && !this.reply) this.body.replaceChildren(h('span.pw-note', {}, 'Lens se nepodařilo načíst z kanceláře.')); })
      .finally(() => { if (this.loading === ctl) this.loading = undefined; });
  }

  destroy() { this.loading?.abort(); }

  private setLink(base?: string) {
    const href = oporaLensUrl(base, this.card);
    this.link.hidden = !href;
    if (href) this.link.setAttribute('href', href);
  }

  private render() {
    const r = this.reply!;
    this.setLink(r.base ?? this.base());
    if (!r.linked) {
      this.tabs.replaceChildren();
      this.body.replaceChildren(h('span.pw-note', {}, 'Patro není propojené s projektem Opory.'));
      return;
    }
    const views = shown(r);
    this.pick ??= views.find((v) => v.view)?.id ?? 'pr';
    this.tabs.replaceChildren(...views.map((v) => h('button', {
      type: 'button', role: 'tab', class: `lens-tab${v.id === this.pick ? ' on' : ''}${v.view ? '' : ' empty'}`, 'aria-selected': String(v.id === this.pick),
      onclick: () => { this.pick = v.id; this.render(); },
    }, v.label)));
    const v = views.find((x) => x.id === this.pick)!;
    const body: Node[] = [];
    if (v.meta.length) body.push(h('div.lens-meta', {}, v.meta.join(' · ')));
    if (!v.view) body.push(h('span.pw-note', {}, v.absent ?? ABSENT.none));
    else if (v.view.graph) body.push(graphEl(v.view.graph));
    else body.push(h('span.pw-note', {}, v.view.note ?? 'Diagram nejde zobrazit.'));
    this.body.replaceChildren(...body);
  }
}

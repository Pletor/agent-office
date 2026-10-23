// The Lens section of the process wall's card inspector: the card's PR Lens (the change), its area
// map, and its area's plan Lens, as Opora keeps them (GET /api/opora-lens), one at a time behind
// small tabs, each drawn as a diagram (diagram.ts), and a link that opens the card's Lens in Opora.
// A spec is data agents wrote: it goes into elements of our own as text, never as HTML or SVG markup.

import { h } from '../../ui/dom';
import { oporaLensUrl, type LensView, type OporaLensReply, type PlanLens } from '../../../shared/opora-lens';
import { LensDiagram } from './diagram';
import './ui.css';

const ABSENT: Record<string, string> = {
  none: 'Opora k ní zatím nic nemá.',
  missing: 'Tahle Opora ji ještě neumí vydat (404).',
  unavailable: 'Opora nedostupná: teď neodpovídá.',
};
/** What "nothing recorded" means on each tab, in words. */
const NONE = { pr: 'Karta zatím nemá PR Lens.', area: 'Karta zatím nemá mapu oblasti.', plan: 'Oblast karty zatím nemá plán Lens.' };

type ViewId = 'pr' | 'area' | 'plan';
interface Shown { id: ViewId; label: string; view?: LensView; meta: string[]; absent?: string; plan?: PlanLens }

function shown(r: OporaLensReply): Shown[] {
  const out: Shown[] = [];
  const pr = r.card.pr;
  out.push({ id: 'pr', label: 'Změna (PR)', view: pr, absent: pr ? undefined : r.card.state === 'ok' || r.card.state === 'none' ? NONE.pr : ABSENT[r.card.state],
    meta: pr ? [pr.number ? `PR #${pr.number}` : '', pr.prState ?? '', pr.current === false ? 'Lens je ze starší verze' : pr.current ? 'aktuální head' : '', pr.by ? `kreslil ${pr.by}` : ''].filter(Boolean) : [] });
  const area = r.card.area;
  out.push({ id: 'area', label: 'Mapa oblasti', view: area, absent: area ? undefined : r.card.state === 'ok' || r.card.state === 'none' ? NONE.area : ABSENT[r.card.state],
    meta: area ? [area.acceptedRevision !== undefined ? `plán rev. ${area.acceptedRevision}` : '', area.by ? `kreslil ${area.by}` : ''].filter(Boolean) : [] });
  const plan = r.plan;
  out.push({ id: 'plan', label: 'Plán oblasti', view: plan.view, absent: plan.view ? undefined : plan.state === 'ok' || plan.state === 'none' ? NONE.plan : ABSENT[plan.state],
    plan, meta: [plan.area ? `oblast ${plan.area}` : '', plan.digest ? `otisk ${plan.digest.slice(0, 12)}` : '', plan.graphify?.sourceRevision ? `Graphify ${plan.graphify.sourceRevision.slice(0, 12)}` : ''].filter(Boolean) });
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
  /** One diagram per tab, kept while its graph is the same, so playback and switches survive a refresh. */
  private diagrams = new Map<ViewId, { key: string; d: LensDiagram }>();

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

  destroy() {
    this.loading?.abort();
    for (const { d } of this.diagrams.values()) d.destroy();
    this.diagrams.clear();
  }

  private diagram(v: Shown, g: NonNullable<LensView['graph']>): LensDiagram {
    const key = JSON.stringify([g, v.plan?.stats ?? null, v.plan?.graphify ?? null, v.plan?.area ?? null]);
    const had = this.diagrams.get(v.id);
    if (had?.key === key) return had.d;
    had?.d.destroy();
    const d = new LensDiagram(g, v.id === 'plan' ? 'plan' : 'pr', v.plan);
    this.diagrams.set(v.id, { key, d });
    return d;
  }

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
    else if (v.view.graph) {
      const g = v.view.graph;
      body.push(h('div.lens-title', {}, g.title));
      if (g.summary) body.push(h('p.lens-sum', {}, g.summary));
      body.push(this.diagram(v, g).root);
      if (g.truncated) body.push(h('p.pw-note', {}, 'Zkráceno — celý diagram je v Opoře.'));
    }
    else body.push(h('span.pw-note', {}, v.view.note ?? 'Diagram nejde zobrazit.'));
    this.body.replaceChildren(...body);
  }
}

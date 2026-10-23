// The plan Lens of the floor's whole Opora project (GET /api/opora-plan-lens), drawn with the Lens
// feature's diagram in plan mode. Asked again only when the last answer is older than 30 s, so the
// window's redraw on every event doesn't ask Opora each time. Every reason for no diagram is said.

import { h } from '../../ui/dom';
import type { OporaPlanReply } from '../../../shared/opora-plan';
import { LensDiagram } from '../lens/diagram';

const ABSENT = {
  none: 'Projekt zatím nemá plán Lens: Opora k němu nic nevydala.',
  missing: 'Tahle Opora plán projektu ještě neumí vydat (404).',
  unavailable: 'Opora nedostupná: teď neodpovídá. Zkusím to znovu za chvíli.',
} as const;

/** Opora's own address as a link, only plain http(s) without credentials. */
function oporaHome(base?: string): string | undefined {
  if (!base) return undefined;
  try {
    const u = new URL(base);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password ? new URL('/', u.origin).href : undefined;
  } catch {
    return undefined;
  }
}

export class ProjectPlan {
  readonly root = h('section.pw-sec.lens.op-plan', { 'aria-label': 'Plán projektu' });
  private link = h('a.lens-open', { target: '_blank', rel: 'noopener noreferrer', hidden: true }, 'Otevřít v Opoře ↗');
  private body = h('div.lens-body', {}, h('span.pw-note', {}, 'Načítám plán projektu z Opory…'));
  private reply?: OporaPlanReply;
  private failed = false;
  private floor?: string;
  private at = 0;
  private loading?: AbortController;
  private diagram?: { key: string; d: LensDiagram };

  constructor() {
    this.root.append(h('div.lens-top', {}, h('span.k', {}, 'Plán projektu'), this.link), this.body);
  }

  /** Reads the floor's plan unless the last answer for it is younger than 30 s (or still on its way). */
  refresh(floor: string | null | undefined, now = Date.now()) {
    if (!floor) { this.note('Nejste na žádném patře.'); return; }
    if (floor !== this.floor) { this.loading?.abort(); this.loading = undefined; this.floor = floor; this.reply = undefined; this.failed = false; this.at = 0; }
    if (this.loading || now - this.at < 30_000) return;
    this.at = now;
    const ctl = (this.loading = new AbortController());
    fetch(`/api/opora-plan-lens?${new URLSearchParams({ floor })}`, { signal: ctl.signal, cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<OporaPlanReply>) : Promise.reject(new Error(String(r.status)))))
      .then((reply) => { this.reply = reply; this.failed = false; this.render(); })
      .catch(() => { if (!ctl.signal.aborted && !this.reply) { this.failed = true; this.render(); } })
      .finally(() => { if (this.loading === ctl) this.loading = undefined; });
  }

  destroy() {
    this.loading?.abort();
    this.diagram?.d.destroy();
    this.diagram = undefined;
  }

  private note(text: string) { this.body.replaceChildren(h('span.pw-note', {}, text)); }

  private render() {
    const r = this.reply;
    const home = oporaHome(r?.base);
    this.link.hidden = !home;
    if (home) this.link.setAttribute('href', home);
    if (!r) { this.note(this.failed ? 'Plán se nepodařilo načíst z kanceláře.' : 'Načítám plán projektu z Opory…'); return; }
    if (!r.linked) { this.note('Patro není propojené s projektem Opory, takže není čí plán ukázat.'); return; }
    const p = r.plan, g = p.view?.graph;
    if (p.state !== 'ok') { this.note(ABSENT[p.state]); return; }
    const meta = [r.project ? `projekt ${r.project}` : '', p.digest ? `otisk ${p.digest.slice(0, 12)}` : '', p.graphify?.sourceRevision ? `Graphify ${p.graphify.sourceRevision.slice(0, 12)}` : ''].filter(Boolean);
    const out: Node[] = [];
    if (meta.length) out.push(h('div.lens-meta', {}, meta.join(' · ')));
    if (!g) {
      out.push(h('span.pw-note', {}, p.view?.note ?? 'Opora poslala plán, ale ne jako diagram, který jde zobrazit.'));
      this.body.replaceChildren(...out);
      return;
    }
    const key = JSON.stringify([g, p.stats ?? null, p.graphify ?? null]);
    if (this.diagram?.key !== key) { this.diagram?.d.destroy(); this.diagram = { key, d: new LensDiagram(g, 'plan', p) }; }
    out.push(h('div.lens-title', {}, g.title));
    if (g.summary) out.push(h('p.lens-sum', {}, g.summary));
    out.push(this.diagram.d.root);
    if (g.truncated) out.push(h('p.pw-note', {}, 'Zkráceno: celý plán je v Opoře.'));
    this.body.replaceChildren(...out);
  }
}

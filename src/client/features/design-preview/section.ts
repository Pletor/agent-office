// "Jak to bude vypadat": the section of a design card in the process wall's card inspector. Where the
// card is (seven stage dots), its mode (read-only, a person changes it in Opora), the project's brand,
// the preview for the stage, and the evidence it has. Read from the office (GET /api/opora-preview),
// which reads Opora; an Opora without the endpoint gets a calm note instead.

import { h } from '../../ui/dom';
import { oporaLensUrl } from '../../../shared/opora-lens';
import type { OporaPreviewReply } from '../../../shared/opora-preview';
import { brandPanel, evidenceChips, modeChip, track } from './parts';
import { designStage, evidence, type StageInput } from './stage';
import { preview } from './view';
import './ui.css';

/** The card's link in Opora, on its preview tab. */
function oporaPreviewUrl(base: string | undefined, card: string): string | undefined {
  const lens = oporaLensUrl(base, card);
  if (!lens) return undefined;
  const u = new URL(lens);
  u.searchParams.set('ohTab', 'preview');
  return u.href;
}

export class DesignPreviewSection {
  readonly root = h('section.pw-sec.dp', { 'aria-label': 'Jak to bude vypadat' });
  private body = h('div.dp-body', {}, h('span.pw-note', {}, 'Načítám náhled z Opory…'));
  private link = h('a.dp-open', { target: '_blank', rel: 'noopener noreferrer', hidden: true }, 'Otevřít v Opoře ↗');
  private reply?: OporaPreviewReply;
  private failed = false;
  private at = 0;
  private loading?: AbortController;
  private input?: Omit<StageInput, 'preview'>;
  /** The stage whose preview is shown, when someone picked one; else the card's own. */
  private picked?: number;
  private cut = 50;
  private drawn = '';

  constructor(private floor: string, private card: string, private base: () => string | undefined) {
    this.root.append(h('div.dp-top', {}, h('span.k', {}, 'Jak to bude vypadat'), this.link), this.body);
    this.setLink(base());
  }

  /** Takes the lane's latest state, draws, and reads again unless the last answer is younger than 30 s. */
  update(input: Omit<StageInput, 'preview'>, now = Date.now()) {
    this.input = input;
    this.render();
    if (this.loading || now - this.at < 30_000) return;
    this.at = now;
    const ctl = (this.loading = new AbortController());
    fetch(`/api/opora-preview?${new URLSearchParams({ floor: this.floor, card: this.card })}`, { signal: ctl.signal, cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<OporaPreviewReply>) : Promise.reject(new Error(String(r.status)))))
      .then((reply) => { this.reply = reply; this.failed = false; this.render(); })
      .catch(() => { if (!ctl.signal.aborted && !this.reply) { this.failed = true; this.render(); } })
      .finally(() => { if (this.loading === ctl) this.loading = undefined; });
  }

  destroy() { this.loading?.abort(); }

  private setLink(base?: string) {
    const href = oporaPreviewUrl(base, this.card);
    this.link.hidden = !href;
    if (href) this.link.setAttribute('href', href);
  }

  private render() {
    const r = this.reply, input = this.input;
    if (!input) return;
    // The window redraws on every event: draw again only when something it shows changed, so the images and the slider stay put.
    const key = JSON.stringify([r ?? null, input, this.picked ?? null, this.failed]);
    if (key === this.drawn) return;
    this.drawn = key;
    this.setLink(r?.base ?? this.base());
    if (!r) {
      this.body.replaceChildren(h('span.pw-note', {}, this.failed ? 'Náhled se nepodařilo načíst z kanceláře.' : 'Načítám náhled z Opory…'));
      return;
    }
    if (!r.linked) { this.body.replaceChildren(h('span.pw-note', {}, 'Patro není propojené s projektem Opory.')); return; }
    const s: StageInput = { ...input, preview: r.state === 'ok' ? r : { ...r, heads: [] } };
    const stage = designStage(s);
    if (this.picked !== undefined && this.picked > stage) this.picked = undefined;
    const shown = this.picked ?? stage;
    const out: Node[] = [];
    if (r.state === 'ok') out.push(modeChip(r.mode), brandPanel(r));
    out.push(track(stage, shown, (i) => { this.picked = i === stage ? undefined : i; this.render(); }));
    if (r.state === 'ok' || r.sketch || r.drawing) {
      out.push(preview({ floor: this.floor, card: this.card, r: s.preview!, stage: shown, cut: this.cut, setCut: (v) => { this.cut = v; } }));
    }
    if (r.state !== 'ok') {
      out.push(h('div.dp-calm', { role: 'status' }, h('b', {}, 'Náhled zatím není k dispozici.'),
        h('span', {}, r.state === 'missing' ? ' Tahle Opora ho ještě neumí vydat.' : ' Opora teď neodpovídá, zkusím to znovu.')));
    }
    out.push(evidenceChips(evidence(s, stage)));
    const focused = document.activeElement;
    const refocus = focused instanceof HTMLElement && this.body.contains(focused) ? focused.getAttribute('aria-label') ?? focused.textContent : null;
    this.body.replaceChildren(...out);
    if (refocus) {
      const again = [...this.body.querySelectorAll<HTMLElement>('button, input')].find((el) => (el.getAttribute('aria-label') ?? el.textContent) === refocus);
      again?.focus({ preventScroll: true });
    }
  }
}

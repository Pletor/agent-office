// The Výstupy ledge's window (E at it): every PR merged into main in the last days, newest first, with
// its commits and what its `## Výstup` section names (docs/vystupy-board.md): artifact links, "Před" and
// "Po" side by side with a switch, diagrams and animations. A click on a picture opens it large. A PR
// without outputs wears "bez výstupu", and a filter shows only those. Read-only.

import { countsLine, type MergedPr, type OutputMedia, type PrOutputs } from '../../../shared/outputs';
import { h, openModal, type Modal } from '../../ui/dom';
import type { OutputsView } from './board';

export interface DetailDeps {
  view(): OutputsView;
  refresh(): void;
  onChange(fn: () => void): () => void;
}

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const link = (url: string, text: string, cls = 'vo-link') => h(`a.${cls}` as 'a.x', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text);

/** A picture, large, over the window. */
function zoom(m: OutputMedia, label: string) {
  const img = h('img.vo-zoom-img', { src: m.url, alt: label, referrerpolicy: 'no-referrer' });
  openModal(h('section.vo-zoom', { role: 'dialog', 'aria-modal': 'true', 'aria-label': label }, h('header.vo-zoom-h', {}, h('b', {}, label), link(m.url, 'otevřít originál')), img), { doing: '🗂️ prohlíží výstup' });
}

/** A picture you can click to see large, or (another host, or not written as a picture) just its link. */
function media(m: OutputMedia, label: string): HTMLElement {
  if (!m.image) return h('div.vo-media.vo-media--link', {}, h('span.vo-k', {}, label), link(m.url, m.url));
  return h('figure.vo-media', {},
    h('button.vo-shot', { type: 'button', title: `${label}: zvětšit`, onclick: () => zoom(m, label) }, h('img', { src: m.url, alt: label, loading: 'lazy', referrerpolicy: 'no-referrer' })),
    h('figcaption', {}, label));
}

type Compare = 'both' | 'before' | 'after';

function beforeAfter(o: PrOutputs, n: number): HTMLElement | undefined {
  if (!o.before && !o.after) return undefined;
  let mode: Compare = 'both';
  const stage = h('div.vo-ba');
  const buttons = new Map<Compare, HTMLButtonElement>();
  const draw = () => {
    for (const [id, b] of buttons) b.classList.toggle('on', id === mode);
    const parts = [mode !== 'after' && o.before ? media(o.before, `Před · #${n}`) : null, mode !== 'before' && o.after ? media(o.after, `Po · #${n}`) : null].filter((x): x is HTMLElement => !!x);
    stage.classList.toggle('vo-ba--one', parts.length < 2);
    stage.replaceChildren(...(parts.length ? parts : [h('p.vo-none', {}, mode === 'before' ? 'Snímek „před“ chybí.' : 'Snímek „po“ chybí.')]));
  };
  const sw = h('div.vo-switch', { role: 'group', 'aria-label': 'Před a po' });
  for (const [id, label] of [['both', 'vedle sebe'], ['before', 'před'], ['after', 'po']] as [Compare, string][]) {
    const b = h('button.vo-sw', { type: 'button', onclick: () => { mode = id; draw(); } }, label) as HTMLButtonElement;
    buttons.set(id, b);
    sw.append(b);
  }
  draw();
  return h('div.vo-block', {}, h('div.vo-block-h', {}, h('span.vo-k', {}, 'Před / Po'), sw), stage);
}

function prCard(p: MergedPr): HTMLElement {
  const o = p.outputs;
  const title = p.url ? link(p.url, `#${p.number} ${p.title}`, 'vo-title') : h('span.vo-title', {}, `#${p.number} ${p.title}`);
  const shown = p.commits.slice(0, 6);
  const commits = h('ul.vo-commits', {},
    ...shown.map((c) => h('li', {}, h('code', {}, c.sha.slice(0, 7)), ' ', c.subject)),
    p.commits.length > shown.length ? h('li.vo-more', {}, `+ ${p.commits.length - shown.length} dalších commitů`) : null);
  const body: (HTMLElement | undefined)[] = [];
  if (o) {
    if (o.artifacts.length) body.push(h('div.vo-block', {}, h('span.vo-k', {}, 'Artefakt'), h('div.vo-arts', {}, ...o.artifacts.map((u, i) => link(u, o.artifacts.length > 1 ? `🔗 artefakt ${i + 1}` : '🔗 otevřít artefakt', 'vo-art')))));
    body.push(beforeAfter(o, p.number));
    if (o.diagrams.length) body.push(h('div.vo-block', {}, h('span.vo-k', {}, 'Diagram / animace'), h('div.vo-diagrams', {}, ...o.diagrams.map((d, i) => media(d, o.diagrams.length > 1 ? `Diagram ${i + 1} · #${p.number}` : `Diagram · #${p.number}`)))));
  }
  return h(`article.vo-pr${o ? '' : '.vo-pr--none'}` as 'article.x', {},
    h('header.vo-pr-h', {},
      title,
      h(`span.vo-tag${o ? '.vo-tag--ok' : '.vo-tag--none'}` as 'span.x', {}, o ? 's výstupem' : 'bez výstupu'),
      h('span.vo-meta', {}, [when(p.mergedAt), p.author, p.mainSha ? `main ${p.mainSha.slice(0, 7)}` : ''].filter(Boolean).join(' · '))),
    p.note ? h('p.vo-note', {}, p.note) : null,
    commits,
    ...body.filter((x): x is HTMLElement => !!x));
}

export function openOutputs(deps: DetailDeps): Modal {
  let onlyNone = false;
  const title = h('h2');
  const filter = h('button.pw-tab', { type: 'button', 'aria-pressed': 'false', onclick: () => { onlyNone = !onlyNone; render(); } }, 'jen bez výstupu') as HTMLButtonElement;
  const again = h('button.pw-tab', { type: 'button', onclick: () => deps.refresh() }, '↻ obnovit');
  const list = h('div.pw-body.vo-body');
  const el = h('section.pw-modal.vo-detail', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Výstupy Čisté linie' }, h('header.pw-head', {}, title, filter, again), list);

  function render() {
    const v = deps.view();
    const d = v.data;
    filter.classList.toggle('on', onlyNone);
    filter.setAttribute('aria-pressed', String(onlyNone));
    title.textContent = d ? `🗂️ Výstupy · Čistá linie · ${d.repo.label} · ${countsLine(d.counts)}` : '🗂️ Výstupy · Čistá linie';
    if (!d) {
      list.replaceChildren(h('p.vo-empty', {}, v.error ?? (v.loading ? 'Čtu sloučené PR…' : 'Žádná data.')));
      return;
    }
    const prs = onlyNone ? d.prs.filter((p) => !p.outputs) : d.prs;
    const top = list.scrollTop;
    list.replaceChildren(
      h('p.vo-lead', {}, `Sloučeno do ${d.repo.main} za posledních ${d.days} dní. Výstup = sekce „## Výstup“ v těle PR (Artefakt, Před, Po, Diagram).`),
      ...[d.note, d.error].filter((x): x is string => !!x).map((t) => h('p.vo-note', {}, t)),
      ...(prs.length ? prs.map(prCard) : [h('p.vo-empty', {}, onlyNone ? 'Každý sloučený PR má výstup.' : 'Za tu dobu se nic nesloučilo.')]),
    );
    list.scrollTop = top;
  }

  const off = deps.onChange(render);
  const modal = openModal(el, { doing: '🗂️ čte výstupy Čisté linie', onClose: off });
  render();
  deps.refresh();
  return modal;
}

// Deník, the Výstupy window's second mode: the project's change diary (docs/vystupy-board.md, "Deník
// změn projektu"). The merged PRs over 7, 30 or 90 days on a timeline grouped by day, newest first, each
// with its explanation, Před | Po side by side, diagrams, artifacts and its commits folded away; a PR
// without outputs is one compact row. The header links the project's own diary artifact, or offers a
// small form to set it. Every text from a PR is put in as text, never as HTML.

import { countsLine, OUTPUT_RANGES, type MergedPr, type OutputsBoard } from '../../../shared/outputs';
import { h } from '../../ui/dom';
import { artifacts, beforeAfter, diagrams, explanation, link } from './media';

export interface DiaryDeps {
  days: number;
  setDays(days: number): void;
  /** Saves the diary artifact ('' clears it); resolves to why it couldn't, if it couldn't. */
  setDiary(url: string): Promise<string | undefined>;
}

const dayOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '?' : d.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};
const timeOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
};

/** The PRs by day, in the order given (newest first). */
export function byDay(prs: readonly MergedPr[]): [string, MergedPr[]][] {
  const days = new Map<string, MergedPr[]>();
  for (const p of prs) {
    const k = dayOf(p.mergedAt);
    days.set(k, [...(days.get(k) ?? []), p]);
  }
  return [...days];
}

function entry(p: MergedPr): HTMLElement {
  const o = p.outputs;
  const title = p.url ? link(p.url, `#${p.number} ${p.title}`, 'vo-title') : h('span.vo-title', {}, `#${p.number} ${p.title}`);
  const meta = h('span.vo-meta', {}, [timeOf(p.mergedAt), p.author].filter(Boolean).join(' · '));
  if (!o) {
    return h('article.vo-diary-entry.vo-diary-entry--none', {},
      h('header.vo-pr-h', {}, title, h('span.vo-tag.vo-tag--none', {}, 'bez výstupu'), meta),
      p.note ? h('p.vo-note', {}, p.note) : null);
  }
  const commits = h('details.vo-diary-commits', {},
    h('summary', {}, `${p.commits.length} ${p.commits.length === 1 ? 'commit' : 'commitů'}`),
    h('ul.vo-commits', {}, ...p.commits.map((c) => h('li', {}, h('code', {}, c.sha.slice(0, 7)), ' ', c.subject))));
  return h('article.vo-diary-entry', {},
    h('header.vo-pr-h', {}, title, h('span.vo-tag.vo-tag--ok', {}, 's výstupem'), meta),
    o.explanation ? explanation(o.explanation) : null,
    beforeAfter(o, p.number) ?? null,
    o.diagrams.length ? diagrams(o.diagrams, p.number) : null,
    o.artifacts.length ? artifacts(o.artifacts) : null,
    p.commits.length ? commits : null);
}

/** The form that sets (or, empty, clears) the diary artifact. */
function diaryForm(current: string | undefined, deps: DiaryDeps): HTMLElement {
  const input = h('input.vo-diary-input', { type: 'url', placeholder: 'https://claude.ai/artifact/…', value: current ?? '', 'aria-label': 'Adresa artefaktu deníku' }) as HTMLInputElement;
  const why = h('span.vo-diary-why');
  const save = h('button.pw-tab', { type: 'submit' }, 'Uložit') as HTMLButtonElement;
  return h('form.vo-diary-form', {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      save.disabled = true;
      why.textContent = '';
      const err = await deps.setDiary(input.value.trim());
      save.disabled = false;
      if (err) why.textContent = err;
    },
  }, h('span.vo-k', {}, current ? 'Změnit deník' : 'Nastavit deník projektu'), input, save, why);
}

function header(d: OutputsBoard, deps: DiaryDeps): HTMLElement {
  const range = h('div.vo-switch', { role: 'group', 'aria-label': 'Rozsah' },
    ...OUTPUT_RANGES.map((n) => h(`button.vo-sw${n === deps.days ? '.on' : ''}` as 'button.x', { type: 'button', 'aria-pressed': String(n === deps.days), onclick: () => deps.setDays(n) }, `${n} dní`)));
  const art = d.diaryArtifact;
  let editing = !art;
  const slot = h('div.vo-diary-art');
  const draw = () => {
    slot.replaceChildren(
      ...(art ? [link(art, '📔 Deník projektu (Artifact)', 'vo-art'), h('button.vo-sw.vo-diary-edit', { type: 'button', title: 'Změnit adresu deníku', onclick: () => { editing = !editing; draw(); } }, '✎')] : []),
      ...(editing ? [diaryForm(art, deps)] : []));
  };
  draw();
  return h('header.vo-diary-head', {},
    h('h3.vo-diary-name', {}, `📔 ${d.repo.label}`),
    range,
    h('span.vo-meta', {}, `${countsLine(d.counts)} · ${d.days} dní`),
    slot);
}

/** The diary of the board `d`. */
export function diaryView(d: OutputsBoard, deps: DiaryDeps): HTMLElement[] {
  const days = byDay(d.prs);
  return [
    header(d, deps),
    ...[d.note, d.error].filter((x): x is string => !!x).map((t) => h('p.vo-note', {}, t)),
    ...(days.length
      ? days.map(([day, prs]) => h('section.vo-diary-day', {}, h('h4.vo-diary-date', {}, day), ...prs.map(entry)))
      : [h('p.vo-empty', {}, `Za ${d.days} dní se nic nesloučilo.`)]),
  ];
}

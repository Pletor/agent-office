// Seznam, the Výstupy window's first mode: a card per PR merged into main, newest first, with its
// commits and what its `## Výstup` section names (docs/vystupy-board.md). A PR without outputs wears
// "bez výstupu".

import type { MergedPr } from '../../../shared/outputs';
import { h } from '../../ui/dom';
import { artifacts, beforeAfter, diagrams, explanation, link, when } from './media';

export function prCard(p: MergedPr): HTMLElement {
  const o = p.outputs;
  const title = p.url ? link(p.url, `#${p.number} ${p.title}`, 'vo-title') : h('span.vo-title', {}, `#${p.number} ${p.title}`);
  const shown = p.commits.slice(0, 6);
  const commits = h('ul.vo-commits', {},
    ...shown.map((c) => h('li', {}, h('code', {}, c.sha.slice(0, 7)), ' ', c.subject)),
    p.commits.length > shown.length ? h('li.vo-more', {}, `+ ${p.commits.length - shown.length} dalších commitů`) : null);
  const body: (HTMLElement | undefined)[] = [];
  if (o) {
    if (o.explanation) body.push(explanation(o.explanation));
    if (o.artifacts.length) body.push(artifacts(o.artifacts));
    body.push(beforeAfter(o, p.number));
    if (o.diagrams.length) body.push(diagrams(o.diagrams, p.number));
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

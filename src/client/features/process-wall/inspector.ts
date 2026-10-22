// The inspector of one lane: who is on turn, its links (phase, run, branch, PR), the checks its
// events report, and its latest events. Only what the events and the store said.

import type { ProcessEvent } from '../../../shared/protocol';
import { h } from '../../ui/dom';
import { PHASE_CZ, phaseIndex, SOURCE_CZ, type Lane } from './lanes';
import { clock, eventMark, safeGithub } from './view';

/** Sections other features add at the end of the inspector (the Lens, features/lens), each given the lane. */
const sections: ((lane: Lane) => Node | null)[] = [];
export function addInspectorSection(section: (lane: Lane) => Node | null): () => void {
  sections.push(section);
  return () => { const i = sections.indexOf(section); if (i >= 0) sections.splice(i, 1); };
}

const isCheck = (e: ProcessEvent) => e.kind === 'pr.checks' || e.kind === 'check.self' || (e.kind === 'tool.use' && (e.tool?.action === 'test' || e.tool?.action === 'failing'));

function onTurn(lane: Lane): HTMLElement {
  if (lane.blocker?.human) {
    return h('div.pw-turn.human', {}, h('span.k', {}, 'Na tahu'), h('b', {}, 'Ty — člověk'),
      h('span', {}, lane.last?.kind === 'needs.input' ? lane.last.title : `${lane.worker ?? 'Pracovník'} čeká na odpověď v terminálu.`));
  }
  const who = lane.worker ?? (lane.blocker ? 'Nikdo není přidělen' : 'Bez pracovníka');
  const what = lane.blocker ? `Blokace: ${lane.blocker.text}.` : lane.last ? lane.last.title : 'Zatím žádná událost.';
  return h('div.pw-turn', {}, h('span.k', {}, 'Na tahu'), h('b', {}, who), h('span', {}, what, lane.working ? ' · pracuje' : ''));
}

function links(lane: Lane): HTMLElement {
  const dl = h('dl.pw-kv');
  const row = (k: string, v: Node | string) => dl.append(h('dt', {}, k), h('dd', {}, v));
  row('Fáze', lane.marker === 'none' ? 'bez události' : `${PHASE_CZ[lane.phase]}${lane.worker ? ' · ' + lane.worker : ''}`);
  row('Běh', lane.executionId ? h('code', {}, lane.executionId) : 'nedoložen');
  row('Větev', lane.branch ? h('code', { title: lane.branch }, lane.branch) : 'nedoložena');
  if (lane.pr) {
    const href = safeGithub(lane.prUrl);
    const checks = [...lane.events].find((e) => e.kind === 'pr.checks');
    const pr = h('span', {}, href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, `#${lane.pr}`) : `#${lane.pr}`, checks ? ` · ${checks.title.replace(/^PR #\d+ /, '')}` : '');
    row('PR', pr);
  } else row('PR', 'zatím žádný');
  return dl;
}

function checks(lane: Lane): HTMLElement | null {
  const seen = new Set<string>();
  const list = h('div.pw-ck');
  for (const e of lane.events) {
    if (!isCheck(e)) continue;
    const key = e.kind === 'tool.use' ? `tool:${e.tool?.target ?? e.title}` : `${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = e.kind === 'tool.use' ? e.tool?.target || e.tool?.name || e.title : e.title;
    list.append(eventMark(e), h('code', { title: e.detail ?? '' }, label), h('span.r', {}, e.kind === 'tool.use' ? (e.tool?.action === 'failing' ? 'selhává' : 'spuštěno · výsledek nepotvrzen') : e.kind));
    if (seen.size >= 6) break;
  }
  return seen.size ? list : null;
}

export function renderInspector(lane?: Lane): Node[] {
  if (!lane) return [h('p.pw-empty', {}, 'Vyberte kartu v toku práce.')];
  const out: Node[] = [h('h3', {}, lane.name), onTurn(lane), h('section.pw-sec', {}, h('span.k', {}, 'Odkazy'), links(lane))];
  const ck = checks(lane);
  out.push(h('section.pw-sec', {}, h('span.k', {}, 'Kontroly'), ck ?? h('span.pw-note', {}, 'Žádná kontrola zatím nehlášena.')));
  const tl = h('div.pw-tl');
  for (const e of lane.events.slice(0, 10)) {
    tl.append(h('div', { class: `pw-ev ${e.state === 'fail' || e.state === 'blocked' ? 'fail' : ''}` }, eventMark(e),
      h('div', {}, h('div.h', {}, `${clock(e.at)} · ${PHASE_CZ[phaseIndex(e.phase)]} · ${e.kind} · ${SOURCE_CZ[e.source]}`),
        h('div.t', { title: e.detail ?? '' }, e.title))));
  }
  out.push(h('section.pw-sec', {}, h('span.k', {}, 'Poslední události'), lane.events.length ? tl : h('span.pw-note', {}, 'Karta je známá ze stavu kanceláře, ale zatím nic nehlásila.')));
  for (const section of sections) { const el = section(lane); if (el) out.push(el); }
  return out;
}

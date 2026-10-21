import { REQUIREMENTS, ROLE_LABELS, ROLE_CONTRACTS, type StudioState, type StudioEvent } from './model';

export const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
export function dom<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') {
  const e = document.createElement(tag); e.className = cls; e.textContent = text; return e;
}
export type Panel = 'detail' | 'plan' | 'memory' | 'repos';
export function showPanel(panel: Panel) {
  for (const name of ['detail', 'plan', 'memory', 'repos']) {
    $(`#panel-${name}`).hidden = name !== panel;
    $(`#tab-${name}`).classList.toggle('active', name === panel);
    $(`#tab-${name}`).setAttribute('aria-selected', String(name === panel));
  }
}
const TITLES: Record<string, string> = { plan: 'Živý plán Opory', context: 'Kontext projektu', recall: 'Načtení paměti', contract: 'Podmínky dokončení', office: 'Kancelář agentů', frontend: 'Zobrazení průběhu', backend: 'Zpracování událostí', checks: 'Kontroly kvality', learn: 'Nová zkušenost', merge: 'Potvrzený výsledek', pr: 'Pull request', review: 'Revize vůči plánu', repair: 'Opravný krok R-01' };
const STATUS: Record<string, string> = { queued: 'Čeká na vstup', working: 'Právě probíhá', done: 'Doloženo v modelu', blocked: 'Vyžaduje doplnění', failed: 'Kontrola selhala' };
function evidenceCard(title: string, body: string, meta: string) {
  const el = dom('article', 'evidence-card');
  el.append(dom('span', 'evidence-meta', meta), dom('h3', '', title), dom('p', '', body)); return el;
}
export function renderPanels(s: StudioState, selected: string, events: StudioEvent[], replay: boolean) {
  $('#metric-plan').textContent = `revize ${s.revision}`;
  $('#metric-plan-note').textContent = s.accepted ? 'přijatá · podmínky popsány' : 'čeká na doplnění / přijetí';
  $('#metric-checks').textContent = s.checksRevision === s.revision ? '3 / 3' : '0 / 3';
  $('#metric-repos').textContent = String(4 + s.repositories.length);
  $('#metric-memory').textContent = ({ empty: 'čeká', recalled: '2 načtené', proposed: '1 kandidát', persisted: '1 uložená', reused: '1 znovu použitá' })[s.memory];
  $('#run-label').textContent = s.run;
  $('#headline').textContent = s.headline;
  $('#phase-label').textContent = replay ? `HISTORIE / UDÁLOST ${s.sequence}` : s.finished ? 'PRŮCHOD DOKONČEN' : s.waiting ? 'ČEKÁ NA VAŠE ROZHODNUTÍ' : 'ŽIVÁ UKÁZKA';
  $('#gate').hidden = !s.waiting || replay;
  $('#narrative-marker').className = s.waiting || s.nodes.checks.status === 'failed' || s.nodes.contract.status === 'blocked' ? 'amber' : 'pink';
  renderQuality(s); renderAgents(s); renderDetail(s, selected); renderPlan(s); renderMemory(s); renderRepositories(s);
  const feed = $('#event-feed'); feed.replaceChildren();
  for (const event of events.slice(0, s.sequence).slice(-4).reverse()) {
    const row = dom('div', 'event-row');
    row.append(dom('span', 'event-sequence', '#' + String(event.sequence).padStart(3, '0')), dom('span', 'event-type', event.type), dom('span', 'event-message', event.message)); feed.append(row);
  }
}
function renderQuality(s: StudioState) {
  const host = $('#quality-list'); host.replaceChildren();
  for (const r of REQUIREMENTS) {
    const verified = r.id === 'AC-05' ? s.merged : s.checksRevision === s.revision;
    const missing = s.missing.includes(r.id);
    const row = dom('div', `quality-row ${missing ? 'missing' : verified ? 'verified' : ''}`);
    row.append(dom('span', 'quality-icon', missing ? '!' : verified ? '✓' : '○'), dom('span', '', r.id), dom('span', '', missing ? 'chybí popis' : verified ? 'doloženo' : 'čeká na důkaz'));
    row.title = r.title; host.append(row);
  }
}
function renderAgents(s: StudioState) {
  const host = $('#agents'); host.replaceChildren();
  for (const [id, name, color] of [['planner', 'Plánovač', 'pink'], ['developer', 'Vývojář', 'cyan'], ['reviewer', 'Kontrolor', 'amber'], ['memory', 'Paměť', 'purple']]) {
    const row = dom('div', 'agent-row'); const glyph = dom('span', 'agent-glyph ' + color, '✳');
    row.append(glyph, dom('strong', '', name), dom('span', '', s.finished ? 'hotovo' : id === s.actor ? 'aktivní' : 'připraven')); host.append(row);
  }
}
function renderDetail(s: StudioState, selected: string) {
  const host = $('#detail-content'); host.replaceChildren(); const state = s.nodes[selected];
  host.append(dom('p', 'eyebrow', 'INSPEKTOR / DOHLEDATELNOST'), dom('h2', '', TITLES[selected] ?? s.repositories.find(r => r.id === selected)?.name ?? selected));
  host.append(dom('p', 'detail-status', state ? STATUS[state.status] : 'Uzel ještě nevznikl v této části historie.'));
  const info = dom('dl', 'detail-meta');
  for (const [label, value] of [['Karta', 'OP-128'], ['Revize plánu', String(s.revision)], ['Zdroj', 'Modelový scénář'], ['Stav', state?.detail ?? '—']]) info.append(dom('dt', '', label), dom('dd', '', value));
  host.append(info, dom('h3', 'subheading', 'DŮKAZY TOHOTO KROKU'));
  const proofs = s.evidence.filter(e => e.node === selected).reverse();
  if (!proofs.length) host.append(dom('p', 'empty-state', 'Zatím žádný důkaz. Pohyb pavouka ani začátek práce nejsou potvrzením výsledku.'));
  for (const e of proofs) host.append(evidenceCard(e.title, e.detail, `${e.id} · revize ${e.revision}${e.revision !== s.revision ? ' · starší kontext' : ''}`));
}
function renderPlan(s: StudioState) {
  const host = $('#plan-content'); host.replaceChildren();
  host.append(dom('p', 'eyebrow', 'OPORA / PLÁN A PODMÍNKY'), dom('h2', '', `Plán, revize ${s.revision}`), dom('p', 'muted', 'Přesná podmínka → odpovědný krok → ověřitelný důkaz.'));
  for (const r of REQUIREMENTS) {
    const row = evidenceCard(r.title, `Očekáváno: ${r.expected} Vlastník: ${r.owner}. Důkaz: ${r.proof}.`, r.id + (s.missing.includes(r.id) ? ' · CHYBÍ V PLÁNU' : ' · POPSÁNO'));
    if (s.missing.includes(r.id)) row.classList.add('warning'); host.append(row);
  }
  if (s.repairRequired) host.append(evidenceCard('R-01 · nový opravný krok', 'Vývojář opraví deduplikaci, doplní regresní test a znovu spustí kontroly. Předchozí výsledky neposkytují platný důkaz.', 'PŘIDÁNO ZA BĚHU · REVIZE 3'));
  for (const repo of s.repositories) {
    const contract = ROLE_CONTRACTS[repo.role];
    host.append(evidenceCard(repo.name, `Role: ${ROLE_LABELS[repo.role]}. Vstup: ${contract.input}. Výstup: ${contract.output}. Kontrola: ${contract.check}.`, 'ROZŠÍŘENÍ ROZSAHU'));
  }
}
function renderMemory(s: StudioState) {
  const host = $('#memory-content'); host.replaceChildren();
  host.append(dom('p', 'eyebrow', 'OPENVIKING / ŽIVOTNÍ CYKLUS'), dom('h2', '', 'Zkušenost s původem'), dom('p', 'muted', 'Každá změna má zdrojový úkol a důkaz. Opětovné použití se sleduje odděleně od přínosu.'));
  const stages = ['recalled', 'proposed', 'persisted', 'reused']; const at = stages.indexOf(s.memory);
  for (const [i, title] of ['Načíst relevantní zkušenost', 'Navrhnout změnu paměti', 'Potvrdit uložení', 'Použít při dalším úkolu'].entries()) host.append(dom('div', 'memory-stage ' + (at >= i ? 'complete' : ''), `${at >= i ? '✓' : '○'} ${title}`));
  if (at >= 1) {
    host.append(evidenceCard('Před', 'Deduplikuj eventId.', 'M-023 / PŮVODNÍ ZKUŠENOST'));
    host.append(evidenceCard('Po', 'Deduplikuj eventId i při obnově spojení. Ověř kombinaci snapshot + opakovaný event. Zdroj: OP-128 / R-01 / AC-02 / AC-03.', 'M-024 / NÁVRH ZPŘESNĚNÍ'));
  }
  if (at >= 3) host.append(evidenceCard('Další úkol OP-129', 'Zkušenost M-024 byla předána do kontextu. Úspěšnější řešení zatím nepotvrdilo srovnávací vyhodnocení.', 'OPĚTOVNÉ POUŽITÍ DOLOŽENO · PŘÍNOS NEZMĚŘEN'));
}
function renderRepositories(s: StudioState) {
  const host = $('#repo-list'); host.replaceChildren();
  for (const [name, label, color] of [['Opora', 'plán a podmínky', 'pink'], ['agent-office', 'pracovníci a nástroje', 'cyan'], ['OpenViking', 'kontext a paměť', 'purple'], ['GitHub', 'změny a výsledky', 'green']]) {
    const row = dom('div', 'repo-row'); row.append(dom('span', color, '◇'), dom('strong', '', name), dom('small', '', label)); host.append(row);
  }
  for (const repo of s.repositories) {
    const row = dom('div', 'repo-row added'); row.append(dom('span', 'cyan', '+'), dom('strong', '', repo.name), dom('small', '', ROLE_LABELS[repo.role])); host.append(row);
  }
}

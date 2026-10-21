import { ROLE_LABELS, type StudioState } from './model';

const NS = 'http://www.w3.org/2000/svg';
export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  parent.append(el); return el;
}
export interface Position { x: number; y: number }
interface Card extends Position { id: string; title: string; subtitle: string; owner: string; color: string; height?: number }
const CARDS: Card[] = [
  { id: 'plan', x: 42, y: 65, title: 'Živý plán', subtitle: 'Cíl · rozsah · kroky · vlastníci', owner: 'OPORA / OP-128', color: 'pink' },
  { id: 'context', x: 318, y: 65, title: 'Kontext projektu', subtitle: 'Soubory · rozhraní · závislosti', owner: 'REPOZITÁŘE', color: 'cyan' },
  { id: 'recall', x: 594, y: 65, title: 'Načtení paměti', subtitle: 'Zkušenosti s doloženým původem', owner: 'OPENVIKING / RECALL', color: 'purple' },
  { id: 'contract', x: 870, y: 65, title: 'Podmínky dokončení', subtitle: 'Každé tvrzení potřebuje důkaz', owner: 'OPORA / KONTRAKT', color: 'pink' },
  { id: 'office', x: 42, y: 295, title: 'Kancelář agentů', subtitle: 'Předání revize · izolované větve', owner: 'AGENT-OFFICE', color: 'cyan' },
  { id: 'frontend', x: 318, y: 295, title: 'Zobrazení průběhu', subtitle: 'Vývojář A · vlastní worktree', owner: 'VÝVOJ / FRONTEND', color: 'pink' },
  { id: 'backend', x: 594, y: 295, title: 'Zpracování událostí', subtitle: 'Vývojář B · vlastní worktree', owner: 'VÝVOJ / BACKEND', color: 'cyan' },
  { id: 'checks', x: 870, y: 295, title: 'Kontroly kvality', subtitle: 'Typy · regrese · testy · build', owner: 'KONTROLOR / CI', color: 'amber' },
  { id: 'learn', x: 42, y: 565, title: 'Nová zkušenost', subtitle: 'Návrh → zápis → další použití', owner: 'OPENVIKING / PAMĚŤ', color: 'purple' },
  { id: 'merge', x: 318, y: 565, title: 'Potvrzený výsledek', subtitle: 'Rozhodnutí člověka · receipt', owner: 'GITHUB → OPORA', color: 'green' },
  { id: 'pr', x: 594, y: 565, title: 'Pull request', subtitle: 'Změny + důkazy + vazba na kartu', owner: 'GITHUB / PR #214 · DEMO', color: 'cyan' },
  { id: 'review', x: 870, y: 565, title: 'Revize vůči plánu', subtitle: 'Pokrytí podmínek a aktuální verze', owner: 'KONTROLOR / REVIEW', color: 'amber' },
];
const PATHS: [string, string, string][] = [
  ['plan', 'context', 'M277 126 H318'], ['context', 'recall', 'M553 126 H594'], ['recall', 'contract', 'M829 126 H870'],
  ['contract', 'office', 'M987 187 V221 Q987 231 977 231 H169 Q159 231 159 241 V295'],
  ['office', 'frontend', 'M277 356 H318'], ['office', 'backend', 'M159 417 V441 H711 V417'],
  ['frontend', 'checks', 'M435 417 V433 H987 V417'], ['backend', 'checks', 'M829 356 H870'],
  ['checks', 'review', 'M987 417 V565'], ['review', 'pr', 'M870 626 H829'],
  ['pr', 'merge', 'M594 626 H553'], ['merge', 'learn', 'M318 626 H277'],
  ['learn', 'recall', 'M42 626 H20 V206 H711 V187'],
];
const statusNames = { queued: 'VE FRONTĚ', working: 'PRACUJE', done: 'DOLOŽENO', blocked: 'ČEKÁ', failed: 'CHYBA' };
function label(parent: Element, x: number, y: number, text: string, cls: string) {
  const el = svgEl('text', { x, y, class: cls }, parent); el.textContent = text; return el;
}
export class ProcessGraph {
  readonly svg: SVGSVGElement;
  readonly actors: SVGGElement;
  private cards = new Map<string, { spec: Card; group: SVGGElement }>();
  private edges: { from: string; to: string; element: SVGPathElement }[] = [];
  private nodeLayer: SVGGElement;
  private edgeLayer: SVGGElement;
  private topology = '';
  private network?: SVGGElement;
  private flow: SVGGElement;
  lens: 'process' | 'memory' = 'process';
  constructor(host: HTMLElement, private select: (id: string) => void) {
    this.svg = svgEl('svg', { viewBox: '0 0 1150 740', role: 'group', 'aria-label': 'Živý model procesu, uzly lze otevřít klávesou Enter' }, host);
    const defs = svgEl('defs', {}, this.svg);
    const marker = svgEl('marker', { id: 'flow-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' }, defs);
    svgEl('path', { d: 'M0 0 L8 4 L0 8', fill: 'context-stroke' }, marker);
    this.flow = svgEl('g', {}, this.svg);
    this.edgeLayer = svgEl('g', { class: 'connections' }, this.flow);
    this.nodeLayer = svgEl('g', {}, this.flow);
    label(this.flow, 42, 35, '01 / ZADÁNÍ, KONTEXT A PŘIJATÝ PLÁN', 'lane-label');
    label(this.flow, 42, 270, '02 / PARALELNÍ PRÁCE A OVĚŘENÍ', 'lane-label');
    label(this.flow, 42, 540, '03 / PAMĚŤ ← VÝSLEDEK ← PŘEDÁNÍ', 'lane-label');
    for (const card of CARDS) this.addCard(card);
    for (const [from, to, d] of PATHS) this.addEdge(from, to, d);
    this.actors = svgEl('g', { class: 'actors', 'aria-hidden': 'true' }, this.svg);
  }
  private addEdge(from: string, to: string, d: string) {
    const element = svgEl('path', { d, class: 'connection', 'marker-end': 'url(#flow-arrow)' }, this.edgeLayer);
    this.edges.push({ from, to, element });
  }
  private addCard(spec: Card) {
    const g = svgEl('g', { transform: `translate(${spec.x} ${spec.y})`, class: `process-card ${spec.color}`, tabindex: 0, role: 'button', 'aria-label': spec.title, 'data-node': spec.id }, this.nodeLayer);
    const h = spec.height ?? 122;
    svgEl('rect', { width: 235, height: h, rx: 9, class: 'card-surface' }, g);
    svgEl('path', { d: 'M13 0 H58', class: 'card-accent' }, g);
    label(g, 15, 23, spec.owner, 'card-owner'); label(g, 15, 49, spec.title, 'card-title');
    if (h > 90) label(g, 15, 69, spec.subtitle, 'card-subtitle');
    label(g, 15, h - 18, '', 'card-status');
    svgEl('circle', { cx: 217, cy: 20, r: 3, class: 'state-light' }, g);
    g.addEventListener('click', () => this.select(spec.id));
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.select(spec.id); } });
    this.cards.set(spec.id, { spec, group: g });
  }
  position(id: string): Position {
    const card = this.cards.get(id)?.spec ?? CARDS[0];
    return { x: card.x + 190, y: card.y + (card.height ?? 122) - 24 };
  }
  update(s: StudioState, selected: string) {
    const topology = s.repositories.map(r => r.id).join(',') + ':' + s.repairRequired;
    if (topology !== this.topology) {
      for (const [id, c] of this.cards) if (!CARDS.some(base => base.id === id)) { c.group.remove(); this.cards.delete(id); }
      this.edges = this.edges.filter(e => { const keep = !e.from.startsWith('repo-') && e.from !== 'repair' && e.to !== 'repair'; if (!keep) e.element.remove(); return keep; });
      if (s.repairRequired) {
        this.addCard({ id: 'repair', x: 594, y: 445, title: 'R-01 · oprava duplicity', subtitle: '', owner: 'NOVÝ KROK / REVIZE 3', color: 'pink', height: 90 });
        this.addEdge('checks', 'repair', 'M987 417 V488 H829');
        this.addEdge('repair', 'checks', 'M711 454 V445 H1124 V356 H1105');
      }
      for (const [i, repo] of s.repositories.entries()) {
        const x = 42 + 276 * i;
        this.addCard({ id: repo.id, x, y: 755, title: repo.name.split('/').at(-1)!.slice(0, 24), subtitle: ROLE_LABELS[repo.role], owner: 'PŘIDANÝ MODUL / DEMO', color: 'cyan' });
        this.addEdge(repo.id, repo.role === 'context' ? 'context' : repo.role === 'check' ? 'checks' : 'office', `M${x + 117} 755 V720 H1134 V250 H${repo.role === 'check' ? 987 : repo.role === 'context' ? 435 : 159} V${repo.role === 'context' ? 187 : 295}`);
      }
      this.svg.setAttribute('viewBox', `0 0 1150 ${s.repositories.length ? 915 : 740}`);
      this.topology = topology;
    }
    for (const [id, { group, spec }] of this.cards) {
      const state = s.nodes[id]; if (!state) continue;
      group.setAttribute('class', `process-card ${spec.color} ${state.status}${id === selected ? ' selected' : ''}`);
      group.querySelector('.card-status')!.textContent = id === 'plan' ? `REVIZE ${s.revision} / ${statusNames[state.status]}` : state.detail;
      group.setAttribute('aria-label', `${spec.title}: ${state.detail}`);
    }
    for (const e of this.edges) e.element.setAttribute('class', `connection${s.active === e.to || s.active === e.from ? ' transmitting' : ''}${e.from === 'learn' ? ' memory-return' : ''}`);
    this.updateNetwork(s);
  }
  setLens(lens: 'process' | 'memory') {
    this.lens = lens; this.flow.style.display = lens === 'process' ? '' : 'none';
    this.actors.style.display = lens === 'process' ? '' : 'none';
    if (this.network) this.network.style.display = lens === 'memory' ? '' : 'none';
  }
  private updateNetwork(s: StudioState) {
    if (!this.network) {
      this.network = svgEl('g', { class: 'memory-network' }, this.svg);
      const columns = [
        { x: 100, labels: ['OP-128', 'AC-01', 'AC-02', 'AC-03', 'AC-04', 'AC-05', 'M-017', 'M-023'], title: 'KONTEXT A PODMÍNKY' },
        { x: 405, labels: ['Plán', 'Frontend', 'Backend', 'R-01', 'Kontroly', 'Review', 'Pull request', 'Sloučení'], title: 'KROKY A VÝSLEDKY' },
        { x: 710, labels: ['Zdroj', 'Původní obsah', 'Oprava', 'Důkazy', 'Kandidát', 'Potvrzení'], title: 'KONSOLIDACE PAMĚTI' },
        { x: 1005, labels: ['M-024', 'OP-129', 'Načteno', 'Přínos nezměřen'], title: 'DALŠÍ POUŽITÍ' },
      ];
      const paths = svgEl('g', {}, this.network);
      // Authored semantic relationships, not all-to-all decorative neural weights.
      const relations = [
        [[0, 0], [0, 1], [0, 2], [1, 0], [1, 2], [2, 3], [2, 4], [3, 2], [3, 4], [4, 4], [4, 5], [5, 5], [5, 6], [5, 7], [6, 2], [6, 4], [7, 3], [7, 4]],
        [[0, 0], [1, 0], [2, 0], [3, 2], [4, 3], [5, 3], [6, 0], [7, 3], [3, 4], [4, 4], [7, 5]],
        [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [5, 1], [5, 2]],
      ];
      for (let c = 0; c < columns.length; c++) {
        const col = columns[c];
        label(this.network, col.x - 50, 50, col.title, 'lane-label');
        col.labels.forEach((t, i) => {
          const y = 110 + i * 65;
          svgEl('circle', { cx: col.x, cy: y, r: 7, class: `network-dot c${c}` }, this.network!);
          label(this.network!, col.x + 17, y + 4, t, 'network-label');
          if (c < columns.length - 1) {
            const next = columns[c + 1];
            for (const [, j] of relations[c].filter(([from]) => from === i)) {
              const endY = 110 + j * 65;
              svgEl('path', { d: `M${col.x} ${y} C${col.x + 140} ${y} ${next.x - 140} ${endY} ${next.x} ${endY}`, class: `network-link c${c}` }, paths);
            }
          }
        });
      }
      label(this.network, 100, 690, 'Modelové vazby zkušenosti a jejích zdrojů. Zobrazení nepředstavuje neurony jazykového modelu.', 'network-note');
      this.network.style.display = this.lens === 'memory' ? '' : 'none';
    }
    this.network.setAttribute('data-memory', s.memory);
  }
}

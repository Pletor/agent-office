import { h, openModal, type Modal } from '../../ui/dom';
import { connectionLabel, PHASES, visibleRows, type WallSnapshot, type WallView, type WallHistory } from './model';
import './ui.css';
import { MemoryPane } from './memory';

type Tab = WallView | 'history' | 'demo' | 'memory';
export class ProcessWallPanel {
  private modal?: Modal;
  private tab: Tab = 'overview';
  private body = h('div.process-wall-body');
  private status = h('p.process-wall-status');
  private buttons = new Map<Tab, HTMLButtonElement>();
  private frame?: HTMLIFrameElement;
  private snapshot?: WallSnapshot;
  private rendered = '';
  private memory?: MemoryPane;
  constructor(private history: WallHistory, private changeView: (view: WallView) => void, private nextPage: () => void, private reportMemory: (label: string) => void) {}
  open(s: WallSnapshot) {
    if (this.modal) return;
    this.tab = 'overview'; this.changeView('overview');
    this.rendered = '';
    const tabs = h('nav.process-wall-tabs', { 'aria-label': 'Pohled na proces' });
    this.buttons.clear();
    for (const [id, label] of [['overview', 'Celý proces'], ['workers', 'Pracovníci'], ['blockers', 'Blokace'], ['history', 'Historie pozorování'], ['memory', 'OpenViking · živě'], ['demo', 'Podrobný plán · DEMO']] as const) {
      const button = h('button', { type: 'button', onclick: () => {
        this.tab = id;
        if (id === 'overview' || id === 'workers' || id === 'blockers') this.changeView(id);
        this.render();
      } }, label);
      this.buttons.set(id, button); tabs.append(button);
    }
    const panel = h('section.process-wall-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Opora – řízení práce' },
      h('header', {}, h('div', {}, h('span.process-wall-eyebrow', {}, 'CELÝ PROCES POD JEDNOU STŘECHOU'), h('h2', {}, 'OPORA · Řízení práce'))),
      this.status, tabs,
      h('div.process-wall-controls', {}, h('span', {}, 'Zvolený živý pohled se promítá také na stěnu.'), h('button', { type: 'button', onclick: () => this.nextPage() }, 'Další strana na stěně →')),
      this.body);
    this.modal = openModal(panel, { doing: 'sleduje proces práce', onClose: () => { this.memory?.destroy(); this.memory = undefined; this.frame = undefined; this.body.replaceChildren(); this.modal = undefined; } });
    this.update(s); this.buttons.get('overview')!.focus();
  }
  update(s: WallSnapshot) { this.snapshot = s; if (this.modal) this.render(); }
  private render() {
    const s = this.snapshot;
    if (!s || !this.modal) return;
    const age = s.at ? Math.max(0, Math.floor((Date.now() - s.at) / 1000)) : null;
    this.status.textContent = `${connectionLabel(s)} · ${s.floor} · poslední změna ${age === null ? 'zatím nepřijata' : `před ${age} s`}`;
    for (const [id, button] of this.buttons) { button.classList.toggle('active', id === this.tab); button.setAttribute('aria-pressed', String(id === this.tab)); }
    const githubStale = !!s.githubAt && Date.now() - s.githubAt > 180000;
    const signature = JSON.stringify([this.tab, s, githubStale, this.tab === 'history' ? this.history.entries : null]);
    if (signature === this.rendered) return;
    this.rendered = signature;
    if (this.tab === 'memory') {
      if (!this.memory) { this.frame = undefined; this.memory = new MemoryPane(this.reportMemory); this.body.replaceChildren(this.memory.root); }
      return;
    }
    this.memory?.destroy(); this.memory = undefined;
    if (this.tab === 'demo') {
      if (this.frame) return;
      this.body.replaceChildren(h('p.process-wall-notice', {}, 'DEMO · Modelový plán, paměť a pipeline. Tato animace nepopisuje právě běžící pracovníky kanceláře.'));
      this.frame = h('iframe', { title: 'Modelová vizualizace procesu Opory', src: '/process-studio.html', class: 'process-wall-demo' });
      this.frame.addEventListener('load', () => {
        // Same-origin child keeps Escape routed through the office modal/focus lifecycle.
        this.frame?.contentDocument?.addEventListener('keydown', event => {
          if (event.key !== 'Escape' || this.frame?.contentDocument?.querySelector('dialog[open]')) return;
          event.preventDefault(); event.stopImmediatePropagation(); this.modal?.close();
        }, true);
      });
      this.body.append(this.frame); return;
    }
    this.frame = undefined; this.body.replaceChildren();
    if (this.tab === 'history') {
      this.body.append(h('p.process-wall-notice', {}, 'Posledních 80 změn pozorovaných v tomto okně a na tomto patře. Obnovení stránky historii smaže; nejde o úplný serverový audit.'));
      if (!this.history.entries.length) this.body.append(h('p', {}, 'Čekáme na první pozorování.'));
      for (const entry of this.history.entries) this.body.append(h('p.process-wall-event', {}, h('time', {}, new Date(entry.at).toLocaleTimeString('cs-CZ')), entry.text));
      return;
    }
    const summary = h('div.process-wall-metrics');
    for (const [label, value] of [['Pracovníci', s.workers], ['Pracuje', s.running], ['Ve frontě', s.queued], ['Blokace', s.blocked]]) summary.append(h('div', {}, h('strong', {}, value), h('span', {}, label)));
    this.body.append(summary);
    const ghAge = s.githubAt ? Math.max(0, Math.floor((Date.now() - s.githubAt) / 1000)) : null;
    this.body.append(h('p.process-wall-notice', {}, s.githubError ? `GitHub: ${s.githubError} · zobrazen poslední známý stav`
      : `GitHub: ${s.githubLoading ? 'obnovuje se · ' : ''}${ghAge === null ? 'data zatím nepřijata' : `snapshot ${new Date(s.githubAt).toLocaleTimeString('cs-CZ')}${githubStale ? ' · může být zastaralý' : ''}`}. Dokončený tah agenta neznamená úspěšné testy nebo merge.`));
    const rows = visibleRows(s, this.tab);
    if (!rows.length) this.body.append(h('p.process-wall-empty', {}, this.tab === 'blockers' ? 'V přijatých datech není doložená blokace.' : 'Zatím žádná práce. Nové úkoly a pracovníci se objeví automaticky.'));
    for (const row of rows) {
      const phases = h('div.process-wall-phases', { 'aria-label': `Pozorovaná fáze: ${PHASES[row.phase]}` });
      PHASES.forEach((phase, i) => phases.append(h('span', { class: i === row.phase ? 'current' : '' }, i === row.phase ? '◉ ' + phase : phase)));
      const article = h('article.process-wall-card', { class: row.blocked ? 'blocked' : '' },
        h('div.process-wall-card-title', {}, h('h3', {}, row.title), h('span', {}, row.owner)), phases,
        h('p', {}, row.detail), h('code', {}, row.branch));
      if (row.pr) {
        article.append(h('p', {}, `PR #${row.pr.number} · ${row.pr.headRefOid?.slice(0, 10) || 'SHA nepřijato'} · CI: ${row.pr.checks} · review: ${row.pr.reviewDecision || 'neuvedeno'}`));
        try {
          const url = new URL(row.pr.url);
          if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password) article.append(h('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer' }, 'Otevřít PR a důkazy ↗'));
        } catch { /* Invalid service URL stays plain text. */ }
      }
      this.body.append(article);
    }
    this.body.append(h('div.process-wall-boundary', {}, h('strong', {}, 'Další části procesu'),
      h('p', {}, 'OpenViking: živý stav a čtení paměti najdete na kartě OpenViking · živě. Externí plán Opory a nasazení zde zatím nemají živé události; jejich návrh je v Podrobném plánu · DEMO.')));
  }
}

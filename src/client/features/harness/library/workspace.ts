import type { HarnessCatalog } from '../../../../shared/harness';
import { HARNESS_CATEGORIES } from '../../../../shared/harness';
import { h } from '../../../ui/dom';
import { capabilityCards } from './capabilities';
import { CATEGORY_HINTS, CATEGORY_NAMES } from './names';
import { latestDraft } from '../hierarchy/drafts';
import type { HarnessHierarchyView } from '../../../../shared/harness-navigation';
import './style.css';

type Page = 'boxes' | 'resources' | 'overview' | 'equipment' | 'runtime';
type Tone = 'ok' | 'warn' | 'bad' | 'wait';
const LEVELS = ['Globál', 'Projekt / repozitář', 'Stránka', 'Vrstva', 'Oblast', 'Sektor', 'Karta'];
const PAGES: [Page, string, string][] = [
  ['boxes', 'Schránky', 'Co je v nich a balíček'],
  ['overview', 'Přehled', 'Jak knihovna funguje'], ['resources', 'Prostředky', 'Číst a sestavit balíček'],
  ['equipment', 'Výbava', 'Co dostane která úroveň'], ['runtime', 'Pro agenty', 'Příkazy u karty'],
];
/** The worker's path through one card, the short form of the Pro agenty page. */
const AGENT_STEPS: [string, string][] = [
  ['office-harness --recommend PROBLEM', 'doporučená výbava pro typ úkolu'],
  ['office-harness --accepted-kit', 'co přesně má tato karta přijaté'],
  ['office-harness --prepare-accepted', 'připravit výbavu před prací'],
  ['office-harness --invoke-node RESOURCE', 'spustit připnutý skript'],
  ['office-harness --verify-pair PLAN', 'požádat Oporu o nezávislé ověření'],
];
const resources = (n: number) => n + (n === 1 ? ' prostředek' : n >= 2 && n <= 4 ? ' prostředky' : ' prostředků');

/** A shell around the existing reader and editor, so optional hierarchy modules keep ownership. */
export function libraryWorkspace(el: HTMLElement, floor: () => string, signal: AbortSignal, options: { beforeNavigate?: (page: Page) => boolean; boxes?: HTMLElement; hierarchy?: (view: HarnessHierarchyView | null) => void } = {}) {
  let catalog: HarnessCatalog | undefined, ticket = 0;
  const summary = h('p.harness-library-summary', { role: 'status' }, 'Načítání knihovny…');
  const availability = h('div.harness-availability');
  const groups = h('div.harness-category-grid');
  const status = (label: string) => {
    const pill = h('span.harness-pill', { 'data-tone': 'wait' }, '…'), text = h('span', {}, 'Zjišťuji…');
    return { row: h('div.harness-status-row', {}, h('dt', {}, label), h('dd', {}, pill, text)),
      set(tone: Tone, short: string, long: string) { pill.dataset.tone = tone; pill.textContent = short; text.textContent = long; } };
  };
  const stock = status('Prostředky'), levels = status('Úrovně'), binding = status('Připojení k Opoře'), editing = status('Úpravy');
  const path = h('ol.harness-path', { 'aria-label': 'Hierarchie výbavy' }, ...LEVELS.map(name => h('li', {}, name)));
  const go = (page: Page, label: string) => h('button.btn', { type: 'button', onclick: () => show(page) }, label);
  const overview = h('section.harness-overview', { 'aria-label': 'Přehled knihovny', tabindex: -1 },
    h('div.harness-overview-heading', {}, h('span.harness-eyebrow', {}, 'Harness · knihovna výbavy'), h('h3', {}, 'Co dostane agent k práci'),
      h('p', {}, 'Knihovna drží instrukce, skills, pravidla, nástroje a paměť pro agenty. Vy určíte, co dostane která úroveň projektu. Worker si přijatou výbavu před prací připraví a jeho výsledky se měří podle přesné verze.')),
    h('div.harness-overview-grid', {},
      h('section.harness-card', { 'aria-label': 'Stav tohoto patra' }, h('h4', {}, 'Stav tohoto patra'), h('dl.harness-status-list', {}, stock.row, levels.row, binding.row, editing.row)),
      h('section.harness-card', { 'aria-label': 'Jak to funguje' }, h('h4', {}, 'Jak to funguje'), h('ol.harness-steps', {},
        h('li', {}, h('strong', {}, 'Prostředky'), h('span', {}, 'Co je v knihovně k dispozici a odkud.'), go('resources', 'Prostředky')),
        h('li', {}, h('strong', {}, 'Výbava'), h('span', {}, 'Na kterékoli ze sedmi úrovní prostředek zapnete, vypnete, nebo necháte zdědit.'), go('equipment', 'Výbava')),
        h('li', {}, h('strong', {}, 'Příprava'), h('span', {}, 'Karta dostane přijatou výbavu s přesnou verzí. Uložená změna neovlivní práci, která už běží.')),
        h('li', {}, h('strong', {}, 'Výsledky'), h('span', {}, 'Výsledky karet se počítají podle verze nástroje. Neznámé zůstává neznámé, ne nula.'))))),
    h('section.harness-card', { 'aria-label': 'Sedm úrovní výbavy' }, h('h4', {}, 'Sedm úrovní výbavy'),
      h('p', {}, 'Nižší úroveň dědí z vyšší, dokud ji nepřepíše. Karta tak dostane vše z Globálu a Projektu, co Stránka, Vrstva, Oblast ani Sektor nevypnuly.'),
      path, go('equipment', 'Upravit výbavu')),
    h('section', { 'aria-label': 'Kategorie prostředků' }, h('h4', {}, 'Kategorie prostředků'), groups),
    h('section.harness-card.harness-agent-card', { 'aria-label': 'Pro agenta' }, h('h4', {}, 'Pro agenta: postup u jedné karty'),
      h('ol.harness-commands', {}, ...AGENT_STEPS.map(([command, what]) => h('li', {}, h('code', {}, command), h('span', {}, what)))),
      go('runtime', 'Všechny příkazy')),
    h('section.harness-card', { 'aria-label': 'Zdroje' }, h('h4', {}, 'Zdroje'), availability,
      h('p.harness-muted', {}, 'Nalezený zdroj znamená, že jsou na disku jeho soubory. Neověřuje přihlášení do Context7, připojení MCP ani běžící OpenViking.')));
  const runtime = h('section.harness-runtime', { 'aria-label': 'Příkazy pro agenty', tabindex: -1 },
    h('span.harness-eyebrow', {}, 'Harness · pro agenty'), h('h3', {}, 'Příkazy u karty'),
    h('p', {}, 'Tyto příkazy používá worker během práce na kartě, seřazené podle průběhu. V prohlížeči se nespouštějí; zda fungují v provozu, ověřuje worker sám.'),
    capabilityCards(),
    h('p.harness-muted', {}, 'Ke každému výsledku patří verze, otisk, velikost vzorku a rozlišení mezi hlášením agenta a lidským potvrzením. Úspěšnost v provozu se tu neodhaduje.'));
  const buttons = new Map<Page, HTMLButtonElement>();
  const navigation = h('nav.harness-navigation', { 'aria-label': 'Stránky knihovny' },
    ...PAGES.filter(([page]) => page !== 'boxes' || options.boxes).map(([page, name, hint]) => {
      const button = h('button', { type: 'button', onclick: () => show(page) }, h('strong', {}, name), h('small', {}, hint));
      buttons.set(page, button); return button;
    }), summary);
  // Preserve PR55's actual selector and handlers across every page; never fabricate projects.
  const project = el.querySelector<HTMLSelectElement>('[aria-label="Projekt knihovny"]');
  if (project) navigation.prepend(h('label.harness-project', {}, 'Patro', project));
  el.querySelector(':scope > header')!.after(navigation);
  el.querySelector('.harness-body')!.before(...(options.boxes ? [options.boxes] : []), overview, runtime);
  el.classList.add('harness-workspace');
  function show(page: Page) {
    if (options.beforeNavigate?.(page) === false) return;
    el.dataset.libraryView = page;
    if (page === 'equipment') el.dataset.pane = 'list';
    for (const [key, button] of buttons) { if (key === page) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); }
    const editor = el.querySelector<HTMLDetailsElement>('.harness-cascade');
    if (editor) editor.open = page === 'equipment';
    if (page === 'resources') el.querySelector<HTMLInputElement>('.harness-toolbar input[type=search]')?.focus({ preventScroll: true });
    if (page === 'overview' || page === 'runtime') (page === 'overview' ? overview : runtime).focus({ preventScroll: true });
    if (page === 'boxes') options.boxes?.focus({ preventScroll: true });
  }
  async function support() {
    const seq = ++ticket, project = floor();
    levels.set('wait', '…', 'Zjišťuji podporu úrovní…');
    binding.set('wait', '…', 'Zjišťuji…');
    editing.set('wait', '…', 'Zjišťuji…');
    path.dataset.support = 'unknown';
    try {
      const response = await fetch('/api/harness/hierarchy?' + new URLSearchParams({ floor: project }), { signal });
      if (signal.aborted || seq !== ticket || project !== floor()) return;
      if (response.status === 404) {
        path.dataset.support = 'legacy';
        levels.set('warn', 'Tři', 'Starší server: jen Globál → Projekt → Karta. Úrovně Stránka až Sektor tu nelze upravit.');
        binding.set('wait', '–', 'Tento server připojení neposkytuje.'); editing.set('wait', '–', 'Upravuje se jen ve starším editoru.');
        options.hierarchy?.(null);
        return;
      }
      if (!response.ok) throw new Error(response.status === 401 ? 'Přihlaste se znovu.' : 'Hierarchie není dostupná; zkontrolujte přístup nebo nastavení serveru.');
      const data = await response.json();
      if (signal.aborted || seq !== ticket || project !== floor()) return;
      if (data.schema !== 'harness.hierarchy/1' || typeof data.writable !== 'boolean') throw new Error('Server nepotvrdil podporu hierarchie.');
      path.dataset.support = 'seven';
      options.hierarchy?.(data);
      levels.set('ok', 'Sedm', 'Globál až Karta.');
      binding.set(data.bound ? 'ok' : 'warn', data.bound ? 'Ano' : 'Ne', data.bound
        ? 'Úrovně Stránka až Karta odpovídají plátnu Opory.' + (data.notice ? ' ' + data.notice : '')
        : (data.notice || 'Patro není připojené, proto jsou k dispozici jen Globál a Projekt.') + ' Připojíte ho ve Výbavě.');
      editing.set(data.writable ? 'ok' : 'wait', data.writable ? 'Ano' : 'Čtení', data.writable ? 'Výbavu můžete upravovat a ukládat.' : 'Pouze ke čtení; výbavu upravuje správce nebo jeho orchestrátor.');
    } catch (error) {
      if (signal.aborted || seq !== ticket) return;
      options.hierarchy?.(null);
      levels.set('bad', 'Chyba', (error as Error).message); binding.set('wait', '–', 'Neznámé.'); editing.set('wait', '–', 'Neznámé.');
    }
  }
  // A draft kept by ✕ or Esc reopens on Equipment, where its notice is (docs/harness-hierarchy.md).
  show(latestDraft(floor()) ? 'equipment' : options.boxes ? 'boxes' : 'overview');
  return { show, catalog(value: HarnessCatalog) {
    catalog = value;
    const found = catalog.sources.filter(source => source.available).length;
    summary.textContent = `${resources(catalog.entries.length)} · ${found}/${catalog.sources.length} zdrojů` + (catalog.limited ? ' · omezený katalog' : '');
    stock.set(catalog.entries.length ? 'ok' : 'warn', String(catalog.entries.length), `${resources(catalog.entries.length)} z ${found} nalezených zdrojů` + (catalog.limited ? ' (katalog je omezený).' : '.'));
    groups.replaceChildren(...HARNESS_CATEGORIES.map(category => {
      const count = catalog!.entries.filter(entry => entry.category === category).length;
      return h('button.harness-category', { type: 'button', title: CATEGORY_HINTS[category], 'data-category': category, onclick: () => {
        show('resources'); const select = el.querySelector<HTMLSelectElement>('[aria-label="Kategorie prostředku"]')!;
        select.value = category; select.dispatchEvent(new Event('change'));
      } }, h('strong', {}, String(count)), h('span', {}, CATEGORY_NAMES[category]), h('small', {}, CATEGORY_HINTS[category]));
    }));
    availability.replaceChildren(...catalog.sources.map(source => h('span', { class: source.available ? 'available' : 'missing' }, (source.available ? '● ' : '○ ') + source.name + (source.available ? ' · nalezeno' : ' · chybí'))));
    void support();
  } };
}

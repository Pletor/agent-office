import type { HarnessCatalog } from '../../../../shared/harness';
import { HARNESS_CATEGORIES } from '../../../../shared/harness';
import { h } from '../../../ui/dom';
import { capabilityCards } from './capabilities';
import { latestDraft } from '../hierarchy/drafts';
import './style.css';

type Page = 'resources' | 'overview' | 'equipment' | 'runtime';
const LEVELS = ['Globál', 'Projekt / repozitář', 'Stránka', 'Vrstva', 'Oblast', 'Sektor', 'Karta'];

/** A shell around the existing reader and editor, so optional hierarchy modules keep ownership. */
export function libraryWorkspace(el: HTMLElement, floor: () => string, signal: AbortSignal, options: { beforeNavigate?: (page: Page) => boolean } = {}) {
  let catalog: HarnessCatalog | undefined, ticket = 0;
  const summary = h('p.harness-library-summary', { role: 'status' }, 'Loading the project library…');
  const availability = h('div.harness-availability');
  const groups = h('div.harness-category-grid');
  const hierarchy = h('p', { role: 'status' }, 'Checking hierarchy support…');
  const path = h('ol.harness-path', { 'aria-label': 'Configuration hierarchy' }, ...LEVELS.map(name => h('li', {}, name)));
  const overview = h('section.harness-overview', { 'aria-label': 'Library overview', tabindex: -1 },
    h('div.harness-overview-heading', {}, h('span.harness-eyebrow', {}, 'HARNESS / LIBRARY'), h('h3', {}, 'Equip the next task. Keep the evidence.'), h('p', {}, 'Published resources become scoped assignments. Preparation pins an accepted kit; invocation evidence and human outcomes inform later recommendations.')),
    h('section.harness-relationship', {}, h('h4', {}, 'Scope → inheritance → accepted execution'), path, hierarchy,
      h('button.btn', { type: 'button', onclick: () => show('equipment') }, 'Inspect assignments and origins')),
    h('h4', {}, 'Published resources'), groups,
    h('section.harness-relationship', {}, h('h4', {}, 'Sources and memory'), availability,
      h('p.harness-muted', {}, 'Source availability means reference files were found. It does not verify Context7 credentials, connect MCP or start OpenViking. Live memory requires a configured service and a compatible runner.')));
  const runtime = h('section.harness-runtime', { 'aria-label': 'Runtime and evidence reference', tabindex: -1 },
    h('h3', {}, 'Runtime and evidence'),
    h('p', {}, 'These implemented contracts belong to the authenticated worker and its accepted execution. This browser has no session endpoint for their runtime state. Expand a card to see its relationship and verification entry point.'),
    h('ol.harness-flow', {}, ...['Publish', 'Assign / inherit', 'Prepare / accept', 'Invoke / measure', 'Human outcome', 'Recommend / recover'].map(name => h('li', {}, name))),
    capabilityCards(), h('p.harness-muted', {}, 'Versions, digests, sample counts and reported versus human-confirmed outcomes must stay attached to evidence. No production success rate is inferred here.'));
  const buttons = new Map<Page, HTMLButtonElement>();
  const navigation = h('nav.harness-navigation', { 'aria-label': 'Harness library pages' },
    ...([['overview', 'Overview', 'Relationships & sources'], ['resources', 'Resources', 'Read & export a pack'], ['equipment', 'Equipment', 'Assignments & inheritance'], ['runtime', 'Runtime & evidence', 'Worker contracts']] as const).map(([page, name, hint]) => {
      const button = h('button', { type: 'button', onclick: () => show(page) }, h('strong', {}, name), h('small', {}, hint));
      buttons.set(page, button); return button;
    }), summary);
  // Preserve PR55's actual selector and handlers across every page; never fabricate projects.
  const project = el.querySelector<HTMLSelectElement>('[aria-label="Projekt knihovny"]');
  if (project) navigation.prepend(h('label.harness-project', {}, 'Project / repository', project));
  el.querySelector(':scope > header')!.after(navigation);
  el.querySelector('.harness-body')!.before(overview, runtime);
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
  }
  async function support() {
    const seq = ++ticket, project = floor();
    hierarchy.textContent = 'Checking hierarchy support…';
    path.dataset.support = 'unknown';
    try {
      const response = await fetch('/api/harness/hierarchy?' + new URLSearchParams({ floor: project }), { signal });
      if (signal.aborted || seq !== ticket || project !== floor()) return;
      if (response.status === 404) { path.dataset.support = 'legacy'; hierarchy.textContent = 'This server exposes Global → Repository → Task. The remaining hierarchy levels require the seven-level module; unavailable levels cannot be edited here.'; return; }
      if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to inspect hierarchy support.' : 'Hierarchy unavailable; access or backend configuration needs attention.');
      const data = await response.json();
      if (signal.aborted || seq !== ticket || project !== floor()) return;
      if (data.schema !== 'harness.hierarchy/1' || typeof data.writable !== 'boolean') throw new Error('Hierarchy support was not confirmed by this server.');
      path.dataset.support = 'seven';
      hierarchy.textContent = 'Seven-level hierarchy API available · ' + (data.writable ? 'write authority confirmed.' : 'read-only for this session.')
        + (el.querySelector('.harness-levels') ? ' Seven-level editor loaded.' : ' This client provides legacy three-level editing; install the matching hierarchy editor for all seven levels.')
        + (data.bound ? ' Project binding is saved.' : ' No saved project binding.') + (data.notice ? ' ' + data.notice : '');
    } catch (error) { if (!signal.aborted && seq === ticket) hierarchy.textContent = (error as Error).message; }
  }
  // A draft kept by ✕ or Esc reopens on Equipment, where its notice is (docs/harness-hierarchy.md).
  show(latestDraft(floor()) ? 'equipment' : 'overview');
  return { show, catalog(value: HarnessCatalog) {
    catalog = value;
    summary.textContent = `${catalog.entries.length} resources · ${catalog.sources.filter(source => source.available).length}/${catalog.sources.length} sources` + (catalog.limited ? ' · limited catalog' : '');
    groups.replaceChildren(...HARNESS_CATEGORIES.map(category => {
      const count = catalog!.entries.filter(entry => entry.category === category).length;
      return h('button.harness-category', { type: 'button', onclick: () => {
        show('resources'); const select = el.querySelector<HTMLSelectElement>('[aria-label="Resource category"]')!;
        select.value = category; select.dispatchEvent(new Event('change'));
      } }, h('strong', {}, String(count)), h('span', {}, category));
    }));
    availability.replaceChildren(...catalog.sources.map(source => h('span', { class: source.available ? 'available' : 'missing' }, (source.available ? '● ' : '○ ') + source.name + (source.available ? ' · files found' : ' · files unavailable'))));
    void support();
  } };
}

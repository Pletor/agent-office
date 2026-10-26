import './ui.css';
import { HARNESS_CATEGORIES, harnessBundle, type HarnessCatalog, type HarnessText } from '../../../shared/harness';
import { h, openModal, toast, type Modal } from '../../ui/dom';
import { hierarchyPanel } from './hierarchy/editor';
import { libraryKeys } from './keyboard';
import type { HarnessProjectChoice } from '../../../shared/harness-navigation';
import { libraryWorkspace } from './library/workspace';
import { boxesPage } from './library/boxes';
import { categoryName, CATEGORY_NAMES } from './library/names';

let active: Modal | undefined;
export function openHarness(floor: string) {
  if (active) return;
  let catalog: HarnessCatalog | undefined;
  let selected = new Set<string>();
  let current: HarnessText | undefined;
  let request = 0;
  let catalogRequest = 0;
  let closed = false;
  let busy = false;
  const abort = new AbortController();
  let cascade = hierarchyPanel(floor, abort.signal);
  const project = h('select', { 'aria-label': 'Projekt knihovny' }, h('option', { value: floor }, floor));
  const assign = h('button.btn', { type: 'button', onclick: () => { if (current) { workspace.show('equipment'); void cascade.assign(current); } } }, 'Přiřadit do výbavy');
  const filter = h('input', { type: 'search', placeholder: 'Hledat prostředky…', 'aria-label': 'Hledat v knihovně' });
  const category = h('select', { 'aria-label': 'Kategorie prostředku' }, h('option', { value: '' }, 'Všechny kategorie'), ...HARNESS_CATEGORIES.map((c) => h('option', { value: c }, CATEGORY_NAMES[c])));
  const source = h('select', { 'aria-label': 'Zdroj prostředku' }, h('option', { value: '' }, 'Všechny zdroje'));
  const list = h('div.harness-list', { role: 'group', 'aria-label': 'Prostředky knihovny' });
  const title = h('h3', {}, 'Vyberte prostředek');
  const origin = h('p.harness-origin');
  const text = h('pre.harness-text', {}, 'Vyberte prostředek vlevo. Můžete ho přidat do balíčku kontextu a balíček zkopírovat nebo stáhnout pro model.');
  const sources = h('details.harness-sources', {}, h('summary', {}, 'Zdroje a dostupnost'));
  const status = h('p.harness-status', { role: 'status' }, 'Načítání prostředků…');
  const back = h('button.btn.harness-back', { type: 'button', onclick: () => showList() }, '← Prostředky');
  const retryRead = h('button.btn.harness-retry', { type: 'button', hidden: true }, 'Zkusit znovu');
  const count = h('span', {}, 'Vybráno 0 / 24');
  const add = h('button.btn', { type: 'button', disabled: true }, 'Přidat do balíčku');
  const download = h('button.btn', { type: 'button' }, 'Stáhnout balíček');
  const copy = h('button.btn.primary', { type: 'button' }, 'Zkopírovat balíček');
  const clear = h('button.btn', { type: 'button' }, 'Vyprázdnit');
  const refresh = h('button.btn', { type: 'button' }, 'Obnovit');
  const el = h('div.modal.harness-window', { role: 'dialog', 'aria-label': 'Knihovna Harness', 'aria-modal': 'true', tabindex: -1, 'data-pane': 'list' },
    h('header', {}, h('h2', {}, '📚 Harness'), h('span.harness-tag', {}, 'Výbava pro agenty')),
    h('p.harness-intro', {}, 'Instrukce, skills, nástroje a paměť. Přečtěte si je, sestavte z nich balíček pro model, nebo je přiřaďte do výbavy.'),
    h('div.harness-toolbar', {}, project, filter, category, source, refresh),
    h('div.body.harness-body', {}, cascade.el, h('aside', {}, status, list, sources), h('section.harness-reader', { 'aria-live': 'polite' }, back, title, origin, h('div.harness-actions', {}, add, assign), retryRead, text)),
    h('footer', {}, count, clear, download, copy),
  );
  const boxes = boxesPage({
    floor: () => floor, signal: abort.signal, selected: () => selected,
    toggle(id) { if (selected.has(id)) selected.delete(id); else if (selected.size < 24) selected.add(id); render(); },
    replace(ids) { selected = new Set(ids.filter((id) => catalog?.entries.some((e) => e.id === id))); render(); },
    browse(value) { workspace.show('resources'); category.value = value; render(); },
  });
  const workspace = libraryWorkspace(el, () => floor, abort.signal, { boxes: boxes.el, hierarchy: (view) => boxes.hierarchy(view) });
  const keys = libraryKeys(el, filter, list, () => workspace.show('resources'));
  active = openModal(el, { doing: '📚 v knihovně Harness', reading: true, onClose: () => { closed = true; abort.abort(); active = undefined; keys.release(); } });
  // Delay focus past the E that opened the shelf; Overview never summons a phone keyboard.
  setTimeout(() => { if (el.dataset.libraryView === 'overview') el.querySelector<HTMLElement>('.harness-navigation [aria-current]')?.focus({ preventScroll: true }); }, 30);
  /** On a phone the list and the reader take turns on the screen. */
  function showList() {
    el.dataset.pane = 'list';
    (list.querySelector<HTMLElement>('[aria-pressed=true]') ?? filter).focus({ preventScroll: true });
  }
  function note(text: string, ...actions: HTMLElement[]) { return h('div.harness-state', {}, h('p', {}, text), ...actions); }
  async function get<T>(path: string, id?: string): Promise<T> {
    const query = new URLSearchParams({ floor, ...(id ? { id } : {}) });
    const response = await fetch('/api/harness' + path + '?' + query, { signal: abort.signal });
    if (!response.ok) throw new Error(response.status === 401 ? 'Přihlaste se znovu.' : 'Prostředek není dostupný. Obnovte a zkuste to znovu.');
    return response.json();
  }
  function update() {
    project.disabled = busy;
    count.textContent = 'Vybráno ' + selected.size + ' / 24';
    assign.disabled = !current || busy;
    add.disabled = !current || busy || (!selected.has(current.id) && selected.size >= 24);
    add.textContent = current && selected.has(current.id) ? 'Odebrat z balíčku' : 'Přidat do balíčku';
    copy.disabled = download.disabled = busy || selected.size === 0;
  }
  function render() {
    if (!catalog) return;
    const words = filter.value.toLowerCase().trim().split(/\s+/);
    const entries = catalog.entries.filter((e) => (!category.value || e.category === category.value) && (!source.value || e.source === source.value) && words.every((w) => (e.title + ' ' + e.path + ' ' + e.source).toLowerCase().includes(w)));
    status.textContent = entries.length + (entries.length === 1 ? ' prostředek' : entries.length >= 2 && entries.length <= 4 ? ' prostředky' : ' prostředků') + (catalog.limited ? ' · katalog je omezený' : '');
    list.replaceChildren(...entries.map((e) => h('button.harness-entry', { type: 'button', 'aria-pressed': current?.id === e.id, onclick: () => void read(e.id, true) },
      h('strong', {}, (selected.has(e.id) ? '✓ ' : '') + e.title), h('small', {}, categoryName(e.category) + ' · ' + e.source), h('small', {}, e.path))));
    if (!catalog.entries.length) list.append(note('Zatím žádné publikované prostředky. Přidejte instrukce, nástroje nebo paměť do .harness/ v tomto repozitáři a obnovte.', h('button.btn', { type: 'button', onclick: () => void load() }, 'Obnovit')));
    else if (!entries.length) list.append(note('Žádný prostředek neodpovídá.', h('button.btn', { type: 'button', onclick: () => { filter.value = category.value = source.value = ''; render(); filter.focus(); } }, 'Zrušit filtry')));
    list.removeAttribute('aria-busy');
    update();
    boxes.refresh();
  }
  async function read(id: string, open = false) {
    const ticket = ++request;
    current = undefined;
    if (open) el.dataset.pane = 'reader';
    title.textContent = 'Načítání…';
    origin.textContent = '';
    text.textContent = '';
    text.setAttribute('aria-busy', 'true');
    retryRead.hidden = true;
    update();
    try {
      const result = await get<HarnessText>('/file', id);
      if (closed || ticket !== request) return;
      current = result;
      title.textContent = result.title;
      origin.textContent = result.source + ' / ' + result.path;
      text.textContent = result.text;
      text.scrollTop = 0;
      render();
    } catch (err) {
      if (closed || ticket !== request) return;
      title.textContent = 'Nelze přečíst';
      text.textContent = (err as Error).message;
      retryRead.hidden = false;
      retryRead.onclick = () => void read(id);
    } finally { if (ticket === request) text.removeAttribute('aria-busy'); }
  }
  async function load() {
    const sequence = ++catalogRequest;
    refresh.disabled = true;
    status.textContent = 'Načítání prostředků…';
    list.setAttribute('aria-busy', 'true');
    list.replaceChildren(...Array.from({ length: 6 }, () => h('div.harness-skeleton', { 'aria-hidden': 'true' })));
    try {
      const result = await get<HarnessCatalog>('');
      if (closed || sequence !== catalogRequest) return;
      catalog = result;
      cascade.catalog(result);
      workspace.catalog(result);
      boxes.catalog(result);
      selected = new Set([...selected].filter((id) => result.entries.some((e) => e.id === id)));
      source.replaceChildren(h('option', { value: '' }, 'Všechny zdroje'), ...[...new Set(result.entries.map((e) => e.source))].map((s) => h('option', { value: s }, s)));
      sources.replaceChildren(h('summary', {}, 'Zdroje a dostupnost'), ...result.sources.map((s) => h('p', {}, (s.available ? '✓ ' : '— ') + s.name + (s.available ? '' : ' · nenalezeno'))),
        h('p', {}, 'Soubory OpenVikingu jsou jen odkazy. Živá paměť potřebuje nastavený server OpenViking a kompatibilní runner. Další prostředky publikujte do .harness/ (docs/harness.md).'));
      render();
      if (!current && result.entries.some((e) => e.id === 'guide:instructions')) await read('guide:instructions');
    } catch (err) {
      if (closed || sequence !== catalogRequest) return;
      status.textContent = 'Knihovna není dostupná';
      list.removeAttribute('aria-busy');
      list.replaceChildren(note((err as Error).message, h('button.btn.primary', { type: 'button', onclick: () => void load() }, 'Zkusit znovu')));
    }
    finally { if (sequence === catalogRequest) refresh.disabled = false; }
  }
  async function exportPack(clipboard: boolean) {
    if (busy || !selected.size) return;
    busy = true;
    update();
    try {
      const entries: HarnessText[] = [];
      for (const id of [...selected]) entries.push(await get<HarnessText>('/file', id));
      if (closed) return;
      const pack = harnessBundle(entries);
      if (clipboard) { await navigator.clipboard.writeText(pack); toast('Balíček kontextu zkopírován'); }
      else {
        const url = URL.createObjectURL(new Blob([pack], { type: 'text/markdown;charset=utf-8' }));
        const link = h('a', { href: url, download: 'harness-context.md' });
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (err) { if (!closed) toast((err as Error).message + ' Pokud schránka nefunguje, použijte Stáhnout balíček.', 'warn'); }
    finally { busy = false; update(); }
  }
  add.onclick = () => {
    if (!current || busy) return;
    if (selected.has(current.id)) selected.delete(current.id);
    else if (selected.size < 24) selected.add(current.id);
    render();
  };
  clear.onclick = () => { if (!busy) { selected.clear(); render(); } };
  filter.oninput = category.onchange = source.onchange = render;
  refresh.onclick = () => void load();
  project.onchange = () => {
    if (busy || !cascade.canNavigate()) { project.value = floor; return; }
    floor = project.value; request++;
    current = catalog = undefined; selected.clear();
    const next = hierarchyPanel(floor, abort.signal);
    cascade.el.replaceWith(next.el); cascade = next;
    title.textContent = 'Vyberte prostředek'; text.textContent = ''; origin.textContent = '';
    showList(); update(); void load();
  };
  copy.onclick = () => void exportPack(true);
  download.onclick = () => void exportPack(false);
  update();
  void load();
  void get<{ projects: HarnessProjectChoice[] }>('/projects').then(result => {
    if (closed || !Array.isArray(result.projects)) return;
    project.replaceChildren(...result.projects.map(item => h('option', { value: item.floor }, item.name + (item.projectName ? ' · ' + item.projectName : ''))));
    project.value = floor;
  }).catch(() => { /* The current floor remains usable on an older server. */ });
}

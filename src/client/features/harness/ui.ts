import './ui.css';
import { HARNESS_CATEGORIES, harnessBundle, type HarnessCatalog, type HarnessText } from '../../../shared/harness';
import { h, openModal, toast, type Modal } from '../../ui/dom';
import { cascadePanel } from './cascade';
import { libraryKeys } from './keyboard';

let active: Modal | undefined;
export function openHarness(floor: string) {
  if (active) return;
  let catalog: HarnessCatalog | undefined;
  let selected = new Set<string>();
  let current: HarnessText | undefined;
  let request = 0;
  let closed = false;
  let busy = false;
  const abort = new AbortController();
  const cascade = cascadePanel(floor, abort.signal);
  const assign = h('button.btn', { type: 'button', onclick: () => { if (current) cascade.assign(current); } }, 'Assign resource');
  const filter = h('input', { type: 'search', placeholder: 'Search resources…', 'aria-label': 'Search harness resources' });
  const category = h('select', { 'aria-label': 'Resource category' }, h('option', { value: '' }, 'All categories'), ...HARNESS_CATEGORIES.map((c) => h('option', { value: c }, c)));
  const source = h('select', { 'aria-label': 'Resource source' }, h('option', { value: '' }, 'All sources'));
  const list = h('div.harness-list', { role: 'group', 'aria-label': 'Harness resources' });
  const title = h('h3', {}, 'Choose a resource');
  const origin = h('p.harness-origin');
  const text = h('pre.harness-text', {}, 'Read a resource, add it to your context pack, then copy or download the selection for a model.');
  const sources = h('details.harness-sources', {}, h('summary', {}, 'Sources and availability'));
  const status = h('p.harness-status', { role: 'status' }, 'Loading resources…');
  const back = h('button.btn.harness-back', { type: 'button', onclick: () => showList() }, '← Resources');
  const retryRead = h('button.btn.harness-retry', { type: 'button', hidden: true }, 'Try again');
  const count = h('span', {}, '0 selected');
  const add = h('button.btn', { type: 'button', disabled: true }, 'Add to pack');
  const download = h('button.btn', { type: 'button' }, 'Download pack');
  const copy = h('button.btn.primary', { type: 'button' }, 'Copy pack');
  const clear = h('button.btn', { type: 'button' }, 'Clear');
  const refresh = h('button.btn', { type: 'button' }, 'Refresh');
  const el = h('div.modal.harness-window', { role: 'dialog', 'aria-label': 'Harness library', 'aria-modal': 'true', tabindex: -1, 'data-pane': 'list' },
    h('header', {}, h('h2', {}, '📚 Harness'), h('span.harness-tag', {}, 'Model context library')),
    h('p.harness-intro', {}, 'Instructions, skills, tools and memory references. Select what your model needs for this task.'),
    h('div.harness-toolbar', {}, filter, category, source, refresh),
    h('div.body.harness-body', {}, cascade.el, h('aside', {}, status, list, sources), h('section.harness-reader', { 'aria-live': 'polite' }, back, title, origin, h('div.harness-actions', {}, add, assign), retryRead, text)),
    h('footer', {}, count, clear, download, copy),
  );
  const keys = libraryKeys(el, filter, list);
  active = openModal(el, { doing: '📚 at the Harness library', reading: true, onClose: () => { closed = true; abort.abort(); active = undefined; keys.release(); } });
  // A phone's keyboard shouldn't pop up over the library: there the window itself takes focus.
  (matchMedia('(pointer: fine)').matches ? filter : el).focus({ preventScroll: true });
  /** On a phone the list and the reader take turns on the screen. */
  function showList() {
    el.dataset.pane = 'list';
    (list.querySelector<HTMLElement>('[aria-pressed=true]') ?? filter).focus({ preventScroll: true });
  }
  function note(text: string, ...actions: HTMLElement[]) { return h('div.harness-state', {}, h('p', {}, text), ...actions); }
  async function get<T>(path: string, id?: string): Promise<T> {
    const query = new URLSearchParams({ floor, ...(id ? { id } : {}) });
    const response = await fetch('/api/harness' + path + '?' + query, { signal: abort.signal });
    if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to read the library.' : 'Resource unavailable. Refresh and try again.');
    return response.json();
  }
  function update() {
    count.textContent = selected.size + ' selected / 24';
    add.disabled = !current || busy || (!selected.has(current.id) && selected.size >= 24);
    add.textContent = current && selected.has(current.id) ? 'Remove from pack' : 'Add to pack';
    copy.disabled = download.disabled = busy || selected.size === 0;
  }
  function render() {
    if (!catalog) return;
    const words = filter.value.toLowerCase().trim().split(/\s+/);
    const entries = catalog.entries.filter((e) => (!category.value || e.category === category.value) && (!source.value || e.source === source.value) && words.every((w) => (e.title + ' ' + e.path + ' ' + e.source).toLowerCase().includes(w)));
    status.textContent = entries.length + (entries.length === 1 ? ' resource' : ' resources') + (catalog.limited ? ' · catalog limit reached' : '');
    list.replaceChildren(...entries.map((e) => h('button.harness-entry', { type: 'button', 'aria-pressed': current?.id === e.id, onclick: () => void read(e.id, true) },
      h('strong', {}, (selected.has(e.id) ? '✓ ' : '') + e.title), h('small', {}, e.category + ' · ' + e.source), h('small', {}, e.path))));
    if (!catalog.entries.length) list.append(note('No resources published yet. Add instructions, tools or memory exports under .harness/ in this repository, then refresh.', h('button.btn', { type: 'button', onclick: () => void load() }, 'Refresh')));
    else if (!entries.length) list.append(note('No matching resources.', h('button.btn', { type: 'button', onclick: () => { filter.value = category.value = source.value = ''; render(); filter.focus(); } }, 'Clear filters')));
    list.removeAttribute('aria-busy');
    update();
  }
  async function read(id: string, open = false) {
    const ticket = ++request;
    current = undefined;
    if (open) el.dataset.pane = 'reader';
    title.textContent = 'Loading…';
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
      title.textContent = 'Unable to read';
      text.textContent = (err as Error).message;
      retryRead.hidden = false;
      retryRead.onclick = () => void read(id);
    } finally { if (ticket === request) text.removeAttribute('aria-busy'); }
  }
  async function load() {
    refresh.disabled = true;
    status.textContent = 'Loading resources…';
    list.setAttribute('aria-busy', 'true');
    list.replaceChildren(...Array.from({ length: 6 }, () => h('div.harness-skeleton', { 'aria-hidden': 'true' })));
    try {
      const result = await get<HarnessCatalog>('');
      if (closed) return;
      catalog = result;
      selected = new Set([...selected].filter((id) => result.entries.some((e) => e.id === id)));
      source.replaceChildren(h('option', { value: '' }, 'All sources'), ...[...new Set(result.entries.map((e) => e.source))].map((s) => h('option', { value: s }, s)));
      sources.replaceChildren(h('summary', {}, 'Sources and availability'), ...result.sources.map((s) => h('p', {}, (s.available ? '✓ ' : '— ') + s.name + (s.available ? '' : ' · not found'))),
        h('p', {}, 'OpenViking files are references. Live memory requires a configured OpenViking server and a compatible runner. Publish additional resources in .harness/; see docs/harness.md.'));
      render();
      if (!current && result.entries.some((e) => e.id === 'guide:instructions')) await read('guide:instructions');
    } catch (err) {
      if (closed) return;
      status.textContent = 'Library unavailable';
      list.removeAttribute('aria-busy');
      list.replaceChildren(note((err as Error).message, h('button.btn.primary', { type: 'button', onclick: () => void load() }, 'Try again')));
    }
    finally { refresh.disabled = false; }
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
      if (clipboard) { await navigator.clipboard.writeText(pack); toast('Context pack copied'); }
      else {
        const url = URL.createObjectURL(new Blob([pack], { type: 'text/markdown;charset=utf-8' }));
        const link = h('a', { href: url, download: 'harness-context.md' });
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (err) { if (!closed) toast((err as Error).message + ' You can use Download pack if clipboard access is unavailable.', 'warn'); }
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
  copy.onclick = () => void exportPack(true);
  download.onclick = () => void exportPack(false);
  update();
  void load();
}

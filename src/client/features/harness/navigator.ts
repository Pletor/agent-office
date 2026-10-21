// The category navigator (docs/harness.md "Categories and the editor"): the thirteen categories in a
// column, each with its count, its purpose and an availability badge; the chosen category's groups (the
// folder an element was published in) as collapsible shelves; and the elements of an open shelf a page at
// a time, so 1,200 elements never become one flat list. Search is an addition: it narrows the chosen
// category, or with "All categories" every category, and keeps the same shelves.
import './navigator.css';
import { h } from '../../ui/dom';
import { HARNESS_CATALOG_LIMIT, HARNESS_CATEGORIES, HARNESS_CATEGORY_PURPOSE, type HarnessCatalog, type HarnessCategory, type HarnessEntry } from '../../../shared/harness';

/** Elements shown per shelf before "Show more". */
export const SHELF_PAGE = 40;
/** A category with at most this many elements opens every shelf; a bigger one opens the first only. */
const OPEN_ALL = 60;

export interface NavMarks { pack: Set<string>; saved: Set<string>; draft: Set<string> }
type Sources = HarnessCatalog['sources'];

/** Words of a search, all of which an element must match (title, path, group, source or ID). */
export function matches(e: HarnessEntry, words: string[]): boolean {
  if (!words.length) return true;
  const text = (e.title + ' ' + e.path + ' ' + e.group + ' ' + e.source + ' ' + e.id).toLowerCase();
  return words.every((w) => text.includes(w));
}

export function categoryNavigator(opts: { onPick(id: string): void; current(): string | undefined; marks(): NavMarks; onClear?(): void; onFilter?(): void }) {
  let entries: HarnessEntry[] = [];
  let sources: Sources = [];
  let limited = false;
  let category: HarnessCategory = 'instructions';
  /** Shelves opened or closed by hand, and how many elements each shows. */
  const open = new Map<string, boolean>();
  const shown = new Map<string, number>();
  const search = h('input', { type: 'search', placeholder: 'Search (optional)…', 'aria-label': 'Search harness resources' });
  const scope = h('select', { 'aria-label': 'Search scope' }, h('option', { value: 'category' }, 'In this category'), h('option', { value: 'all' }, 'All categories'));
  const cats = h('div.harness-cats', { role: 'group', 'aria-label': 'Categories' });
  const el = h('nav.harness-categories', { 'aria-label': 'Harness categories' }, cats);
  const heading = h('div.harness-shelf-head');
  const list = h('div.harness-list', { role: 'group', 'aria-label': 'Harness resources' });
  const words = () => search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const all = () => scope.value === 'all' && words().length > 0;
  const problem = (source: string) => sources.find((s) => s.name === source)?.reason;

  function categoryButton(c: HarnessCategory, count: number, partial: number) {
    const b = h('button.harness-cat', { type: 'button', 'aria-pressed': String(c === category && !all()), title: HARNESS_CATEGORY_PURPOSE[c], 'data-empty': String(count === 0) },
      h('span.harness-cat-name', {}, c), h('span.harness-count', { 'aria-label': count + (count === 1 ? ' element' : ' elements') }, String(count)),
      partial ? h('span.harness-badge.harness-badge-warn', { title: `${partial} of these come from a source that was not read in full (see Sources and availability)` }, 'partial') : null,
      h('small.harness-cat-purpose', {}, HARNESS_CATEGORY_PURPOSE[c]));
    b.onclick = () => { category = c; if (scope.value === 'all') scope.value = 'category'; render(); };
    return b;
  }
  function item(e: HarnessEntry, marks: NavMarks) {
    const flags = [marks.draft.has(e.id) ? '✎' : '', marks.saved.has(e.id) ? '●' : '', marks.pack.has(e.id) ? '◆' : ''].filter(Boolean).join(' ');
    const why = problem(e.source);
    const b = h('button.harness-entry', { type: 'button', 'aria-pressed': String(opts.current() === e.id), title: `${e.id} · revision ${e.version}${flags ? ' · ' + [marks.draft.has(e.id) ? 'in the draft' : '', marks.saved.has(e.id) ? 'assigned in the saved profile' : '', marks.pack.has(e.id) ? 'in the ad-hoc pack' : ''].filter(Boolean).join(', ') : ''}` },
      h('strong', {}, (flags ? flags + ' ' : '') + e.title), h('small', {}, e.group + ' · ' + e.source + (why ? ' · source ' + why : '')), h('small', {}, e.path));
    b.onclick = () => opts.onPick(e.id);
    return b;
  }
  /** One shelf: its header (opens and closes it) and, open, a page of its elements and "Show more". */
  function shelf(c: HarnessCategory, group: string, items: HarnessEntry[], marks: NavMarks, openByDefault: boolean) {
    const key = c + '/' + group;
    const isOpen = words().length ? true : open.get(key) ?? openByDefault;
    const toggle = h('button.harness-group', { type: 'button', 'aria-expanded': String(isOpen) }, h('span', { 'aria-hidden': 'true' }, isOpen ? '▾ ' : '▸ '), group, h('span.harness-count', {}, String(items.length)));
    toggle.onclick = () => { open.set(key, !isOpen); render(); };
    const section = h('section.harness-shelf', { 'aria-label': `${c} / ${group}` }, toggle);
    if (!isOpen) return section;
    const limit = shown.get(key) ?? SHELF_PAGE;
    section.append(...items.slice(0, limit).map((e) => item(e, marks)));
    if (items.length > limit) {
      const more = h('button.btn.harness-more', { type: 'button' }, `Show ${Math.min(SHELF_PAGE, items.length - limit)} more (${items.length - limit} not shown)`);
      more.onclick = () => { shown.set(key, limit + SHELF_PAGE); render(); };
      section.append(more);
    }
    return section;
  }
  function shelves(c: HarnessCategory, items: HarnessEntry[], marks: NavMarks) {
    const groups = new Map<string, HarnessEntry[]>();
    for (const e of items) { const g = groups.get(e.group); if (g) g.push(e); else groups.set(e.group, [e]); }
    const names = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    const total = entries.filter((e) => e.category === c).length;
    return names.map((g, i) => shelf(c, g, groups.get(g)!, marks, total <= OPEN_ALL || i === 0));
  }
  /** Renders the column and the shelves; returns how many elements match (for the library's empty states). */
  function render(): number {
    const w = words();
    const counts = new Map<HarnessCategory, number>(), partial = new Map<HarnessCategory, number>();
    for (const e of entries) {
      counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
      if (problem(e.source)) partial.set(e.category, (partial.get(e.category) ?? 0) + 1);
    }
    cats.replaceChildren(...HARNESS_CATEGORIES.map((c) => categoryButton(c, counts.get(c) ?? 0, partial.get(c) ?? 0)));
    const marks = opts.marks();
    const hits = entries.filter((e) => (all() || e.category === category) && matches(e, w));
    const inCategory = counts.get(category) ?? 0;
    const head: (HTMLElement | null)[] = [
      all() ? h('h4', {}, `Search in all categories: ${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`) : h('h4', {}, `${category} · ${w.length ? hits.length + ' of ' : ''}${inCategory}`),
      all() ? null : h('p.harness-purpose', { title: 'What this category is for' }, HARNESS_CATEGORY_PURPOSE[category]),
      limited ? h('p.harness-truncated', { role: 'note' }, `Catalog truncated: ${all() ? hits.length : inCategory} shown here of ${entries.length} listed; discovery stops at ${HARNESS_CATALOG_LIMIT.toLocaleString('en')} elements, so sources walked after the limit (machine and OpenViking folders come after the project's) are incomplete. Narrow the published folders, or filter by category and source.`) : null];
    heading.replaceChildren(...head.filter((n): n is HTMLElement => !!n));
    if (all()) {
      const byCategory = HARNESS_CATEGORIES.filter((c) => hits.some((e) => e.category === c));
      list.replaceChildren(...byCategory.flatMap((c) => [h('h5.harness-cat-head', {}, c), ...shelves(c, hits.filter((e) => e.category === c), marks)]));
    } else list.replaceChildren(...shelves(category, hits, marks));
    if (entries.length && !hits.length) {
      const clear = h('button.btn', { type: 'button' }, 'Clear filters');
      clear.onclick = () => { search.value = ''; scope.value = 'category'; opts.onClear?.(); changed(); search.focus?.(); };
      list.append(h('div.harness-state', {}, h('p', {}, w.length ? 'No matching resources.' : `No ${category} here yet.`), w.length ? clear : null));
    }
    return hits.length;
  }
  // Whoever holds the list (the library) re-filters it and renders; alone, the navigator renders itself.
  const changed = () => (opts.onFilter ? opts.onFilter() : render());
  search.oninput = changed;
  scope.onchange = changed;
  return {
    el, heading, list, search, scope,
    get category() { return category; },
    /** Takes a new list (the catalog, filtered to the context and the source); the chosen category stays, or moves to the first with elements when it has none. */
    set(next: HarnessEntry[], catalog: Pick<HarnessCatalog, 'sources' | 'limited'>) {
      entries = next;
      sources = catalog.sources;
      limited = catalog.limited;
      if (!entries.some((e) => e.category === category)) category = HARNESS_CATEGORIES.find((c) => entries.some((e) => e.category === c)) ?? category;
      return render();
    },
    /** Shows `id`'s category and opens its shelf (an element picked from elsewhere, or just created). */
    reveal(id: string) {
      const e = entries.find((x) => x.id === id);
      if (!e) return;
      if (!all()) category = e.category;
      open.set(e.category + '/' + e.group, true);
      const items = entries.filter((x) => x.category === e.category && x.group === e.group);
      const at = items.findIndex((x) => x.id === id);
      if (at >= (shown.get(e.category + '/' + e.group) ?? SHELF_PAGE)) shown.set(e.category + '/' + e.group, at + 1);
      render();
    },
    render,
    clear() { search.value = ''; scope.value = 'category'; },
  };
}

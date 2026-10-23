import { h } from '../../../ui/dom';
import type { HarnessCatalog, HarnessText } from '../../../../shared/harness';
import { HARNESS_LEVELS, type HarnessLayer, type HarnessLevel } from '../../../../shared/harness-cascade';
import { HARNESS_LEVEL_NAMES, type HarnessHierarchyView } from '../../../../shared/harness-navigation';
import { resourceModel, setResource } from './model';
import { experiencePanel } from './experience';
import './style.css';

/** Edits one explicitly selected scope. A save never mutates an accepted execution. */
export function hierarchyPanel(floor: string, signal: AbortSignal) {
  let view: HarnessHierarchyView | undefined, catalog: HarnessCatalog | undefined;
  let draft: HarnessLayer = {}, pending = false, ticket = 0, dirty = false;
  const nav = h('div.harness-levels');
  const rows = h('div.harness-resource-checks');
  const status = h('p', { role: 'status' });
  const filter = h('input', { type: 'search', placeholder: 'Hledat nástroj…', 'aria-label': 'Hledat výbavu' });
  const save = h('button.btn.primary', { type: 'button' }, 'Uložit výbavu');
  const reload = h('button.btn', { type: 'button' }, 'Znovu načíst');
  const bind = h('button.btn', { type: 'button', hidden: true }, 'Připojit otevřenou Oporu');
  const advanced = h('textarea', { rows: 7, spellcheck: false, 'aria-label': 'Harness layer JSON' });
  const origins = h('pre.harness-effective');
  const preview = h('pre.harness-effective');
  const experience = experiencePanel(floor, () => view, signal, () => renderRows());
  const el = h('details.harness-cascade', {}, h('summary', {}, 'Pracovní výbava: Globál → Projekt → Stránka → Vrstva → Oblast → Sektor → Karta'),
    h('p', {}, 'Zaškrtněte prostředky pro vybranou úroveň. Zděděné prostředky lze vypnout nebo obnovit. Změna výběru úrovně zahodí neuložené úpravy. Uložené nastavení se použije při přípravě další práce.'),
    nav, status, bind, experience.el, h('div.harness-profile-grid', {}, h('section', {}, filter, rows), h('section', {},
      h('details', {}, h('summary', {}, 'Pokročilé sloty a nastavení'), advanced),
      h('details', {}, h('summary', {}, 'Účinné prostředky a původ'), origins),
      h('details', {}, h('summary', {}, 'Náhled uloženého kontextu'), preview))),
    h('div.harness-toolbar', {}, save, reload));
  const writable = () => !!view?.writable && !pending;
  function navigation() {
    if (!view) return;
    const current = view;
    nav.replaceChildren(...HARNESS_LEVELS.map(level => {
      const select = h('select', { 'aria-label': HARNESS_LEVEL_NAMES[level], disabled: pending });
      if (level === 'global' || level === 'repository') {
        select.append(h('option', { value: '', disabled: true }, 'Vybrat…'), h('option', { value: level }, HARNESS_LEVEL_NAMES[level]));
        select.value = current.level === level ? level : '';
        select.onchange = () => void load('', level);
      } else {
        const ancestorLevels = HARNESS_LEVELS.slice(2, HARNESS_LEVELS.indexOf(level));
        const choices = current.choices.filter(choice => choice.level === level && ancestorLevels.every(ancestor => {
          const selected = current.path.find(node => node.level === ancestor);
          return !selected || choice.ancestry[ancestor as keyof typeof choice.ancestry] === selected.node;
        }));
        select.append(h('option', { value: '', disabled: true }, choices.length ? 'Vybrat…' : 'Bez uzlů'), ...choices.map(choice => h('option', { value: choice.key }, choice.name)));
        select.value = current.path.find(node => node.level === level)?.node ?? '';
        select.disabled ||= !choices.length;
        select.onchange = () => void load(select.value, level);
      }
      return h('label', {}, HARNESS_LEVEL_NAMES[level], select);
    }));
  }
  function renderRows() {
    if (!view) return;
    const model = resourceModel(view, draft), words = filter.value.toLowerCase().trim().split(/\s+/);
    const entries = [...(catalog?.entries ?? [])];
    for (const value of Object.values(model.effective)) if (value.binding && 'resource' in value.binding) {
      const id = value.binding.resource;
      if (!entries.some(entry => entry.id === id)) entries.push({ id, title: 'Nedostupný prostředek: ' + id, category: 'instructions', source: 'uložené nastavení', path: id });
    }
    rows.replaceChildren(...entries.filter(entry => words.every(word => (entry.title + ' ' + entry.category + ' ' + entry.path).toLowerCase().includes(word))).map(entry => {
      const active = Object.values(model.effective).filter(item => item.binding && 'resource' in item.binding && item.binding.resource === entry.id);
      const inherited = Object.values(model.upstream).some(item => item.binding && 'resource' in item.binding && item.binding.resource === entry.id);
      const checkbox = h('input', { type: 'checkbox', checked: active.length > 0, disabled: !writable(), 'aria-label': entry.title });
      checkbox.onchange = () => { draft = setResource(view!, draft, entry.id, checkbox.checked); changed(); };
      const restore = h('button.btn', { type: 'button', disabled: !writable(), onclick: () => { draft = setResource(view!, draft, entry.id, 'inherit'); changed(); } }, 'Dědit');
      const origin = active.length ? [...new Set(active.map(item => HARNESS_LEVEL_NAMES[item.scope] + (item.nodeName ? ' / ' + item.nodeName : '')))].join(', ') : inherited ? 'Zděděný prostředek vypnutý zde' : 'Nepoužívá se';
      return h('div.harness-resource-check', {}, h('label', {}, checkbox, h('span', {}, h('strong', {}, entry.title), h('small', {}, entry.category + ' · ' + origin), experience.badge(entry.id))), restore);
    }));
  }
  function render() {
    if (!view) return;
    const model = resourceModel(view, draft);
    renderRows();
    advanced.value = JSON.stringify(draft, null, 2); advanced.disabled = !writable();
    origins.textContent = JSON.stringify(model.effective, null, 2); preview.textContent = view.preview || view.warning;
    save.disabled = !writable() || !dirty; reload.disabled = pending;
    bind.hidden = !view.canBind || (!!view.bound && !view.notice); bind.disabled = pending;
    bind.textContent = view.bound ? 'Změnit připojení na otevřenou Oporu' : 'Připojit otevřenou Oporu';
    navigation();
  }
  function changed() { dirty = true; render(); status.textContent = 'Neuložené úpravy pro ' + HARNESS_LEVEL_NAMES[view!.level] + '.'; }
  async function load(target = view?.target ?? '', level: HarnessLevel = view?.level ?? 'repository', operation?: 'save' | 'bind') {
    if (pending) return;
    const seq = ++ticket; pending = true; status.textContent = operation === 'save' ? 'Ukládání…' : 'Načítání…'; render();
    try {
      const body = operation === 'save' ? { op: 'save', scope: level, layer: draft, revision: view?.revision, pathDigest: view?.pathDigest }
        : operation === 'bind' ? { op: 'bind', ...view?.linked, revision: view?.bindingRevision, rebind: !!view?.bound } : undefined;
      const response = await fetch('/api/harness/hierarchy?' + new URLSearchParams({ floor, node: target, scope: level }), {
        signal, method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Konfiguraci nelze načíst.');
      if (signal.aborted || seq !== ticket) return;
      view = data; draft = { ...view!.layers[view!.level] }; dirty = false;
      experience.reset();
      status.textContent = [HARNESS_LEVEL_NAMES[view!.level], 'revize ' + view!.revision, view!.notice, view!.warning, view!.writable ? '' : 'Pouze ke čtení'].filter(Boolean).join(' · ');
    } catch (error) { if (!signal.aborted && seq === ticket) status.textContent = (error as Error).message; }
    finally { if (seq === ticket) { pending = false; render(); } }
  }
  filter.oninput = render;
  advanced.onchange = () => {
    try {
      const parsed = JSON.parse(advanced.value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length > 64) throw new Error('Očekává se objekt nejvýše 64 slotů.');
      for (const [key, value] of Object.entries(parsed)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(key)) throw new Error('Neplatný název slotu.');
        if (value !== null && (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('resource' in value && typeof value.resource === 'string' || 'value' in value && ['string', 'number', 'boolean'].includes(typeof value.value)))) throw new Error('Slot musí obsahovat resource, value nebo null.');
      }
      draft = parsed; changed();
    }
    catch (error) { status.textContent = (error as Error).message; save.disabled = true; }
  };
  save.onclick = () => void load(undefined, undefined, 'save');
  reload.onclick = () => void load();
  bind.onclick = () => void load('', 'repository', 'bind');
  el.ontoggle = () => { if (el.open && !view && !pending) void load(); };
  return { el, catalog(value: HarnessCatalog) { catalog = value; render(); }, async assign(entry: HarnessText) {
    el.open = true; if (!view) await load();
    if (!writable()) return;
    draft = setResource(view!, draft, entry.id, true); changed();
  } };
}

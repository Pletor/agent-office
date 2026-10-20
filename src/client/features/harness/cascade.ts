import { h } from '../../ui/dom';
import type { HarnessProfile, HarnessScope } from '../../../shared/harness-cascade';
import type { HarnessText } from '../../../shared/harness';

interface View extends HarnessProfile {
  tasks: { id: string; title: string }[];
  writable: boolean; globalWrite: boolean; preview: string; warning: string;
}
/** Independent editor: an exported ad-hoc pack never silently changes persistent assignments. */
export function cascadePanel(floor: string, signal: AbortSignal) {
  let view: View | undefined;
  let loadedTask = '';
  let ticket = 0;
  let saving = false;
  let loading = false;
  const scope = h('select', { 'aria-label': 'Harness scope' }, ...['global', 'repository', 'task'].map((s) => h('option', { value: s }, s)));
  scope.value = 'repository';
  const task = h('input', { placeholder: 'Task ID (from Opora, or custom)', 'aria-label': 'Harness task', list: 'harness-tasks' });
  const tasks = h('datalist', { id: 'harness-tasks' });
  const slot = h('input', { placeholder: 'rules.quality', value: 'rules.quality', 'aria-label': 'Harness slot' });
  const editor = h('textarea', { rows: 7, spellcheck: false, 'aria-label': 'Harness layer JSON' });
  const save = h('button.btn.primary', { type: 'button' }, 'Save layer');
  const reload = h('button.btn', { type: 'button' }, 'Load task / reload');
  const status = h('p', { role: 'status' });
  const effective = h('pre.harness-effective');
  const preview = h('pre.harness-effective');
  const el = h('details.harness-cascade', {}, h('summary', {}, 'Inheritance: Global → Repository → Task'),
    h('p', {}, 'Named slots work like CSS: task overrides repository, which overrides global. Missing key = inherit; null = disable. Delete an override to inherit again. Save explicitly; changing task/scope discards unsaved edits. Global binds handbook, machine, published and OpenViking elements only; a project element (el:project:…) is bound at repository or task scope.'),
    h('div.harness-profile-grid', {}, h('section', {}, h('div.harness-toolbar', {}, scope, task, tasks, reload),
    h('label', {}, 'Assignment slot (used by “Assign resource”): ', slot),
    h('p', {}, 'Resource: {"rules.quality":{"resource":"guide:testing"}} · Setting: {"settings.language":{"value":"cs"}}'),
    editor, save, status), h('section', {},
    h('details', {}, h('summary', {}, 'Effective slots and their origins'), effective),
    h('details', {}, h('summary', {}, 'Resolved handoff preview (saved settings)'), preview))));
  function render() {
    if (!view) return;
    editor.value = JSON.stringify(view.layers[scope.value as HarnessScope], null, 2);
    editor.disabled = save.disabled = !view.writable || (scope.value === 'global' && !view.globalWrite);
    effective.textContent = JSON.stringify(view.effective, null, 2);
    preview.textContent = view.preview || view.warning;
    status.textContent = `Revision ${view.revision}. ` + (view.warning ? 'Handoff blocked: ' + view.warning : 'Saved configuration ready.') + (view.writable ? '' : ' Read-only.');
    tasks.replaceChildren(...view.tasks.map((t) => h('option', { value: t.id, label: t.title })));
  }
  async function load(write = false) {
    if (saving) return;
    const seq = ++ticket;
    const target = task.value.trim();
    saving = write;
    loading = true;
    save.disabled = true;
    status.textContent = write ? 'Saving…' : 'Loading…';
    try {
      if (write && target !== loadedTask) throw new Error('Load this task before saving.');
      const response = await fetch('/api/harness/profile?' + new URLSearchParams({ floor, task: target }), {
        signal, method: write ? 'POST' : 'GET', headers: { 'content-type': 'application/json' },
        ...(write ? { body: JSON.stringify({ scope: scope.value, layer: JSON.parse(editor.value), revision: view?.revision }) } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not load profiles');
      if (seq !== ticket || signal.aborted) return;
      view = data; loadedTask = target; render();
    } catch (err) { if (!signal.aborted && seq === ticket) status.textContent = (err as Error).message; }
    finally { if (seq === ticket) { saving = false; loading = false; save.disabled = !view?.writable || (scope.value === 'global' && !view.globalWrite); } }
  }
  scope.onchange = render;
  reload.onclick = () => void load();
  save.onclick = () => void load(true);
  el.ontoggle = () => { if (el.open && !view && !loading) void load(); };
  return { el, async assign(entry: HarnessText) {
    el.open = true;
    if (!view) await load();
    if (!view || !view.writable || (scope.value === 'global' && !view.globalWrite)) { status.textContent = 'These profiles are read-only or unavailable.'; return; }
    try {
      const layer = JSON.parse(editor.value);
      if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(slot.value)) throw new Error('Choose a named assignment slot.');
      layer[slot.value] = { resource: entry.id };
      editor.value = JSON.stringify(layer, null, 2);
      status.textContent = 'Resource assigned in the editor. Save layer to apply.';
    } catch (err) { status.textContent = (err as Error).message; }
  } };
}

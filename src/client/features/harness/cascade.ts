import { h } from '../../ui/dom';
import { HARNESS_LEVELS, type HarnessLevel, type HarnessProfile } from '../../../shared/harness-cascade';
import type { HarnessText } from '../../../shared/harness';

interface View extends HarnessProfile {
  tasks: { id: string; title: string }[];
  audit: { at: string; revision: number; level: string; node: string; repo?: string; by: string; slots: string[] }[];
  writable: boolean; globalWrite: boolean; preview: string; warning: string;
  /** A save that committed but whose response couldn't be finished: `warning` says so, and `tasks` and `audit` are not the floor's. */
  incomplete?: boolean;
}
/** Independent editor: an exported ad-hoc pack never silently changes persistent assignments. */
export function cascadePanel(floor: string, signal: AbortSignal) {
  let view: View | undefined;
  let loadedTask = '';
  let ticket = 0;
  let saving = false;
  let loading = false;
  /** Whether the view on show is the answer to a save (it says "Saved as revision N"). */
  let saved = false;
  const scope = h('select', { 'aria-label': 'Harness scope' }, ...HARNESS_LEVELS.map((s) => h('option', { value: s }, s === 'project' ? 'project (repository)' : s)));
  scope.value = 'project';
  const task = h('input', { placeholder: 'Task or node ID (from Opora, or custom)', 'aria-label': 'Harness task', list: 'harness-tasks' });
  const tasks = h('datalist', { id: 'harness-tasks' });
  const slot = h('input', { placeholder: 'rules.quality', value: 'rules.quality', 'aria-label': 'Harness slot' });
  const editor = h('textarea', { rows: 7, spellcheck: false, 'aria-label': 'Harness layer JSON' });
  const save = h('button.btn.primary', { type: 'button' }, 'Save layer');
  const reload = h('button.btn', { type: 'button' }, 'Load task / reload');
  const status = h('p', { role: 'status' });
  const effective = h('table.harness-effective-table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Slot'), h('th', {}, 'Value'), h('th', {}, 'Level'), h('th', {}, 'Node'))), h('tbody'));
  const noArea = h('p.harness-notice', { role: 'note', hidden: '' }, 'No area level: this target has no area on its path.');
  const preview = h('pre.harness-effective');
  const audit = h('pre.harness-effective');
  const where = h('p', { role: 'status' });
  const el = h('details.harness-cascade', {}, h('summary', {}, 'Inheritance: ' + HARNESS_LEVELS.map((l) => l[0].toUpperCase() + l.slice(1)).join(' → ')),
    h('p', {}, 'Named slots work like CSS: each level overrides the ones above it, down to the task. Missing key = inherit; null = disable. Delete an override to inherit again. A level sets only its own slots; siblings never see each other. Save explicitly; changing task/scope discards unsaved edits.'),
    h('div.harness-profile-grid', {}, h('section', {}, h('div.harness-toolbar', {}, scope, task, tasks, reload), where,
    h('label', {}, 'Assignment slot (used by “Assign resource”): ', slot),
    h('p', {}, 'Resource: {"rules.quality":{"resource":"guide:testing"}} · Setting: {"settings.language":{"value":"cs"}}'),
    editor, save, status), h('section', {},
    h('details', {}, h('summary', {}, 'Effective slots and their origins'), noArea, effective),
    h('details', {}, h('summary', {}, 'Resolved handoff preview (saved settings)'), preview),
    h('details', {}, h('summary', {}, 'Latest saves (audit)'), audit))));
  /** Whether the loaded node has a level: global and project always, the rest only on its way down. */
  const onPath = (level: string) => level === 'global' || level === 'project' || view!.path.some((p) => p.level === level);
  const canSave = () => !!view && view.writable && !(scope.value === 'global' && !view.globalWrite) && onPath(scope.value);
  function render() {
    if (!view) return;
    editor.value = JSON.stringify(view.layers[scope.value as HarnessLevel], null, 2);
    editor.disabled = save.disabled = !canSave();
    where.textContent = view.path.length ? 'Path: ' + view.path.map((p) => `${p.level} ${p.name ?? p.node}`).join(' › ') : 'Path: project only (load a task or node to edit the levels below).';
    const names = new Map(view.path.map((p) => [p.node, p.name ?? '']));
    /** The node's name, or its key when the canvas gave it no name (a custom task has only its id): never a blank cell. */
    const named = (node: string, name?: string) => name || names.get(node) || node;
    const rows = Object.entries(view.effective).map(([slot, e]) => h('tr', {}, h('td', {}, slot), h('td', {}, e.binding === null ? 'null (disabled)' : 'resource' in e.binding ? 'resource ' + e.binding.resource : JSON.stringify(e.binding.value)), h('td', {}, e.scope), h('td', { title: e.node ?? '' }, e.node ? named(e.node, e.nodeName) : '—')));
    effective.querySelector('tbody')!.replaceChildren(...(rows.length ? rows : [h('tr', {}, h('td', { colspan: '4' }, 'No slots are set at any level.'))]));
    noArea.hidden = !view.path.length || view.path.some((p) => p.level === 'area');
    const lines = view.audit.map((a) => `${a.at} r${a.revision} ${a.level}${a.node ? ' ' + (names.get(a.node) || a.node) : ''} by ${a.by || '—'}: ${a.slots.length ? a.slots.join(', ') : 'removed'}`);
    audit.textContent = view.incomplete ? ['The latest saves could not be loaded with this save: reload to see them.', ...lines].join('\n') : lines.join('\n') || 'No saves yet.';
    preview.textContent = view.preview || view.warning;
    // A committed save whose response couldn't be finished says so in its warning ("Saved as revision N, but…"): saved, not blocked.
    const outcome = view.incomplete ? view.warning : view.warning ? 'Handoff blocked: ' + view.warning : 'Saved configuration ready.';
    status.textContent = (view.incomplete ? '' : saved ? `Saved as revision ${view.revision}. ` : `Revision ${view.revision}. `) + outcome + (view.writable ? '' : ' Read-only.');
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
        ...(write ? { body: JSON.stringify({ scope: scope.value, layer: JSON.parse(editor.value), revision: view?.revision, at: view?.path.find((p) => p.level === scope.value)?.node ?? '' }) } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not load profiles');
      if (seq !== ticket || signal.aborted) return;
      // An incomplete answer to a save keeps the task list and audit on show rather than blanking them.
      view = data.incomplete && view ? { ...data, tasks: view.tasks, audit: view.audit } : data;
      loadedTask = target; saved = write; render();
    } catch (err) { if (!signal.aborted && seq === ticket) status.textContent = (err as Error).message; }
    finally { if (seq === ticket) { saving = false; loading = false; save.disabled = !canSave(); } }
  }
  scope.onchange = render;
  reload.onclick = () => void load();
  save.onclick = () => void load(true);
  el.ontoggle = () => { if (el.open && !view && !loading) void load(); };
  return { el, async assign(entry: HarnessText) {
    el.open = true;
    if (!view) await load();
    if (!canSave()) { status.textContent = view ? 'This level is read-only here, or the loaded node has no such level.' : 'These profiles are read-only or unavailable.'; return; }
    try {
      const layer = JSON.parse(editor.value);
      if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(slot.value)) throw new Error('Choose a named assignment slot.');
      layer[slot.value] = { resource: entry.id };
      editor.value = JSON.stringify(layer, null, 2);
      status.textContent = 'Resource assigned in the editor. Save layer to apply.';
    } catch (err) { status.textContent = (err as Error).message; }
  } };
}

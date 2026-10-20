import { h } from '../../ui/dom';
import { HARNESS_LEVELS, pathNode, type HarnessLevel, type HarnessProfile } from '../../../shared/harness-cascade';
import type { HarnessText } from '../../../shared/harness';
import { contextFloor, contextLevel, latest, levelName, ownAudit, sameContext, type AuditEntry, type HarnessContext } from './context-model';

export interface CascadeView extends HarnessProfile {
  tasks: { id: string; title: string }[];
  audit: AuditEntry[];
  writable: boolean; globalWrite: boolean; preview: string; warning: string;
}

/**
 * "This level's own settings": the editor of the one level the context bar chose (Global, a project, or
 * one specialization of it), showing only the slots that level sets itself. What everything adds up to
 * is the separate "What the worker receives" panel (receives.ts), fed through `onView`.
 *
 * Every load goes through one `latest()`: a reply that arrives after the context moved on is dropped,
 * never shown for the new context. Edits are explicit: `dirty()` says whether the editor differs from
 * what was loaded, and the library asks before a switch would throw them away (context-bar.ts guard).
 * An exported ad-hoc pack never silently changes persistent assignments.
 */
export function cascadePanel(opts: { opened: string; signal: AbortSignal; label(ctx: HarnessContext): string; repoOf(floor: string): string | undefined; onView(view: CascadeView, ctx: HarnessContext): void; onError?(ctx: HarnessContext, message: string): void }) {
  let ctx: HarnessContext | undefined;
  let view: CascadeView | undefined;
  /** The editor's text as it was loaded or saved: anything else is an unsaved edit. */
  let loadedText = '';
  let saving = false;
  const requests = latest(opts.signal);
  const summary = h('summary', {}, "This level's own settings");
  const heading = h('h3', {}, "This level's own settings");
  const where = h('p.harness-where', { role: 'status' });
  const slot = h('input', { placeholder: 'rules.quality', value: 'rules.quality', 'aria-label': 'Harness slot' });
  const editor = h('textarea', { rows: 7, spellcheck: false, 'aria-label': 'Harness layer JSON' });
  const save = h('button.btn.primary', { type: 'button' }, 'Save layer');
  const reset = h('button.btn', { type: 'button' }, 'Discard changes');
  const reload = h('button.btn', { type: 'button' }, 'Reload');
  const status = h('p.harness-save-status', { role: 'status' });
  const noArea = h('p.harness-notice', { role: 'note', hidden: '' }, 'No area level: this target has no area on its path.');
  const audit = h('pre.harness-effective.harness-audit');
  const el = h('details.harness-cascade', {}, summary, heading,
    h('p', {}, 'Named slots work like CSS: each level overrides the ones above it, down to the task (' + HARNESS_LEVELS.map(levelName).join(' → ') + '). Only this level’s own slots are here; what a worker ends up with is in “What the worker receives”. Missing key = inherit; null = disable. Delete an override to inherit again. Siblings never see each other. Save explicitly.'),
    where, noArea,
    h('label', {}, 'Assignment slot (used by “Assign resource”): ', slot),
    h('p', {}, 'Resource: {"rules.quality":{"resource":"guide:testing"}} · Setting: {"settings.language":{"value":"cs"}}'),
    editor, h('div.harness-actions', {}, save, reset, reload), status,
    h('details', {}, h('summary', {}, 'Latest saves (audit)'), audit));

  const level = (): HarnessLevel => (ctx ? contextLevel(ctx) : 'project');
  /** The level as the loaded path has it: a specialization must still be on the canvas, at the level it was chosen at. */
  const placed = () => !!view && !!ctx && (ctx.kind !== 'node' || pathNode(view.path, ctx.level)?.node === ctx.node);
  const canSave = () => !!view && !saving && view.writable && !(level() === 'global' && !view.globalWrite) && placed();
  const dirty = () => !!view && editor.value !== loadedText;
  function controls() {
    editor.disabled = !canSave();
    save.disabled = !canSave() || !dirty();
    reset.disabled = saving || !dirty();
    reload.disabled = saving;
  }
  function title(c: HarnessContext) {
    summary.textContent = "This level's own settings · " + opts.label(c).split(' › ').pop();
    heading.textContent = "This level's own settings: " + opts.label(c);
  }
  /** This level's own saves only (an administrator's reply carries every project's). */
  function renderAudit() {
    if (!view || !ctx) return;
    const names = new Map(view.path.map((p) => [p.node, p.name ?? '']));
    audit.textContent = ownAudit(view.audit, ctx, opts.repoOf(contextFloor(ctx, opts.opened))).map((a) => `${a.at} r${a.revision} ${a.level}${a.node ? ' ' + (names.get(a.node) || a.node) : ''} by ${a.by || '—'}: ${a.slots.length ? a.slots.join(', ') : 'removed'}`).join('\n') || 'No saves of this level among the latest 20.';
  }
  function render() {
    if (!view || !ctx) return;
    title(ctx);
    loadedText = editor.value = JSON.stringify(view.layers[level()] ?? {}, null, 2);
    where.textContent = ctx.kind === 'global' ? 'Editing Global: the layer every project inherits.'
      : ctx.kind === 'project' ? 'Editing the project layer: it overrides Global for this project and everything in it.'
      : `Editing the ${ctx.level} “${ctx.name}”: its slots override the levels above it, for it and everything under it.`;
    noArea.hidden = ctx.kind !== 'node' || !view.path.length || view.path.some((p) => p.level === 'area');
    renderAudit();
    status.textContent = !placed() ? 'This node is no longer at that level on the canvas: choose it again in the context bar.'
      : `Revision ${view.revision}. ` + (view.writable && !(level() === 'global' && !view.globalWrite) ? '' : 'Read-only here.');
    controls();
  }
  function url(c: HarnessContext) {
    return '/api/harness/profile?' + new URLSearchParams({ floor: contextFloor(c, opts.opened), ...(c.kind === 'node' ? { node: c.node } : {}) });
  }
  async function load(write = false) {
    // A save in flight is never aborted by a reload or a switch: its reply decides what the editor shows.
    if (!ctx || saving || (write && !canSave())) return;
    const c = ctx;
    const turn = requests.next();
    const at = c.kind === 'node' && view ? pathNode(view.path, c.level)?.node : undefined;
    let body: string | undefined;
    try { if (write) body = JSON.stringify({ scope: level(), layer: JSON.parse(editor.value), revision: view?.revision, ...(at ? { at } : {}) }); }
    catch (err) { status.textContent = 'The layer is not valid JSON: ' + (err as Error).message; return; }
    saving = write;
    controls();
    status.textContent = write ? 'Saving…' : 'Loading…';
    try {
      const response = await fetch(url(c), { signal: turn.signal, method: write ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body } : {}) });
      const data = await response.json();
      if (!turn.current() || !ctx || !sameContext(c, ctx)) return;
      if (!response.ok) throw new Error(data.error ?? 'Could not load profiles');
      view = data;
      saving = false;
      render();
      opts.onView(data, c);
    } catch (err) {
      if (!turn.current() || opts.signal.aborted) return;
      saving = false;
      status.textContent = (err as Error).message;
      if (!view) opts.onError?.(c, (err as Error).message);
      controls();
    }
  }
  editor.oninput = controls;
  reload.onclick = () => void load();
  save.onclick = () => void load(true);
  reset.onclick = () => { editor.value = loadedText; controls(); };
  return {
    el,
    dirty,
    /** A save is in flight: the context must not change under it. */
    busy: () => saving,
    /** Shows `next`'s own level, dropping whatever was loaded or loading for the one before. */
    show(next: HarnessContext) {
      ctx = next;
      view = undefined;
      loadedText = editor.value = '';
      saving = false;
      title(next);
      where.textContent = '';
      audit.textContent = '';
      noArea.hidden = true;
      controls();
      void load();
    },
    /** Throws the unsaved edits away (the editor goes back to what was loaded). */
    discard() { editor.value = loadedText; controls(); },
    reload: () => void load(),
    /** Names the context again (the project names may have come in since it was shown). */
    retitle() { if (ctx) title(ctx); renderAudit(); },
    async assign(entry: HarnessText) {
      el.open = true;
      if (!canSave()) { status.textContent = saving ? 'Saving… assign again once it is done.' : !view ? 'Loading this level… assign again in a moment.' : 'This level is read-only here.'; return; }
      try {
        const layer = JSON.parse(editor.value);
        if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(slot.value)) throw new Error('Choose a named assignment slot.');
        layer[slot.value] = { resource: entry.id };
        editor.value = JSON.stringify(layer, null, 2);
        status.textContent = 'Resource assigned in the editor. Save layer to apply.';
        controls();
      } catch (err) { status.textContent = (err as Error).message; }
    },
  };
}

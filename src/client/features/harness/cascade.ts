import { h } from '../../ui/dom';
import { HARNESS_LEVELS, pathNode, type HarnessBinding, type HarnessLayer, type HarnessLevel, type HarnessProfile } from '../../../shared/harness-cascade';
import type { HarnessResourceState } from '../../../shared/harness';
import { contextFloor, contextLevel, latest, levelName, ownAudit, sameContext, type AuditEntry, type HarnessContext } from './context-model';
import { describeBinding, diffLayers, inheritedAt, parseLayerText, rebase, slotProblem, slotRows, usageOf } from './slots-model';
import { conflictNotice, slotEditor } from './slot-editor';

export interface CascadeView extends HarnessProfile {
  tasks: { id: string; title: string }[];
  audit: AuditEntry[];
  writable: boolean; globalWrite: boolean; preview: string; warning: string;
  /** The state of every element the layers assign (harness/resources.ts); absent from older replies. */
  resources?: Record<string, HarnessResourceState>;
  /** A save that committed but whose response couldn't be finished: `warning` says so, and `tasks` and `audit` are not the floor's. */
  incomplete?: boolean;
}

/**
 * "This level's own settings": the editor of the one level the context bar chose (Global, a project, or
 * one specialization of it). Its slots are a list (slot-editor.ts), each inherited, own or disabled, with
 * Assign, Reset to inherited, Disable and value editing; nothing has to be typed as JSON. Edits make a
 * draft, listed as "slot: from → to" until Save layer stores it at the revision it was opened on, or
 * Discard changes drops it. A 409 shows what changed on the server since and offers Reload or Keep
 * editing (the draft rebased on top). The raw layer stays under "Advanced: JSON" and edits the same draft.
 * What everything adds up to is the separate "What the worker receives" panel (receives.ts), fed through `onView`.
 *
 * Every load goes through one `latest()`: a reply that arrives after the context moved on is dropped,
 * never shown for the new context. `dirty()` says whether the draft differs from what was loaded, and the
 * library asks before a switch would throw it away (context-bar.ts guard). An exported ad-hoc pack never
 * changes persistent assignments.
 */
export function cascadePanel(opts: {
  opened: string; signal: AbortSignal; label(ctx: HarnessContext): string; repoOf(floor: string): string | undefined;
  onView(view: CascadeView, ctx: HarnessContext): void; onError?(ctx: HarnessContext, message: string): void;
  /** The element open in the library (what Assign assigns), and the title of an element by ID. */
  selected?(): { id: string; title: string } | undefined; titleOf?(id: string): string | undefined;
  /** The draft or the saved layers changed: marks elsewhere (the navigator, the detail's usage) follow. */
  onChange?(): void;
}) {
  let ctx: HarnessContext | undefined;
  let view: CascadeView | undefined;
  /** The level's layer as saved (the revision the draft was opened on), and the draft on top of it. */
  let base: HarnessLayer = {};
  let draft: HarnessLayer = {};
  /** The text "Advanced: JSON" was last given: anything else in it is an edit not applied yet. */
  let jsonShown = '';
  let jsonError = '';
  let saving = false;
  /** A plain load is in flight (edits wait for it), or a 409 is being read back (the editor stays locked until it is shown). */
  let loading = false, resolving = false;
  /** Whether the view on show is the answer to a save (it says "Saved as revision N"). */
  let saved = false;
  /** After a 409: the store's profile now, until the user picks Reload or Keep editing. */
  let server: CascadeView | undefined;
  const requests = latest(opts.signal);
  const summary = h('summary', {}, "This level's own settings");
  const heading = h('h3', {}, "This level's own settings");
  const where = h('p.harness-where', { role: 'status' });
  const json = h('textarea', { rows: 7, spellcheck: false, 'aria-label': 'Harness layer JSON' });
  const reload = h('button.btn', { type: 'button' }, 'Reload');
  const status = h('p.harness-save-status', { role: 'status' });
  const noArea = h('p.harness-notice', { role: 'note', hidden: '' }, 'No area level: this target has no area on its path.');
  const audit = h('pre.harness-effective.harness-audit');
  const slots = slotEditor({ selected: () => opts.selected?.(), set: (slot, b) => edit(slot, b), save: () => void load(true), discard: () => discard() });
  const conflict = conflictNotice(() => resolveConflict(false), () => resolveConflict(true));
  const el = h('details.harness-cascade', {}, summary, heading,
    where, noArea, conflict.el, slots.el,
    h('div.harness-actions', {}, reload), status,
    h('details.harness-help', {}, h('summary', {}, 'How slots work'), h('p', {}, 'Named slots work like CSS: each level overrides the ones above it, down to the task (' + HARNESS_LEVELS.map(levelName).join(' → ') + '). Only this level’s slots are edited here; what a worker ends up with is in “What the worker receives”. Reset to inherited removes this level’s setting, Disable switches the slot off for everything below. Nothing is stored until Save layer.')),
    h('details.harness-advanced', {}, h('summary', {}, 'Advanced: JSON'),
      h('p', {}, 'The same draft as the list above, as the store keeps it: {"rules.quality":{"resource":"guide:testing"}, "settings.language":{"value":"cs"}, "hooks.after":null}. A missing slot inherits; null disables.'), json),
    h('details', {}, h('summary', {}, 'Latest saves (audit)'), audit));

  const level = (): HarnessLevel => (ctx ? contextLevel(ctx) : 'project');
  /** The level as the loaded path has it: a specialization must still be on the canvas, at the level it was chosen at. */
  const placed = () => !!view && !!ctx && (ctx.kind !== 'node' || pathNode(view.path, ctx.level)?.node === ctx.node);
  const canSave = () => !!view && !saving && !loading && !resolving && !server && view.writable && !(level() === 'global' && !view.globalWrite) && placed();
  const changes = () => diffLayers(base, draft);
  const dirty = () => !!view && (changes().length > 0 || json.value !== jsonShown);
  function readOnlyReason(): string {
    if (!view) return '';
    if (!placed()) return 'This node is no longer at that level on the canvas: choose it again in the context bar.';
    if (!view.writable) return 'Read-only: only administrators (and the orchestrator an administrator runs) can change harness profiles. You can read every slot, open elements and build an ad-hoc pack.';
    if (level() === 'global' && !view.globalWrite) return 'Read-only: Global settings are changed in the administrator\'s office.';
    return '';
  }
  function controls() {
    json.disabled = !canSave();
    slots.save.disabled = !canSave() || !dirty() || !!jsonError;
    slots.discard.disabled = saving || !dirty();
    // Reload would drop a draft: Discard changes first (the switcher's guard asks for the same reason).
    reload.disabled = saving || resolving || dirty();
    reload.title = dirty() ? 'Discard changes first: Reload would drop the draft.' : '';
  }
  /** The slot list and the draft bar, from `base`, `draft` and the loaded profile. */
  function renderSlots() {
    if (!view) return;
    const rows = slotRows(inheritedAt(view.layers, view.path, level()), base, draft);
    slots.render({ rows, resources: view.resources ?? {}, titleOf: (id) => opts.titleOf?.(id), readOnly: readOnlyReason(), revision: view.revision, changes: changes(), saving: saving || !!server, jsonError });
    controls();
    opts.onChange?.();
  }
  /** "Advanced: JSON" shows the draft. */
  function showJson() { jsonShown = json.value = JSON.stringify(draft, null, 2); jsonError = ''; }
  function edit(slot: string, binding: HarnessBinding | null | undefined) {
    if (!canSave() || slotProblem(slot)) return;
    draft = { ...draft };
    if (binding === undefined) delete draft[slot]; else draft[slot] = binding;
    showJson();
    status.textContent = changes().length ? 'Draft changed: Save layer to store it.' : 'The draft is as saved again.';
    renderSlots();
  }
  function discard() {
    draft = structuredClone(base);
    showJson();
    renderSlots();
  }
  function title(c: HarnessContext) {
    summary.textContent = "This level's own settings · " + opts.label(c).split(' › ').pop();
    heading.textContent = "This level's own settings: " + opts.label(c);
  }
  /** This level's own saves only: the server filters by level (`auditLevel`), and the client again by repository and node. */
  function renderAudit() {
    if (!view || !ctx) return;
    const names = new Map(view.path.map((p) => [p.node, p.name ?? '']));
    const lines = ownAudit(view.audit, ctx, opts.repoOf(contextFloor(ctx, opts.opened))).map((a) => `${a.at} r${a.revision} ${a.level}${a.node ? ' ' + (names.get(a.node) || a.node) : ''} by ${a.by || '—'}: ${a.slots.length ? a.slots.join(', ') : 'removed'}`);
    audit.textContent = view.incomplete ? ['The latest saves could not be loaded with this save: reload to see them.', ...lines].join('\n') : lines.join('\n') || 'No saves of this level yet.';
  }
  function render() {
    if (!view || !ctx) return;
    title(ctx);
    base = structuredClone(view.layers[level()] ?? {});
    draft = structuredClone(base);
    showJson();
    where.textContent = ctx.kind === 'global' ? 'Editing Global: the layer every project inherits.'
      : ctx.kind === 'project' ? 'Editing the project layer: it overrides Global for this project and everything in it.'
      : `Editing the ${ctx.level} “${ctx.name}”: its slots override the levels above it, for it and everything under it.`;
    noArea.hidden = ctx.kind !== 'node' || !view.path.length || view.path.some((p) => p.level === 'area');
    renderAudit();
    // A committed save whose response couldn't be finished says so in its warning ("Saved as revision N, but…"): saved, not blocked.
    const writable = view.writable && !(level() === 'global' && !view.globalWrite);
    status.textContent = !placed() ? 'This node is no longer at that level on the canvas: choose it again in the context bar.'
      : view.incomplete ? view.warning + (writable ? '' : ' Read-only here.')
      : (saved ? `Saved as revision ${view.revision}. ` : `Revision ${view.revision}. `) + (writable ? '' : 'Read-only here.');
    renderSlots();
  }
  function url(c: HarnessContext) {
    return '/api/harness/profile?' + new URLSearchParams({ floor: contextFloor(c, opts.opened), ...(c.kind === 'node' ? { node: c.node } : {}), auditLevel: contextLevel(c) });
  }
  /** What a failed save says, with what to do about it. */
  function failure(code: number | undefined, message: string, write: boolean): string {
    if (!write) return message;
    if (code === 401) return 'Not saved: your session ended. Sign in again; the draft stays here until you close the library.';
    if (code === 403) return `Not saved: ${message} Ask an administrator to save it.`;
    if (code === 503) return `Not saved: ${message} Nothing was written; try again in a moment.`;
    return `Not saved: ${message}`;
  }
  async function load(write = false) {
    // A save in flight is never aborted by a reload or a switch: its reply decides what the editor shows.
    if (!ctx || saving || (write && !canSave())) return;
    if (write && json.value !== jsonShown) {
      // An edit typed in "Advanced: JSON" and not applied yet is what gets saved, once it is a layer.
      const parsed = parseLayerText(json.value);
      if ('error' in parsed) { jsonError = parsed.error; status.textContent = parsed.error; renderSlots(); return; }
      draft = parsed.layer;
      jsonShown = json.value;
    }
    const c = ctx;
    const turn = requests.next();
    const at = c.kind === 'node' && view ? pathNode(view.path, c.level)?.node : undefined;
    const opened = view?.revision;
    const body = write ? JSON.stringify({ scope: level(), layer: draft, revision: opened, ...(at ? { at } : {}) }) : undefined;
    saving = write;
    loading = !write;
    renderSlots();
    status.textContent = write ? 'Saving…' : 'Loading…';
    try {
      const response = await fetch(url(c), { signal: turn.signal, method: write ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body } : {}) });
      const data = await response.json();
      if (!turn.current() || !ctx || !sameContext(c, ctx)) return;
      loading = false;
      if (write && response.status === 409) { saving = false; return void (await showConflict(c, opened, data.error ?? 'The profile changed elsewhere.')); }
      if (!response.ok) throw Object.assign(new Error(data.error ?? 'Could not load profiles'), { code: response.status });
      if (!data || typeof data.layers !== 'object' || data.layers === null) throw new Error('The profile could not be read: the reply is not a profile.');
      // An incomplete answer to a save keeps the audit on show rather than blanking it.
      view = data.incomplete && view ? { ...data, tasks: view.tasks, audit: view.audit } : data;
      saved = write;
      saving = false;
      server = undefined;
      conflict.hide();
      render();
      opts.onView(view!, c);
    } catch (err) {
      if (!turn.current() || opts.signal.aborted) return;
      saving = loading = false;
      status.textContent = failure((err as { code?: number }).code, (err as Error).message, write);
      if (!view) opts.onError?.(c, (err as Error).message);
      renderSlots();
    }
  }
  /** A 409: reads the store's profile now and lists what changed at this level since the draft was opened. */
  async function showConflict(c: HarnessContext, opened: number | undefined, detail: string) {
    status.textContent = 'Not saved: ' + detail;
    // Its own turn: a reload or a switch meanwhile drops this reply; until it is shown nothing can be edited.
    const turn = requests.next();
    resolving = true;
    renderSlots();
    try {
      const response = await fetch(url(c), { signal: turn.signal });
      const data = await response.json();
      if (!turn.current() || !ctx || !sameContext(c, ctx)) return;
      if (!response.ok) throw new Error(data.error ?? 'The profile could not be read.');
      server = data as CascadeView;
      const resources = { ...(view?.resources ?? {}), ...(server.resources ?? {}) };
      const lines = diffLayers(base, server.layers[level()] ?? {}).map((d) => ({ slot: d.slot, from: describeBinding(d.from, resources, opts.titleOf), to: describeBinding(d.to, resources, opts.titleOf) }));
      conflict.show(opened, server.revision, lines, detail);
    } catch (err) {
      if (!turn.current()) return;
      server = undefined;
      status.textContent = 'Not saved: ' + detail + ' The current profile could not be read (' + (err as Error).message + '): Discard changes and Reload to start again.';
    } finally { if (turn.current()) resolving = false; }
    renderSlots();
  }
  /** Reload: the store's profile, draft dropped. Keep editing: the store's profile with the draft's edits on top. */
  function resolveConflict(keep: boolean) {
    if (!server || !ctx) return;
    const oldBase = base, mine = draft;
    view = server;
    server = undefined;
    conflict.hide();
    saved = false;
    render();
    if (keep) {
      draft = rebase(oldBase, mine, base);
      showJson();
      status.textContent = `Your draft is on top of revision ${view.revision} now: check the changes and Save layer.`;
      renderSlots();
    }
    opts.onView(view, ctx);
  }
  json.oninput = () => {
    const parsed = parseLayerText(json.value);
    if ('error' in parsed) jsonError = parsed.error;
    else { jsonError = ''; draft = parsed.layer; jsonShown = json.value; }
    renderSlots();
  };
  reload.onclick = () => void load();
  return {
    el,
    dirty,
    /** A save is in flight: the context must not change under it. */
    busy: () => saving || resolving,
    /** Shows `next`'s own level, dropping whatever was loaded or loading for the one before. */
    show(next: HarnessContext) {
      ctx = next;
      view = server = undefined;
      base = draft = {};
      jsonShown = json.value = '';
      jsonError = '';
      saving = loading = resolving = false;
      conflict.hide();
      title(next);
      where.textContent = '';
      audit.textContent = '';
      noArea.hidden = true;
      slots.render({ rows: [], resources: {}, titleOf: () => undefined, readOnly: '', revision: undefined, changes: [], saving: false, jsonError: '' });
      controls();
      void load();
    },
    /** Throws the unsaved edits away (the editor goes back to what was loaded). */
    discard,
    reload: () => void load(),
    /** Names the context again (the project names may have come in since it was shown). */
    retitle() { if (ctx) title(ctx); renderAudit(); },
    /** Why Assign can't change this level now ('' when it can). */
    blocked: () => (!view ? 'Loading this level…' : server ? 'Resolve the conflict first: Reload or Keep editing.' : saving ? 'Saving…' : readOnlyReason()),
    /** Re-renders the slot list (the open element changed, so Assign names another one). */
    refresh: () => renderSlots(),
    /** Assigns `entry` to `slot` in the draft (Save layer stores it); returns what happened, or why not. */
    assign(entry: { id: string; title: string }, slot: string): string {
      el.open = true;
      if (!canSave()) return server ? 'Resolve the conflict first: Reload or Keep editing.' : saving ? 'Saving… assign again once it is done.' : !view ? 'Loading this level… assign again in a moment.' : readOnlyReason() || 'This level is read-only here.';
      const bad = slotProblem(slot);
      if (bad) return bad;
      edit(slot, { resource: entry.id });
      return `${entry.title} is assigned to ${slot} in the draft: Save layer to store it.`;
    },
    /** Where `id` is assigned on the loaded path (saved), and whether the draft changes that. */
    usage(id: string): { saved: string[]; draft: boolean } {
      if (!view) return { saved: [], draft: false };
      const names = new Map(view.path.map((p) => [p.level, p.name]));
      const saved = usageOf(id, view.layers, (l) => (l === 'global' || l === 'project' ? levelName(l) : levelName(l) + (names.get(l) ? ' ' + names.get(l) : '')));
      return { saved, draft: changes().some((c) => [c.from, c.to].some((b) => b && 'resource' in b && b.resource === id)) };
    },
    /** IDs the saved layers on the path assign, and IDs the draft assigns: the navigator's ● and ✎ marks. */
    marks(): { saved: Set<string>; draft: Set<string> } {
      const ids = (layer: HarnessLayer) => Object.values(layer).flatMap((b) => (b && 'resource' in b ? [b.resource] : []));
      const saved = new Set(view ? Object.values(view.layers).flatMap(ids) : []);
      return { saved, draft: new Set(changes().flatMap((c) => (c.to && 'resource' in c.to ? [c.to.resource] : []))) };
    },
    /** The slot names this level sets or inherits: what the detail's slot picker suggests. */
    slotNames(): string[] {
      if (!view) return [];
      return [...new Set([...Object.keys(inheritedAt(view.layers, view.path, level())), ...Object.keys(draft)])].sort();
    },
  };
}

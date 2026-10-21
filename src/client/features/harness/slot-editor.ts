// The slot list of "This level's own settings" (docs/harness.md "Categories and the editor"): every slot
// of the edited level with its state (inherited, own, disabled), per-slot Assign, Reset to inherited,
// Disable and value editing; the draft bar with what Save layer would change (slot: from → to); the
// conflict notice after a 409; and the legend that keeps the draft, the saved profile and the ad-hoc pack
// apart. It renders what cascade.ts hands it and reports clicks back; it keeps no profile state of its own.
import './editor.css';
import { h } from '../../ui/dom';
import type { HarnessBinding } from '../../../shared/harness-cascade';
import type { HarnessResourceState } from '../../../shared/harness';
import { describeBinding, parseSetting, settingKind, slotProblem, type SlotChange, type SlotRow } from './slots-model';
import { levelName } from './context-model';

export interface SlotEditorState {
  rows: SlotRow[];
  resources: Record<string, HarnessResourceState>;
  titleOf(id: string): string | undefined;
  /** Why the level can't be changed here ('' when it can): shown instead of the controls' effect. */
  readOnly: string;
  /** The saved profile's revision. */
  revision: number | undefined;
  changes: SlotChange[];
  saving: boolean;
  /** "Advanced: JSON" holds text that isn't a layer: Save layer waits for it. */
  jsonError: string;
}
export interface SlotEditorEvents {
  /** The element to assign (the one open in the library), if any. */
  selected(): { id: string; title: string } | undefined;
  set(slot: string, binding: HarnessBinding | null | undefined): void;
  save(): void;
  discard(): void;
}

const STATE_TEXT = { own: 'Own', disabled: 'Disabled', inherited: 'Inherited', unset: 'Not set' } as const;
const STATE_HELP = {
  own: 'This level sets the slot itself.',
  disabled: 'This level switches the slot off (null): nothing reaches the levels below.',
  inherited: 'This level does not name the slot: it gets what the levels above set.',
  unset: 'Nobody sets this slot: it is not part of the result.',
} as const;

/** The three-way legend: Draft | Saved profile (revision N) | Ad-hoc pack. */
export function legend() {
  const saved = h('span', {}, 'Saved profile');
  const el = h('ul.harness-legend', { 'aria-label': 'Legend' },
    h('li.harness-mark-draft', { title: 'Unsaved edits in this editor: Save layer stores them, Discard changes drops them.' }, h('b', { 'aria-hidden': 'true' }, '✎'), ' Draft (unsaved)'),
    h('li.harness-mark-saved', { title: 'What the profile store holds for this level at this revision.' }, h('b', { 'aria-hidden': 'true' }, '●'), ' ', saved),
    h('li.harness-mark-pack', { title: 'The footer selection: copied or downloaded for a model, never saved to a profile.' }, h('b', { 'aria-hidden': 'true' }, '◆'), ' Ad-hoc pack (exported, never saved)'));
  return { el, revision(n: number | undefined) { saved.textContent = n === undefined ? 'Saved profile' : `Saved profile (revision ${n})`; } };
}

export function slotEditor(events: SlotEditorEvents) {
  const key = legend();
  const readOnly = h('p.harness-readonly', { role: 'note', hidden: '' });
  const list = h('ul.harness-slots', { 'aria-label': 'Slots of this level' });
  const empty = h('p.harness-slots-empty', { hidden: '' }, 'No slot is set or inherited yet. Add one below, or open an element and choose Assign.');
  // Adding a slot this level doesn't have yet.
  const name = h('input', { 'aria-label': 'New slot name', placeholder: 'rules.quality', maxlength: 80, spellcheck: false });
  const kind = h('select', { 'aria-label': 'New slot kind' }, h('option', { value: 'element' }, 'Element (the open one)'), h('option', { value: 'string' }, 'Text setting'), h('option', { value: 'number' }, 'Number setting'), h('option', { value: 'boolean' }, 'On/off setting'));
  const value = h('input', { 'aria-label': 'New slot value', placeholder: 'value' });
  const add = h('button.btn', { type: 'button' }, 'Add slot');
  const addStatus = h('p.harness-field-error', { role: 'status' });
  const adder = h('div.harness-slot-add', {}, h('strong', {}, 'Add a slot'), name, kind, value, add, addStatus);
  // The draft: what Save layer would store.
  const draftTitle = h('h4', {}, 'Draft changes');
  const diff = h('ul.harness-diff', { 'aria-label': 'What Save layer will change' });
  const save = h('button.btn.primary', { type: 'button' }, 'Save layer');
  const discard = h('button.btn', { type: 'button' }, 'Discard changes');
  const draft = h('section.harness-draft', { 'aria-label': 'Draft changes' }, draftTitle, diff, h('div.harness-actions', {}, save, discard));
  // The draft bar comes first and stays in view while the list scrolls: what Save layer will store is always on screen.
  const el = h('div.harness-slot-editor', {}, key.el, readOnly, draft, list, empty, adder);
  let state: SlotEditorState | undefined;

  save.onclick = () => events.save();
  discard.onclick = () => events.discard();
  kind.onchange = () => { value.hidden = kind.value === 'element'; };
  value.hidden = true;
  add.onclick = () => {
    if (!state || state.readOnly) return;
    const slot = name.value.trim();
    const bad = slotProblem(slot);
    if (bad) { addStatus.textContent = bad; return; }
    if (state.rows.some((r) => r.slot === slot && r.own !== undefined)) { addStatus.textContent = `${slot} is already set at this level: change it in its row.`; return; }
    if (kind.value === 'element') {
      const picked = events.selected();
      if (!picked) { addStatus.textContent = 'Open an element in the list first, then add the slot.'; return; }
      events.set(slot, { resource: picked.id });
    } else {
      const parsed = parseSetting(value.value, kind.value as 'string' | 'number' | 'boolean');
      if ('error' in parsed) { addStatus.textContent = parsed.error; return; }
      events.set(slot, parsed);
    }
    addStatus.textContent = '';
    name.value = value.value = '';
  };

  function row(r: SlotRow, s: SlotEditorState) {
    const locked = !!s.readOnly || s.saving;
    const status = h('p.harness-field-error', { role: 'status' });
    const describe = (b: HarnessBinding | null | undefined) => describeBinding(b, s.resources, s.titleOf);
    const from = r.inherited ? `${levelName(r.inherited.scope)}${r.inherited.nodeName ? ' ' + r.inherited.nodeName : ''}` : '';
    const now = r.state === 'inherited' ? `${describe(r.inherited!.binding)} — from ${from}`
      : r.state === 'unset' ? 'Nothing above sets it.'
      : describe(r.own) + (r.inherited ? ` (overrides ${from}: ${describe(r.inherited.binding)})` : '');
    const picked = events.selected();
    const assign = h('button.btn', { type: 'button', disabled: locked || !picked, title: picked ? `Assign ${picked.title} to ${r.slot}` : 'Open an element in the list first' }, 'Assign open element');
    const reset = h('button.btn', { type: 'button', disabled: locked || r.own === undefined, title: 'Remove this level\'s own setting: the slot inherits again' }, 'Reset to inherited');
    const disable = h('button.btn', { type: 'button', disabled: locked || r.own === null, title: 'Set the slot to null at this level: nothing reaches the levels below' }, 'Disable');
    assign.onclick = () => { const p = events.selected(); if (p) events.set(r.slot, { resource: p.id }); };
    reset.onclick = () => events.set(r.slot, undefined);
    disable.onclick = () => events.set(r.slot, null);
    const actions = h('div.harness-slot-actions', {}, assign, reset, disable);
    // A scalar setting (its own value, or the one it inherits) is edited in place, typed as it is.
    const scalar = r.own && 'value' in r.own ? r.own : r.own === undefined && r.inherited?.binding && 'value' in r.inherited.binding ? r.inherited.binding : undefined;
    if (scalar) {
      const kindOf = settingKind(scalar);
      const input = h('input', { 'aria-label': 'Value of ' + r.slot, disabled: locked });
      input.value = String(scalar.value);
      const set = h('button.btn', { type: 'button', disabled: locked }, r.own ? 'Set value' : 'Override value');
      set.onclick = () => {
        const parsed = parseSetting(input.value, kindOf);
        if ('error' in parsed) { status.textContent = parsed.error; return; }
        status.textContent = '';
        events.set(r.slot, parsed);
      };
      actions.append(input, set);
    }
    return h('li.harness-slot', { 'data-state': r.state, ...(r.changed ? { 'data-draft': 'true' } : {}) },
      h('div.harness-slot-head', {},
        h('code.harness-slot-name', {}, r.slot),
        h('span.harness-state', { 'data-state': r.state, title: STATE_HELP[r.state] }, STATE_TEXT[r.state]),
        r.changed ? h('span.harness-draft-mark', { title: 'Changed in the draft, not saved yet' }, '✎ draft') : h('span.harness-saved-mark', { title: 'As saved' }, r.own !== undefined ? '● saved' : '')),
      h('p.harness-slot-value', {}, now),
      actions, status);
  }

  return {
    el,
    save,
    discard,
    render(s: SlotEditorState) {
      state = s;
      key.revision(s.revision);
      readOnly.textContent = s.readOnly;
      readOnly.hidden = !s.readOnly;
      list.replaceChildren(...s.rows.map((r) => row(r, s)));
      empty.hidden = s.rows.length > 0;
      for (const c of [name, kind, value, add]) c.disabled = !!s.readOnly || s.saving;
      const describe = (b: HarnessBinding | null | undefined) => describeBinding(b, s.resources, s.titleOf);
      draftTitle.textContent = s.changes.length ? `✎ Draft: ${s.changes.length} unsaved ${s.changes.length === 1 ? 'change' : 'changes'}` : 'No unsaved changes';
      diff.replaceChildren(...(s.changes.length
        ? s.changes.map((c) => h('li', {}, h('code', {}, c.slot), ': ', h('span.harness-from', {}, describe(c.from)), ' → ', h('span.harness-to', {}, describe(c.to))))
        : [h('li.harness-diff-none', {}, s.revision === undefined ? 'Loading this level…' : `This level is as saved in revision ${s.revision}.`)]));
      if (s.jsonError) diff.append(h('li.harness-field-error', {}, 'Advanced: JSON — ' + s.jsonError));
      draft.setAttribute('data-dirty', String(s.changes.length > 0 || !!s.jsonError));
    },
  };
}

/** The 409 notice: what changed on the server since the draft was opened, and the two ways on. */
export function conflictNotice(onReload: () => void, onKeep: () => void) {
  const text = h('p', {});
  const changed = h('ul.harness-diff', { 'aria-label': 'Changed on the server' });
  const reload = h('button.btn', { type: 'button' }, 'Reload (drop my draft)');
  const keep = h('button.btn.primary', { type: 'button' }, 'Keep editing');
  const el = h('div.harness-conflict', { role: 'alert', hidden: '' }, h('strong', {}, 'Not saved: the profile changed since you opened this draft'), text, changed, h('div.harness-actions', {}, reload, keep));
  reload.onclick = onReload;
  keep.onclick = onKeep;
  return {
    el,
    show(opened: number | undefined, now: number, lines: { slot: string; from: string; to: string }[], detail: string) {
      text.textContent = `You started from revision ${opened ?? '?'}; the store is at revision ${now} now. ${detail} Keep editing puts your draft on top of revision ${now} (your changes win in the slots you changed, the rest stays as saved); Reload drops your draft.`;
      changed.replaceChildren(...(lines.length ? lines.map((l) => h('li', {}, h('code', {}, l.slot), ': ', l.from, ' → ', l.to)) : [h('li', {}, 'No slot of this level changed: the other save was at another level or project.')]));
      el.hidden = false;
      el.scrollIntoView?.({ block: 'nearest' });
    },
    hide() { el.hidden = true; },
  };
}

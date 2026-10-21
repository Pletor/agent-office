// The element detail above the reader (docs/harness.md "Categories and the editor"): what an element is
// (category, group, the category's purpose), how to name it (its stable ID, its revision and a short
// digest, each with Copy; the full digest is the tooltip and what Copy copies), where it comes from
// (source and path), whether it is available (and how to fix it when not), where the loaded profile
// assigns it, and Assign: put it into a slot of the current context's draft, chosen from the slots there
// or named anew.
import { h } from '../../ui/dom';
import { HARNESS_CATEGORY_PURPOSE, shortDigest, type HarnessCatalog, type HarnessEntry } from '../../../shared/harness';
import { slotProblem } from './slots-model';

/** A slot name suggested for an element: its category and title, `instructions.task-start`. */
export function suggestSlot(e: Pick<HarnessEntry, 'category' | 'title'>): string {
  const slug = e.title.toLowerCase().replace(/\.(md|markdown|txt|json|ya?ml|toml|ts|js|mjs|cjs|py|sh|ps1)$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return e.category + '.' + (slug || 'element');
}

const SOURCE_FIX: Record<string, string> = {
  missing: 'The folder is not there: publish it (see docs/harness.md "Publish resources"), then Refresh.',
  'over-budget': 'Discovery stopped at its limit inside this source: narrow the published folders, then Refresh.',
  unreadable: 'A folder or file in this source could not be read: check its permissions, then Refresh.',
};

export function elementDetail(opts: {
  copy(text: string, what: string): void;
  /** Assigns the shown element to `slot` in the draft; returns what happened or why not. */
  assign(entry: HarnessEntry, slot: string): string;
  slotNames(): string[];
  usage(id: string): { saved: string[]; draft: boolean };
  /** Why Assign can't change this context now ('' when it can). */
  assignBlocked(): string;
}) {
  const chips = h('p.harness-chips');
  const purpose = h('p.harness-detail-purpose');
  const id = h('code.harness-id');
  const revision = h('span.harness-revision');
  const digest = h('code.harness-digest-short');
  const source = h('span.harness-source');
  const availability = h('span.harness-availability');
  const usage = h('span.harness-usage');
  const copyId = h('button.btn.harness-copy', { type: 'button', 'aria-label': 'Copy element ID' }, 'Copy');
  const copyDigest = h('button.btn.harness-copy', { type: 'button', 'aria-label': 'Copy digest' }, 'Copy');
  const slot = h('input', { 'aria-label': 'Slot to assign to', list: 'harness-slot-names', spellcheck: false, maxlength: 80 });
  const names = h('datalist', { id: 'harness-slot-names' });
  const assign = h('button.btn', { type: 'button' }, 'Assign to slot');
  const status = h('p.harness-assign-status', { role: 'status' });
  const row = (label: string, ...value: (HTMLElement | string)[]) => h('div.harness-meta-row', {}, h('dt', {}, label), h('dd', {}, ...value));
  const meta = h('dl.harness-meta', {},
    row('ID', id, copyId), row('Revision', revision), row('Digest', digest, copyDigest), row('Source', source), row('Availability', availability), row('Assigned in', usage));
  const assignRow = h('div.harness-assign', {}, h('label', {}, 'Assign to a slot of this context ', slot), names, assign, status);
  const el = h('div.harness-detail', { hidden: '' }, chips, purpose, meta, assignRow);
  let entry: HarnessEntry | undefined;

  copyId.onclick = () => { if (entry) opts.copy(entry.id, 'Element ID'); };
  copyDigest.onclick = () => { if (entry?.digest) opts.copy(entry.digest, 'Digest'); };
  assign.onclick = () => {
    if (!entry) return;
    const name = slot.value.trim();
    const bad = slotProblem(name);
    status.textContent = bad ?? opts.assign(entry, name);
    refresh();
  };
  function refresh() {
    if (!entry) return;
    const u = opts.usage(entry.id);
    usage.textContent = (u.saved.length ? u.saved.join(', ') : 'Not assigned on this path') + (u.draft ? ' · ✎ changed in the draft' : '');
    names.replaceChildren(...opts.slotNames().map((n) => h('option', { value: n })));
    const blocked = opts.assignBlocked();
    assign.disabled = slot.disabled = !!blocked;
    assign.title = blocked;
  }
  return {
    el,
    /** Shows `e` (as read, or as listed when the read failed: `problem` says why it is unavailable). */
    show(e: HarnessEntry, sources: HarnessCatalog['sources'], problem?: string) {
      const fresh = entry?.id !== e.id;
      entry = e;
      el.hidden = false;
      chips.replaceChildren(h('span.harness-chip', {}, e.category), h('span.harness-chip.harness-chip-group', {}, e.group));
      purpose.textContent = HARNESS_CATEGORY_PURPOSE[e.category];
      id.textContent = e.id;
      revision.textContent = e.version ? `revision ${e.version}` : 'revision 0 (no registry: revisions are not recorded here)';
      digest.textContent = e.digest ? 'sha256:' + shortDigest(e.digest) + '…' : 'not known yet';
      digest.setAttribute('title', e.digest ? 'sha256:' + e.digest : '');
      copyDigest.disabled = !e.digest;
      source.textContent = e.source + ' / ' + e.path;
      const why = sources.find((s) => s.name === e.source)?.reason;
      availability.textContent = problem ? `Unavailable: ${problem} Refresh the library; if it stays unavailable, check that ${e.path} is still published and readable.`
        : 'Available: listed and readable now.' + (why ? ` Its source was not read in full (${why}): ${SOURCE_FIX[why]}` : '');
      el.setAttribute('data-available', String(!problem));
      if (fresh) { slot.value = suggestSlot(e); status.textContent = ''; }
      refresh();
    },
    hide() { entry = undefined; el.hidden = true; },
    refresh,
  };
}

/** The sources and their availability, each unavailable one with why and how to fix it. */
export function sourceLines(sources: HarnessCatalog['sources']): HTMLElement[] {
  return sources.map((s) => {
    const why = s.reason ?? (s.available ? undefined : 'missing');
    return h('p', { 'data-reason': why ?? 'ok' }, (why ? '— ' : '✓ ') + s.name + (why ? ` · ${why === 'missing' ? 'not found' : why === 'over-budget' ? 'over the discovery budget (listed in part)' : 'unreadable in part'}. ${SOURCE_FIX[why]}` : ''));
  });
}

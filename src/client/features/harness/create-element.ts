// "New element" (docs/harness.md "Categories and the editor"): a small form that publishes one new file
// in the project's .harness/<category>/[<group>/] folder through POST /api/harness/element. Only an
// administrator sees it enabled, and only in a project (Global lists elements that are the same file in
// every project, which a project folder is not). The server checks everything again (element-api.ts):
// names, links, size, credential-like names, and never overwrites an existing file.
import { h } from '../../ui/dom';
import { HARNESS_CATEGORIES, type HarnessCategory, type HarnessEntry } from '../../../shared/harness';

const PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX = 128 * 1024;

/** Why the form's fields can't make an element ('' when they can): the server's rules, said before a round trip. */
export function formProblem(group: string, name: string, content: string): string {
  if (group && (!PART.test(group) || group.includes('..') || group.length > 64)) return 'The group folder takes up to 64 letters, digits, ".", "_" or "-" (no slashes, no "..").';
  if (!name) return 'Give the file name, for example review-checklist.md.';
  if (!PART.test(name) || name.includes('..') || name.length > 100) return 'The file name takes up to 100 letters, digits, ".", "_" or "-" (no slashes, no "..").';
  if (!/\.(?:md|markdown|txt|ts|js|mjs|cjs|py|sh|ps1|yaml|yml|json|toml)$/i.test(name)) return 'Use a text type the library lists: .md, .txt, .json, .yaml, .toml, .py, .sh, .ps1, .ts or .js.';
  if (!content.trim()) return 'Write the content of the element.';
  if (new TextEncoder().encode(content).length > MAX) return 'An element may be at most 128 KiB.';
  return '';
}

export function createElementForm(opts: { floor(): string; category(): HarnessCategory; groups(category: HarnessCategory): string[]; onCreated(entry: HarnessEntry | null, id: string, warning: string): void; signal: AbortSignal }) {
  const toggle = h('button.btn', { type: 'button', 'aria-expanded': 'false' }, '+ New element');
  const category = h('select', { 'aria-label': 'New element category' }, ...HARNESS_CATEGORIES.map((c) => h('option', { value: c }, c)));
  const group = h('input', { 'aria-label': 'New element group folder', placeholder: 'group folder (optional)', list: 'harness-group-names', maxlength: 64, spellcheck: false });
  const groups = h('datalist', { id: 'harness-group-names' });
  const name = h('input', { 'aria-label': 'New element file name', placeholder: 'review-checklist.md', maxlength: 100, spellcheck: false });
  const content = h('textarea', { 'aria-label': 'New element content', rows: 6, placeholder: '# Title\n\nWhat a model should know or do.' });
  const where = h('p.harness-create-where');
  const create = h('button.btn.primary', { type: 'button' }, 'Create element');
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  const status = h('p.harness-field-error', { role: 'status' });
  const form = h('div.harness-create', { hidden: '', role: 'group', 'aria-label': 'New element' },
    h('strong', {}, 'New element in this project'), category, group, groups, name, content, where, h('div.harness-actions', {}, create, cancel), status);
  let blocked = '';
  let busy = false;

  const target = () => `.harness/${category.value}/${group.value.trim() ? group.value.trim() + '/' : ''}${name.value.trim() || '<file name>'}`;
  const update = () => {
    where.textContent = 'Publishes ' + target() + ' in the project\'s repository. An existing file is never overwritten.';
    groups.replaceChildren(...opts.groups(category.value as HarnessCategory).map((g) => h('option', { value: g })));
    create.disabled = busy || !!blocked;
  };
  function close() { form.hidden = true; toggle.setAttribute('aria-expanded', 'false'); }
  toggle.onclick = () => {
    if (!form.hidden) return close();
    form.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    category.value = opts.category();
    status.textContent = blocked;
    update();
    name.focus?.();
  };
  cancel.onclick = close;
  category.onchange = group.oninput = name.oninput = update;
  create.onclick = async () => {
    if (busy || blocked) return;
    const problem = formProblem(group.value.trim(), name.value.trim(), content.value);
    if (problem) { status.textContent = problem; return; }
    busy = true;
    update();
    status.textContent = 'Creating ' + target() + '…';
    try {
      const response = await fetch('/api/harness/element?' + new URLSearchParams({ floor: opts.floor() }), {
        method: 'POST', signal: opts.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: category.value, group: group.value.trim(), name: name.value.trim(), content: content.value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(response.status === 403 ? (data.error ?? 'Only administrators can create elements.') : response.status === 409 ? data.error : (data.error ?? 'The element could not be created.'));
      status.textContent = 'Created ' + data.path + (data.warning ? '. ' + data.warning : '.');
      name.value = content.value = '';
      opts.onCreated(data.entry, data.id, data.warning ?? '');
    } catch (err) {
      if (opts.signal.aborted) return;
      status.textContent = 'Not created: ' + (err as Error).message;
    } finally { busy = false; update(); }
  };
  return {
    toggle, form,
    /** Who may create here: '' for an administrator in a project, else why not (the button stays visible, disabled, with the reason). */
    allow(reason: string) {
      blocked = reason;
      toggle.disabled = !!reason;
      toggle.title = reason || 'Publish a new file in this project\'s .harness folder';
      if (reason) close();
      update();
    },
  };
}

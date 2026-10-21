// The context bar at the top of the library (docs/harness.md "Choosing the context"): Global | Project,
// the project picker (the floors of this office, each with its Opora binding), and, only once a project
// is chosen and its Opora tree is there, the specialization breadcrumb: one picker per step down the
// project's real tree (page › layer › area › sector › task, harness/tree-api.ts). An unbound project, or
// one whose Opora isn't answering, offers the project level only, says why, and never makes up a tree.
//
// The bar shows a context; it doesn't decide one. A change the user makes goes to `onRequest`, and
// whoever owns the library answers with `set()` (the new context, or the old one when the switch is
// called off because of unsaved edits, see `guard`).
import { h } from '../../ui/dom';
import { treeTrail, type HarnessTreeNode } from '../../../shared/harness-tree';
import { latest, levelName, type HarnessContext, type ProjectChoice, type TreeReply } from './context-model';
import { bindFloorAction } from './bind-floor';

/** What the picker says after a floor's name: its Opora project, or why there's none. */
export function projectStatus(p: Pick<ProjectChoice, 'binding' | 'status'>): string {
  const name = p.binding?.projectName;
  switch (p.status) {
    case 'ready': return 'Opora: ' + name;
    case 'unbound': return 'not linked';
    case 'unreachable': return 'Opora: ' + name + ' (not answering)';
    case 'elsewhere': return 'Opora: ' + name + ' (window reads another project)';
    default: return 'binding unreadable';
  }
}

const DEFAULT_GLOBAL = ['handbook', 'machine', 'published'];

export function contextBar(opts: { opened: string; signal: AbortSignal; onRequest(next: HarnessContext): void; onProjects?(): void }) {
  let ctx: HarnessContext = { kind: 'global' };
  let projects: ProjectChoice[] = [];
  let globalNs: string[] = DEFAULT_GLOBAL;
  /** Whether this reader may bind floors and create elements (GET /api/harness/projects `admin`; the routes check again). */
  let admin = false;
  let bindKey = '';
  /** The tree of the floor last asked for, once its reply is in (`floor` says whose). */
  let tree: { floor: string; reply?: TreeReply; error?: string } | undefined;
  /** The last project chosen, so Project comes back to it after a look at Global. */
  let lastFloor = opts.opened;
  const trees = latest(opts.signal);
  const listing = latest(opts.signal);

  const globalBtn = h('button.btn', { type: 'button', 'aria-pressed': 'false' }, 'Global');
  const projectBtn = h('button.btn', { type: 'button', 'aria-pressed': 'false' }, 'Project');
  const segmented = h('div.harness-segmented', { role: 'group', 'aria-label': 'Context level' }, globalBtn, projectBtn);
  const picker = h('select.harness-project', { 'aria-label': 'Project' });
  const spec = h('div.harness-spec', { role: 'group', 'aria-label': 'Specialization' });
  const trail = h('p.harness-trail', { 'aria-live': 'polite' });
  const notice = h('p.harness-notice.harness-context-notice', { role: 'note', hidden: '' });
  const bind = h('div.harness-bind-slot');
  const guardText = h('span');
  const discard = h('button.btn', { type: 'button' }, 'Discard changes and switch');
  const keep = h('button.btn.primary', { type: 'button' }, 'Keep editing');
  const guardEl = h('div.harness-guard', { role: 'alert', hidden: '' }, guardText, discard, keep);
  const el = h('div.harness-context', { role: 'region', 'aria-label': 'Context' },
    h('div.harness-context-row', {}, segmented,
      h('label.harness-field', {}, h('span', {}, 'Project'), picker),
      h('div.harness-field.harness-spec-field', {}, h('span', {}, 'Specialization'), spec)),
    trail, notice, bind, guardEl);

  const projectName = (floor: string) => projects.find((p) => p.floor === floor)?.name ?? floor;
  const repoOf = (floor: string) => projects.find((p) => p.floor === floor)?.repo;
  /** The context in words, outermost first: what the trail and the panels' headings say. */
  function label(c: HarnessContext = ctx): string {
    if (c.kind === 'global') return 'Global';
    const head = 'Project ' + projectName(c.floor);
    if (c.kind === 'project') return head;
    const steps = tree?.floor === c.floor && tree.reply ? treeTrail(tree.reply.tree, c.node) : [];
    return [head, ...(steps.length ? steps : [{ level: c.level, name: c.name }]).map((s) => levelName(s.level) + ' ' + s.name)].join(' › ');
  }
  function disabledSpec(text: string) {
    spec.replaceChildren(h('select', { 'aria-label': 'Specialization', disabled: true }, h('option', { value: '' }, text)));
  }
  function renderSpec() {
    if (ctx.kind === 'global') return disabledSpec('Choose a project first');
    const floor = ctx.floor;
    if (!tree || tree.floor !== floor || (!tree.reply && !tree.error)) return disabledSpec('Loading specializations…');
    if (tree.error) return disabledSpec('Specializations unavailable');
    const reply = tree.reply!;
    if (reply.status !== 'ready') return disabledSpec(reply.status === 'unbound' ? 'Not linked: project level only' : 'Unavailable: project level only');
    if (!reply.tree.length) return disabledSpec('No pages on this canvas yet');
    const steps = ctx.kind === 'node' ? treeTrail(reply.tree, ctx.node) : [];
    const selects: HTMLElement[] = [];
    for (let i = 0; i <= steps.length; i++) {
      const parent = i ? steps[i - 1] : undefined;
      const children: HarnessTreeNode[] = parent ? parent.children : reply.tree;
      if (!children.length) break;
      const select = h('select.harness-step', { 'aria-label': parent ? 'Specialization under ' + levelName(parent.level) + ' ' + parent.name : 'Specialization' },
        h('option', { value: '' }, parent ? 'Whole ' + parent.level : 'Whole project'),
        ...children.map((c) => h('option', { value: c.key }, levelName(c.level) + ': ' + c.name)));
      select.value = steps[i]?.key ?? '';
      select.onchange = () => {
        const picked = children.find((c) => c.key === select.value);
        const at = picked ?? parent;
        opts.onRequest(at ? { kind: 'node', floor, node: at.key, level: at.level, name: at.name } : { kind: 'project', floor });
      };
      if (i) selects.push(h('span.harness-step-sep', { 'aria-hidden': 'true' }, '›'));
      selects.push(select);
    }
    // Rebuilt pickers keep the keyboard where it was: the one at the same step (or the last one).
    const focused = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement && spec.contains(document.activeElement) ? [...spec.querySelectorAll('select')].indexOf(document.activeElement as HTMLSelectElement) : -1;
    spec.replaceChildren(...selects);
    if (focused >= 0) { const all = spec.querySelectorAll('select'); all[Math.min(focused, all.length - 1)]?.focus({ preventScroll: true }); }
  }
  function renderPicker() {
    const choices = projects.length ? projects : [{ floor: lastFloor, name: lastFloor, repo: '', binding: null, status: 'unbound', notice: '' } as ProjectChoice];
    picker.replaceChildren(...choices.map((p) => h('option', { value: p.floor }, p.name + ' — ' + (projects.length ? projectStatus(p) : 'loading…'))));
    picker.value = ctx.kind === 'global' ? lastFloor : ctx.floor;
    picker.disabled = ctx.kind === 'global';
  }
  function render() {
    globalBtn.setAttribute('aria-pressed', String(ctx.kind === 'global'));
    projectBtn.setAttribute('aria-pressed', String(ctx.kind !== 'global'));
    renderPicker();
    renderSpec();
    trail.textContent = label();
    const reply = ctx.kind !== 'global' && tree?.floor === ctx.floor ? tree.reply : undefined;
    const why = ctx.kind === 'global' ? '' : tree?.floor === ctx.floor && tree.error ? tree.error : reply && reply.status !== 'ready' ? reply.notice : '';
    notice.textContent = why;
    notice.hidden = !why;
    const unbound = admin && reply?.status === 'unbound' && ctx.kind !== 'global' ? reply : undefined;
    // Built once per floor and window place, so a reply arriving mid-confirmation doesn't close it.
    const key = unbound?.window ? unbound.floor + ' ' + unbound.window.project + ' ' + unbound.window.workspace : '';
    if (key === bindKey) return;
    bindKey = key;
    bind.replaceChildren(...(unbound?.window ? [bindFloorAction({ floor: unbound.floor, floorName: unbound.name, window: unbound.window, signal: opts.signal, onBound: () => { void loadProjects(); if (ctx.kind !== 'global') void loadTree(ctx.floor); } })] : []));
  }
  async function loadTree(floor: string) {
    const turn = trees.next();
    tree = { floor };
    try {
      const response = await fetch('/api/harness/tree?' + new URLSearchParams({ floor }), { signal: turn.signal });
      const data = await response.json();
      if (!turn.current()) return;
      if (!response.ok) throw new Error(data.error ?? 'The project tree could not be read.');
      tree = { floor, reply: data };
    } catch (err) {
      if (!turn.current()) return;
      tree = { floor, error: (err as Error).message };
    }
    render();
    // A remembered specialization the tree no longer has (or a project with no tree now) falls back to the project level.
    if (ctx.kind === 'node' && ctx.floor === floor && !(tree.reply?.status === 'ready' && treeTrail(tree.reply.tree, ctx.node).length)) opts.onRequest({ kind: 'project', floor });
  }
  async function loadProjects() {
    const turn = listing.next();
    try {
      const response = await fetch('/api/harness/projects', { signal: turn.signal });
      const data = await response.json();
      if (!turn.current() || !response.ok) return;
      projects = data.projects ?? [];
      globalNs = data.globalNamespaces ?? DEFAULT_GLOBAL;
      admin = data.admin === true;
      render();
      opts.onProjects?.();
      // A remembered project this office no longer has falls back to the floor the library was opened on.
      const at = ctx.kind === 'global' ? '' : ctx.floor;
      if (at && projects.length && !projects.some((p) => p.floor === at)) opts.onRequest({ kind: 'project', floor: opts.opened });
    } catch { /* the picker keeps the floor it has; the tree says why when it fails too */ }
  }

  globalBtn.onclick = () => opts.onRequest({ kind: 'global' });
  projectBtn.onclick = () => { if (ctx.kind === 'global') opts.onRequest({ kind: 'project', floor: lastFloor }); };
  picker.onchange = () => opts.onRequest({ kind: 'project', floor: picker.value });
  void loadProjects();

  return {
    el,
    get: () => ctx,
    label,
    projectName,
    repoOf,
    globalNamespaces: () => globalNs,
    admin: () => admin,
    /** Shows `next` (the tree of its project is fetched when it isn't the one in hand). */
    set(next: HarnessContext) {
      ctx = next;
      guardEl.hidden = true;
      if (next.kind !== 'global') {
        lastFloor = next.floor;
        if (tree?.floor !== next.floor) void loadTree(next.floor);
      }
      render();
    },
    /** Asks before a switch that would lose unsaved edits: `onDiscard` switches, `onKeep` stays. */
    guard(text: string, onDiscard: () => void, onKeep: () => void) {
      guardText.textContent = text;
      guardEl.hidden = false;
      const back = () => (segmented.querySelector('[aria-pressed=true]') as HTMLElement | null)?.focus?.({ preventScroll: true });
      discard.onclick = () => { guardEl.hidden = true; onDiscard(); back(); };
      keep.onclick = () => { guardEl.hidden = true; onKeep(); back(); };
      keep.focus?.({ preventScroll: true });
    },
    /** Reads the projects and the current project's tree again. */
    refresh() { void loadProjects(); if (ctx.kind !== 'global') void loadTree(ctx.floor); },
  };
}

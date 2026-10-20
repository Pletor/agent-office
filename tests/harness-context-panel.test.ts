// The library's context in the client, under node's fake DOM (tests/support/fake-dom.ts): the context bar's
// states (Global, a project with its tree, unbound, unreachable, a window elsewhere), no specialization (no
// task) without a project, stale replies dropped (the tree, the editor's profile), the unsaved-edit guard,
// the context remembered across a reopen, the element filter and the per-level audit. The browser and the
// real routes are tests/harness-context.browser.mjs; the endpoints are tests/harness-context.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byText, installFakeDom, rows, type FakeNode } from './support/fake-dom.js';
import { HARNESS_LEVELS, type HarnessProfile } from '../src/shared/harness-cascade.js';
import { harnessTree } from '../src/shared/harness-tree.js';
import { canvas } from './support/harness-context-office.js';

installFakeDom();
const { contextBar, projectStatus } = await import('../src/client/features/harness/context-bar.js');
const { cascadePanel } = await import('../src/client/features/harness/cascade.js');
const { receivesPanel, previewDigest } = await import('../src/client/features/harness/receives.js');
const { contextSwitcher } = await import('../src/client/features/harness/switcher.js');
const model = await import('../src/client/features/harness/context-model.js');
type Ctx = import('../src/client/features/harness/context-model.js').HarnessContext;

const AMPLE = { project: 'p-ample', workspace: 'w-ample' };
const TAJ = { project: 'p-tajemstvi', workspace: 'w-tajemstvi' };
const projects = [
  { floor: 'ample', name: 'ample-shop', repo: 'ra', binding: { ...AMPLE, projectName: 'Ample' }, status: 'ready', notice: '' },
  { floor: 'tajemstvi', name: 'tajemstvi-opory', repo: 'rt', binding: { ...TAJ, projectName: 'Tajemství opory' }, status: 'ready', notice: '' },
  { floor: 'loose', name: 'loose-repo', repo: 'rl', binding: null, status: 'unbound', notice: 'Not linked to an Opora project: only the project level can be edited here.' },
  { floor: 'dark', name: 'dark-repo', repo: 'rd', binding: { project: 'p-dark', workspace: 'w', projectName: 'p-dark' }, status: 'unreachable', notice: 'Opora isn\'t answering: specializations need its canvas.' },
];
const trees: Record<string, unknown> = {
  ample: { ...projects[0], tree: harnessTree(canvas('Ample', 'am'), AMPLE) },
  tajemstvi: { ...projects[1], tree: harnessTree(canvas('Tajemství', 'ta'), TAJ) },
  loose: { ...projects[2], tree: [] },
  dark: { ...projects[3], tree: [] },
};

/** A fetch whose replies the test hands out, in any order: each request waits until `release(match)`. */
function heldFetch() {
  const waiting: { url: string; init?: RequestInit; reply: (body: unknown, status?: number) => void }[] = [];
  const log: string[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => new Promise((resolve) => {
    log.push(String(url));
    waiting.push({ url: String(url), init, reply: (body, status = 200) => resolve({ ok: status < 400, status, json: async () => body } as Response) });
  })) as unknown as typeof fetch;
  return {
    log,
    /** Answers the oldest waiting request whose URL includes `part` (it throws when there is none). */
    async release(part: string, body: unknown, status?: number) {
      const at = waiting.findIndex((w) => w.url.includes(part));
      assert.ok(at >= 0, `a request for ${part} is waiting: ${waiting.map((w) => w.url).join(', ')}`);
      const [w] = waiting.splice(at, 1);
      w.reply(body, status);
      await settle();
      return w;
    },
    pending: () => waiting.map((w) => w.url),
  };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const optionTexts = (select: FakeNode) => select.children.filter((c) => c.tagName === 'option').map((o) => o.textContent);
const isDisabled = (n: FakeNode) => n.disabled || n.getAttribute('disabled') !== null;
const specSelects = (el: FakeNode) => el.querySelector('div.harness-spec')!.querySelectorAll('select');

/** A bar on `ample` whose requests are recorded; the projects list is answered at once. */
async function bar() {
  const fetches = heldFetch();
  const asked: Ctx[] = [];
  const b = contextBar({ opened: 'ample', signal: new AbortController().signal, onRequest: (next) => asked.push(next) });
  await fetches.release('/api/harness/projects', { projects, globalNamespaces: ['handbook', 'machine', 'published'] });
  return { b, el: b.el as unknown as FakeNode, asked, fetches };
}

test('Global: the specialization is disabled ("Choose a project first"), the picker too, and no tree is asked for', async () => {
  const { b, el, fetches } = await bar();
  b.set({ kind: 'global' });
  const [only, ...rest] = specSelects(el);
  assert.equal(rest.length, 0);
  assert.ok(isDisabled(only));
  assert.deepEqual(optionTexts(only), ['Choose a project first'], 'no page, sector or task can be picked without a project');
  assert.ok(isDisabled(el.querySelector('select.harness-project')!));
  assert.equal(byText(el, 'Global')!.getAttribute('aria-pressed'), 'true');
  assert.equal(byText(el, 'Project')!.getAttribute('aria-pressed'), 'false');
  assert.equal(el.querySelector('p.harness-trail')!.textContent, 'Global');
  assert.ok(!fetches.log.some((u) => u.includes('/tree')), 'Global reads no tree');
  // The picker lists the floors with their Opora binding.
  assert.deepEqual(optionTexts(el.querySelector('select.harness-project')!), ['ample-shop — Opora: Ample', 'tajemstvi-opory — Opora: Tajemství opory', 'loose-repo — not linked', 'dark-repo — Opora: p-dark (not answering)']);
  assert.equal(projectStatus({ binding: { project: 'p', workspace: 'w', projectName: 'P' }, status: 'elsewhere' }), 'Opora: P (window reads another project)');
});

test('a specialization without a project is Global, never a guessed project; a project with an empty node is the project', () => {
  assert.deepEqual(model.normalizeContext({ kind: 'node', floor: '', node: 'opora:p:w:t', level: 'task', name: 'T' }, 'ample'), { kind: 'global' });
  assert.deepEqual(model.normalizeContext({ kind: 'project', floor: '' }, 'ample'), { kind: 'global' });
  assert.deepEqual(model.normalizeContext({ kind: 'node', floor: 'ample', node: '', level: 'task', name: '' }, 'ample'), { kind: 'project', floor: 'ample' });
  assert.deepEqual(model.normalizeContext(undefined, 'ample'), { kind: 'project', floor: 'ample' }, 'a first open lands on the floor you\'re on');
});

test('a project: its tree, one picker per step down (page › layer › area › sector › task), and each choice asked for', async () => {
  const { b, el, asked, fetches } = await bar();
  b.set({ kind: 'project', floor: 'ample' });
  assert.deepEqual(optionTexts(specSelects(el)[0]), ['Loading specializations…']);
  await fetches.release('/api/harness/tree?floor=ample', trees.ample);
  let [first] = specSelects(el);
  assert.ok(!isDisabled(first));
  assert.deepEqual(optionTexts(first), ['Whole project', 'Page: Ample page']);
  first.value = 'opora:p-ample:w-ample:am-page';
  (first as unknown as { onchange(): void }).onchange();
  assert.deepEqual(asked.at(-1), { kind: 'node', floor: 'ample', node: 'opora:p-ample:w-ample:am-page', level: 'page', name: 'Ample page' });
  b.set(asked.at(-1)!);
  b.set({ kind: 'node', floor: 'ample', node: 'opora:p-ample:w-ample:am-task', level: 'task', name: 'Ample task' });
  const steps = specSelects(el);
  assert.deepEqual(steps.map((s) => s.value), ['opora:p-ample:w-ample:am-page', 'opora:p-ample:w-ample:am-layer', 'opora:p-ample:w-ample:am-area', 'opora:p-ample:w-ample:am-sector', 'opora:p-ample:w-ample:am-task']);
  assert.deepEqual(optionTexts(steps[4]), ['Whole sector', 'Task: Ample task', 'Task: Ample second task'], 'siblings are offered side by side, each on its own');
  assert.equal(el.querySelector('p.harness-trail')!.textContent, 'Project ample-shop › Page Ample page › Layer [vrstva 01] Ample layer › Area Ample area › Sector Ample sector › Task Ample task');
  // "Whole sector" goes back up to the sector.
  steps[4].value = '';
  (steps[4] as unknown as { onchange(): void }).onchange();
  assert.deepEqual(asked.at(-1), { kind: 'node', floor: 'ample', node: 'opora:p-ample:w-ample:am-sector', level: 'sector', name: 'Ample sector' });
  assert.ok(![el.querySelector('div.harness-spec')!, el.querySelector('p.harness-trail')!].some((n) => n.textContent.includes('Tajemství')), 'nothing of the other project (the picker names every floor on purpose)');
});

test('unbound, unreachable: the project level only, the reason shown, the specialization disabled, no tree made up', async () => {
  const { b, el, fetches } = await bar();
  b.set({ kind: 'project', floor: 'loose' });
  await fetches.release('/api/harness/tree?floor=loose', trees.loose);
  assert.deepEqual(optionTexts(specSelects(el)[0]), ['Not linked: project level only']);
  assert.ok(isDisabled(specSelects(el)[0]));
  const notice = el.querySelector('p.harness-context-notice')!;
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /Not linked to an Opora project/);
  b.set({ kind: 'project', floor: 'dark' });
  await fetches.release('/api/harness/tree?floor=dark', trees.dark);
  assert.deepEqual(optionTexts(specSelects(el)[0]), ['Unavailable: project level only']);
  assert.match(notice.textContent, /Opora isn't answering/);
  // A failed read says so too, and still offers nothing.
  b.set({ kind: 'project', floor: 'ample' });
  await fetches.release('/api/harness/tree?floor=ample', { error: 'No such floor' }, 404);
  assert.deepEqual(optionTexts(specSelects(el)[0]), ['Specializations unavailable']);
  assert.match(notice.textContent, /No such floor/);
});

test('a remembered specialization the tree no longer has, or a project without a tree now, falls back to the project level', async () => {
  const { b, asked, fetches } = await bar();
  b.set({ kind: 'node', floor: 'loose', node: 'opora:p-ample:w-ample:lo-task', level: 'task', name: 'Loose task' });
  await fetches.release('/api/harness/tree?floor=loose', trees.loose);
  assert.deepEqual(asked.at(-1), { kind: 'project', floor: 'loose' });
});

test('stale tree: Ample\'s tree arriving after the switch to Tajemství opory is dropped', async () => {
  const { b, el, fetches } = await bar();
  b.set({ kind: 'project', floor: 'ample' });
  b.set({ kind: 'project', floor: 'tajemstvi' });
  await fetches.release('/api/harness/tree?floor=tajemstvi', trees.tajemstvi);
  await fetches.release('/api/harness/tree?floor=ample', trees.ample);
  assert.deepEqual(optionTexts(specSelects(el)[0]), ['Whole project', 'Page: Tajemství page']);
  assert.ok(!el.textContent.includes('Ample page'), 'the late Ample tree never shows');
});

type View = HarnessProfile & { tasks: never[]; audit: import('../src/client/features/harness/context-model.js').AuditEntry[]; writable: boolean; globalWrite: boolean; preview: string; warning: string };
function profile(project: Record<string, unknown>, extra: Partial<View> = {}): View {
  const layers = Object.fromEntries(HARNESS_LEVELS.map((l) => [l, {}])) as HarnessProfile['layers'];
  layers.project = project as never;
  layers.global = { 'house.style': { value: 'shared' } };
  const effective = Object.fromEntries([...Object.entries(layers.global).map(([k, v]) => [k, { binding: v, scope: 'global' }]), ...Object.entries(project).map(([k, v]) => [k, { binding: v, scope: 'project' }])]);
  return { revision: 7, path: [], layers, effective, tasks: [], audit: [], writable: true, globalWrite: true, preview: '', warning: '', ...extra } as View;
}

test('stale profile: the editor drops a reply of the context it left, in whichever order the replies come', async () => {
  const fetches = heldFetch();
  const views: string[] = [];
  const panel = cascadePanel({ opened: 'ample', signal: new AbortController().signal, label: (c) => model.contextKey(c), repoOf: () => undefined, onView: (_v, c) => views.push(model.contextKey(c)) });
  const el = panel.el as unknown as FakeNode;
  panel.show({ kind: 'project', floor: 'ample' });
  panel.show({ kind: 'project', floor: 'tajemstvi' });
  await fetches.release('floor=tajemstvi', profile({ 'tajemstvi.voice': { value: 'hlas' } }));
  await fetches.release('floor=ample', profile({ 'ample.voice': { value: 'voice' } }));
  assert.deepEqual(views, ['project:tajemstvi'], 'only the current context reached the preview');
  const editor = el.querySelector('textarea')!;
  assert.match(editor.value, /tajemstvi\.voice/);
  assert.doesNotMatch(editor.value, /ample/);
  // And the other way round: the late reply is the current one's, the early one is stale.
  panel.show({ kind: 'global' });
  panel.show({ kind: 'project', floor: 'ample' });
  await fetches.release('floor=ample', profile({ 'ample.voice': { value: 'voice' } }));
  await fetches.release('floor=ample', profile({ 'ample.voice': { value: 'voice' } })); // the Global read (opened floor) arriving last
  assert.deepEqual(views, ['project:tajemstvi', 'project:ample']);
  assert.match(editor.value, /ample\.voice/, 'the project layer, not the global one');
});

test('the editor shows only its own level\'s slots and saves; the audit lists only this level\'s saves of this project', async () => {
  const fetches = heldFetch();
  const panel = cascadePanel({ opened: 'ample', signal: new AbortController().signal, label: () => 'Project ample-shop', repoOf: (f) => (f === 'ample' ? 'ra' : 'rt'), onView: () => {} });
  const el = panel.el as unknown as FakeNode;
  panel.show({ kind: 'project', floor: 'ample' });
  await fetches.release('floor=ample', profile({ 'ample.voice': { value: 'voice' } }, { audit: [
    { at: 't1', revision: 3, level: 'project', node: '', repo: 'ra', by: 'a', slots: ['ample.voice'] },
    { at: 't2', revision: 4, level: 'project', node: '', repo: 'rt', by: 'a', slots: ['tajemstvi.voice'] },
    { at: 't3', revision: 5, level: 'global', node: '', by: 'a', slots: ['house.style'] },
  ] }));
  const editor = el.querySelector('textarea')!;
  assert.doesNotMatch(editor.value, /house\.style/, 'Global\'s slot is inherited, not this level\'s own');
  const audit = el.querySelector('pre.harness-audit')!.textContent;
  assert.match(audit, /ample\.voice/);
  assert.doesNotMatch(audit, /tajemstvi|house/, 'another project\'s save and Global\'s are not this level\'s');
  // Unsaved edits: dirty until saved or discarded.
  assert.equal(panel.dirty(), false);
  editor.value = '{"ample.voice":{"value":"new"}}';
  assert.equal(panel.dirty(), true);
  panel.discard();
  assert.equal(panel.dirty(), false);
  editor.value = '{"ample.voice":{"value":"new"}}';
  (byText(el, 'Save layer') as unknown as { onclick(): void }).onclick();
  await settle();
  const sent = await fetches.release('floor=ample', profile({ 'ample.voice': { value: 'new' } }));
  assert.equal(sent.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(sent.init?.body)), { scope: 'project', layer: { 'ample.voice': { value: 'new' } }, revision: 7 });
  assert.equal(panel.dirty(), false);
});

test('the unsaved-edit guard: a switch asks; Keep editing stays (edit kept), Discard switches; the context is remembered', async () => {
  const calls: string[] = [];
  let dirty = true;
  let guard: { text: string; discard(): void; keep(): void } | undefined;
  const fakeBar = { set: (c: Ctx) => calls.push('bar ' + model.contextKey(c)), label: (c: Ctx) => model.contextKey(c), guard: (text: string, discard: () => void, keep: () => void) => { guard = { text, discard, keep }; } };
  const fakeEditor = { dirty: () => dirty, discard: () => { calls.push('discard'); dirty = false; }, show: (c: Ctx) => calls.push('show ' + model.contextKey(c)) };
  const applied: string[] = [];
  const s = contextSwitcher({ opened: 'ample', initial: { kind: 'project', floor: 'ample' }, bar: () => fakeBar, editor: () => fakeEditor, preview: () => ({ pending: () => {} }), onApplied: (c, moved) => applied.push(model.contextKey(c) + (moved ? ' (new floor)' : '')) });
  s.start();
  calls.length = 0;
  s.request({ kind: 'global' });
  assert.match(guard!.text, /Unsaved changes to project:ample would be lost/);
  assert.deepEqual(calls, [], 'nothing switched while the question is open');
  guard!.keep();
  assert.deepEqual(calls, ['bar project:ample'], 'Keep editing puts the bar back on the context still shown');
  assert.equal(model.contextKey(s.get()), 'project:ample');
  s.request({ kind: 'project', floor: 'tajemstvi' });
  guard!.discard();
  assert.deepEqual(calls.slice(1), ['discard', 'bar project:tajemstvi', 'show project:tajemstvi']);
  assert.deepEqual(applied, ['project:ample', 'project:tajemstvi (new floor)']);
  assert.equal(model.contextKey(model.rememberedContext()!), 'project:tajemstvi', 'kept for the next open of the library');
  // Without edits the switch is immediate; Global reads the floor it was opened on.
  s.request({ kind: 'global' });
  assert.deepEqual(applied.at(-1), 'global (new floor)');
  assert.equal(model.contextFloor(s.get(), 'ample'), 'ample');
});

test('the element filter: Global lists global namespaces only, a project and its specializations their own elements', () => {
  const ns = ['handbook', 'machine', 'published'];
  const project: Ctx = { kind: 'project', floor: 'ample' };
  const node: Ctx = { kind: 'node', floor: 'ample', node: 'opora:p:w:t', level: 'task', name: 'T' };
  for (const [id, global] of [['guide:instructions', true], ['el:machine:abc', true], ['el:published:abc', true], ['el:project:abc', false], ['el:openviking:abc', false], ['legacy-id', false]] as const) {
    assert.equal(model.elementInContext(id, { kind: 'global' }, ns), global, id);
    assert.equal(model.elementInContext(id, project, ns), !global, id);
    assert.equal(model.elementInContext(id, node, ns), !global, id);
  }
  assert.equal(model.elementInContext('el:openviking:abc', { kind: 'global' }, [...ns, 'openviking']), true, 'a pinned OpenViking is global');
});

test('"What the worker receives": Global alone for Global, the resolved slots and the snapshot digest for a project', () => {
  const panel = receivesPanel();
  const el = panel.el as unknown as FakeNode;
  const sha = 'a'.repeat(64);
  const view = profile({ 'ample.voice': { value: 'voice' }, 'house.style': { value: 'project style' } }, { preview: `\n\n## Resolved Harness\nSnapshot SHA-256: ${sha}\n...` });
  panel.show(view, { kind: 'global' }, 'Global', '');
  assert.deepEqual(rows(el.querySelector('table')!), [['house.style', '"shared"', 'Global', 'Global']], 'Global shows Global\'s own result, not a project\'s overrides');
  assert.equal(el.querySelector('p.harness-digest')!.textContent, '');
  panel.show(view, { kind: 'project', floor: 'ample' }, 'Project ample-shop', 'Project ample-shop');
  assert.deepEqual(rows(el.querySelector('table')!), [['house.style', '"project style"', 'Project', 'Project ample-shop'], ['ample.voice', '"voice"', 'Project', 'Project ample-shop']]);
  assert.equal(el.querySelector('p.harness-digest')!.textContent, 'Manifest digest (snapshot SHA-256): ' + sha);
  assert.equal(previewDigest('no snapshot'), undefined);
  panel.show({ ...view, preview: '', warning: 'Assigned harness resource is unavailable' }, { kind: 'project', floor: 'ample' }, 'Project ample-shop', 'Project ample-shop');
  assert.match(el.querySelector('p.harness-digest')!.textContent, /Handoff blocked: Assigned harness resource is unavailable/);
});

test('the latest() guard: each next() aborts the one before, and only the newest is current', () => {
  const outer = new AbortController();
  const series = model.latest(outer.signal);
  const a = series.next();
  const b = series.next();
  assert.equal(a.signal.aborted, true);
  assert.equal(a.current(), false);
  assert.equal(b.current(), true);
  outer.abort();
  assert.equal(b.signal.aborted, true, 'closing the library aborts what is in flight');
  assert.equal(b.current(), false);
});

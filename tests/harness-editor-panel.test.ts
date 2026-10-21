// The category navigator, the element detail and the slot editor under node's fake DOM
// (tests/support/fake-dom.ts; docs/harness.md "Categories and the editor"): 1,200 elements rendered by
// category and shelf within a time budget and never as one flat list, search as an add-on, long names and
// unavailable sources; the three-way legend; slot states (inherited / own / disabled) and their buttons;
// the draft diff; a save conflict (what changed, Keep editing rebases, Reload drops); the read-only editor
// with its reason. The browser and the real routes are tests/harness-editor.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byText, installFakeDom, type FakeNode } from './support/fake-dom.js';
import { HARNESS_CATEGORIES, type HarnessEntry } from '../src/shared/harness.js';
import { HARNESS_LEVELS, type HarnessLayer, type HarnessProfile } from '../src/shared/harness-cascade.js';

installFakeDom();
const { categoryNavigator, SHELF_PAGE } = await import('../src/client/features/harness/navigator.js');
const { cascadePanel } = await import('../src/client/features/harness/cascade.js');
const { legend } = await import('../src/client/features/harness/slot-editor.js');
const { elementDetail, suggestSlot, sourceLines } = await import('../src/client/features/harness/detail.js');
const { resourceText } = await import('../src/client/features/harness/receives.js');
const { formProblem } = await import('../src/client/features/harness/create-element.js');
const model = await import('../src/client/features/harness/slots-model.js');

const node = (x: unknown) => x as FakeNode;
const click = (n: FakeNode | undefined) => { assert.ok(n, 'the control is there'); (n as unknown as { onclick(): void }).onclick(); };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const texts = (root: FakeNode, selector: string) => root.querySelectorAll(selector).map((n) => n.textContent);
const isDisabled = (n: FakeNode) => n.disabled || n.getAttribute('disabled') !== null;

/** `count` elements over the thirteen categories, each category in a big shelf and six small ones, one with a very long name. */
function bulk(count: number): HarnessEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const category = HARNESS_CATEGORIES[i % HARNESS_CATEGORIES.length];
    const group = i % 2 === 0 ? 'common' : 'shelf-' + (i % 6);
    const title = i === 7 ? 'an-element-with-a-very-long-file-name-that-does-not-fit-on-one-line-of-a-phone-screen-at-all.md' : `element-${String(i).padStart(4, '0')}.md`;
    return { id: 'el:project:' + i.toString(16).padStart(20, '0'), title, category, group, source: i % 50 === 0 ? 'Machine / .claude/skills' : 'Project / .harness', path: `${category}/${group}/${title}`, version: 1, digest: 'ab'.repeat(32), aliases: [] };
  });
}

test('1,200 elements: thirteen categories with counts, shelves a page at a time, never a flat list, within the time budget', () => {
  const marks = { pack: new Set<string>(), saved: new Set<string>(), draft: new Set<string>() };
  const nav = categoryNavigator({ onPick: () => {}, current: () => undefined, marks: () => marks });
  const entries = bulk(1200);
  const started = performance.now();
  nav.set(entries, { sources: [{ name: 'Project / .harness', available: true }, { name: 'Machine / .claude/skills', available: true, reason: 'over-budget' }], limited: true });
  const firstRender = performance.now() - started;
  const cats = node(nav.el).querySelectorAll('button.harness-cat');
  assert.equal(cats.length, 13);
  assert.deepEqual(cats.map((c) => c.querySelector('span.harness-cat-name')!.textContent), [...HARNESS_CATEGORIES]);
  assert.equal(cats[0].querySelector('span.harness-count')!.textContent, '93', 'instructions holds every 13th element');
  assert.ok(cats.every((c) => c.querySelector('small.harness-cat-purpose')!.textContent.length > 20), 'every category says what it is for');
  assert.ok(cats.every((c) => c.querySelector('span.harness-badge')), 'a source cut by the discovery budget marks its categories partial');
  const list = node(nav.list);
  const rendered = list.querySelectorAll('button.harness-entry').length;
  assert.equal(rendered, SHELF_PAGE, 'a big category opens its first shelf only, one page of it');
  assert.ok(rendered < 1200 / 10, 'not a flat dump');
  assert.match(node(nav.heading).querySelector('p.harness-truncated')!.textContent, /Catalog truncated at 1,200 elements: 93 instructions shown here/);
  const groups = list.querySelectorAll('button.harness-group').map((b) => b.children.filter((c) => c.isText).map((c) => c.textContent).join(''));
  assert.deepEqual(groups, ['common', 'shelf-1', 'shelf-3', 'shelf-5'], 'the shelves are the folders, sorted');
  // Every category in turn, timed: building one is a few shelves, whatever the catalog's size.
  const switches: number[] = [];
  for (const c of cats) { const t = performance.now(); click(c); switches.push(performance.now() - t); }
  const worst = Math.max(...switches);
  console.log(`# navigator: first render of 1,200 elements ${firstRender.toFixed(1)} ms, category switch worst ${worst.toFixed(1)} ms (fake DOM)`);
  assert.ok(firstRender < 250 && worst < 100, `render budget: first ${firstRender.toFixed(1)} ms, switch ${worst.toFixed(1)} ms`);
  // Show more pages through a shelf; a closed shelf opens.
  click(cats[0]);
  click(list.querySelector('button.harness-more')!);
  assert.equal(list.querySelectorAll('button.harness-entry').length, 47, 'the rest of the big shelf (47 of 47)');
  const closed = list.querySelectorAll('button.harness-group').find((g) => g.getAttribute('aria-expanded') === 'false')!;
  click(closed);
  assert.ok(list.querySelectorAll('button.harness-entry').length > 47, 'an opened shelf shows its elements');
});

test('search is an add-on: within the chosen category, or across all; long names stay whole; no match offers Clear filters', () => {
  const nav = categoryNavigator({ onPick: () => {}, current: () => undefined, marks: () => ({ pack: new Set(), saved: new Set(), draft: new Set() }) });
  nav.set(bulk(1200), { sources: [], limited: false });
  const list = node(nav.list);
  const search = node(nav.search), scope = node(nav.scope);
  search.value = 'element-0014';
  (search as unknown as { oninput(): void }).oninput();
  assert.deepEqual(texts(list, 'button.harness-entry').map((t) => t.replace(/\s.*/, '')), [], 'element-0014 is a skill: not in instructions');
  assert.match(list.textContent, /No matching resources\./);
  scope.value = 'all';
  (scope as unknown as { onchange(): void }).onchange();
  const hits = list.querySelectorAll('button.harness-entry');
  assert.equal(hits.length, 1);
  assert.match(hits[0].textContent, /element-0014\.md/);
  assert.deepEqual(texts(list, 'h5.harness-cat-head'), ['skills'], 'results keep their category and shelf');
  assert.equal(node(nav.el).querySelectorAll('button.harness-cat').filter((c) => c.getAttribute('aria-pressed') === 'true').length, 0, 'across all, no category is the chosen one');
  search.value = 'very long file name'.split(' ').join('-');
  (search as unknown as { oninput(): void }).oninput();
  assert.match(list.textContent, /an-element-with-a-very-long-file-name-that-does-not-fit-on-one-line-of-a-phone-screen-at-all\.md/, 'the whole name, never cut');
  search.value = 'no-such-thing';
  (search as unknown as { oninput(): void }).oninput();
  click(byText(list, 'Clear filters'));
  assert.equal(search.value, '');
  assert.equal(scope.value, 'category');
});

test('the marks: ✎ in the draft, ● assigned in the saved profile, ◆ in the ad-hoc pack', () => {
  const entries = bulk(26);
  const marks = { pack: new Set([entries[0].id]), saved: new Set([entries[13].id]), draft: new Set([entries[13].id]) };
  const nav = categoryNavigator({ onPick: () => {}, current: () => entries[0].id, marks: () => marks });
  nav.set(entries, { sources: [], limited: false });
  const items = node(nav.list).querySelectorAll('button.harness-entry');
  assert.match(items[0].textContent, /^◆ element-0000\.md/);
  assert.equal(items[0].getAttribute('aria-pressed'), 'true');
  assert.match(items[1].textContent, /^✎ ● element-0013\.md/);
});

test('the legend names the three things apart: Draft | Saved profile (revision N) | Ad-hoc pack', () => {
  const l = legend();
  l.revision(7);
  assert.deepEqual(node(l.el).querySelectorAll('li').map((li) => li.textContent), ['✎ Draft (unsaved)', '● Saved profile (revision 7)', '◆ Ad-hoc pack (exported, never saved)']);
});

type View = HarnessProfile & { tasks: never[]; audit: never[]; writable: boolean; globalWrite: boolean; preview: string; warning: string; resources?: Record<string, unknown> };
function profile(project: HarnessLayer, extra: Partial<View> = {}, revision = 4): View {
  const layers = Object.fromEntries(HARNESS_LEVELS.map((l) => [l, {}])) as HarnessProfile['layers'];
  layers.global = { 'house.style': { value: 'shared style' }, 'rules.start': { resource: 'guide:instructions' }, 'hooks.after': { resource: 'guide:hooks' } };
  layers.project = project;
  return { revision, path: [], layers, effective: {}, tasks: [], audit: [], writable: true, globalWrite: true, preview: '', warning: '', resources: { 'guide:instructions': { status: 'available', title: 'Start here', category: 'instructions', group: 'handbook', source: 'Harness handbook', path: 'start.md', version: 2, digest: 'cd'.repeat(32) } }, ...extra };
}
/** The editor on the project; profile replies come from `answer(method, body)` (status 200 unless it says). */
function editor(answer: (method: string, body: unknown) => { status?: number; body: unknown }, picked?: { id: string; title: string }) {
  const sent: { method: string; body: unknown }[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method, body });
    const reply = answer(method, body);
    return { ok: (reply.status ?? 200) < 400, status: reply.status ?? 200, json: async () => reply.body } as Response;
  }) as unknown as typeof fetch;
  const panel = cascadePanel({ opened: 'ample', signal: new AbortController().signal, label: () => 'Project ample-shop', repoOf: () => 'ra', onView: () => {}, selected: () => picked });
  panel.show({ kind: 'project', floor: 'ample' });
  const el = node(panel.el);
  const row = (slot: string) => el.querySelectorAll('li.harness-slot').find((li) => li.querySelector('code.harness-slot-name')!.textContent === slot)!;
  const button = (slot: string, label: string) => row(slot).querySelectorAll('button').find((b) => b.textContent === label)!;
  return { panel, el, sent, row, button, draft: () => el.querySelector('section.harness-draft')!.querySelector('ul.harness-diff')!.children.map((li) => li.textContent).join(' | ') };
}

test('slot states: inherited from Global, own, disabled; Reset to inherited, Disable and Assign make a draft listed as from → to', async () => {
  const e = editor(() => ({ body: profile({ 'ample.voice': { value: 'voice' }, 'hooks.after': null }) }), { id: 'el:project:00000000000000000abc', title: 'checklist.md' });
  await settle();
  const states = e.el.querySelectorAll('li.harness-slot').map((li) => [li.querySelector('code.harness-slot-name')!.textContent, li.getAttribute('data-state')]);
  assert.deepEqual(states, [['ample.voice', 'own'], ['hooks.after', 'disabled'], ['house.style', 'inherited'], ['rules.start', 'inherited']]);
  assert.match(e.row('rules.start').textContent, /Start here \(revision 2 · cdcdcdcdcdcd\) — from Global/, 'an inherited element names its title, revision and short digest');
  assert.match(e.row('hooks.after').textContent, /disabled \(overrides Global: guide:hooks\)/);
  assert.ok(isDisabled(e.button('house.style', 'Reset to inherited')), 'nothing to reset on an inherited slot');
  assert.ok(isDisabled(e.button('hooks.after', 'Disable')), 'a disabled slot cannot be disabled again');
  assert.match(e.draft(), /This level is as saved in revision 4/);
  assert.equal(e.panel.dirty(), false);
  click(e.button('house.style', 'Disable'));
  click(e.button('ample.voice', 'Reset to inherited'));
  click(e.button('hooks.after', 'Assign open element'));
  assert.equal(e.row('house.style').getAttribute('data-state'), 'disabled');
  assert.equal(e.row('house.style').getAttribute('data-draft'), 'true');
  assert.equal(e.row('hooks.after').getAttribute('data-state'), 'own');
  assert.equal(e.panel.dirty(), true);
  assert.match(e.draft(), /ample\.voice: "voice" → inherit/);
  assert.match(e.draft(), /hooks\.after: disabled → el:project:00000000000000000abc/);
  assert.match(e.draft(), /house\.style: inherit → disabled/);
  assert.match(texts(e.el, 'h4').join(' '), /✎ Draft: 3 unsaved changes/);
  // A value set in place, typed like the slot; a bad one says why and changes nothing.
  e.el.querySelectorAll('input').find((i) => i.getAttribute('aria-label') === 'New slot name')!.value = 'limits.turns';
  const kind = e.el.querySelectorAll('select').find((s) => s.getAttribute('aria-label') === 'New slot kind')!;
  kind.value = 'number';
  e.el.querySelectorAll('input').find((i) => i.getAttribute('aria-label') === 'New slot value')!.value = 'many';
  click(byText(e.el, 'Add slot'));
  assert.match(e.el.textContent, /Enter a number/);
  e.el.querySelectorAll('input').find((i) => i.getAttribute('aria-label') === 'New slot value')!.value = '12';
  click(byText(e.el, 'Add slot'));
  assert.match(e.draft(), /limits\.turns: inherit → 12/);
  // Save layer sends the draft as the layer, at the revision it was opened on.
  click(byText(e.el, 'Save layer'));
  await settle();
  const posted = e.sent.find((s) => s.method === 'POST')!.body as { layer: HarnessLayer; revision: number; scope: string };
  assert.equal(posted.scope, 'project');
  assert.equal(posted.revision, 4);
  assert.deepEqual(posted.layer, { 'hooks.after': { resource: 'el:project:00000000000000000abc' }, 'house.style': null, 'limits.turns': { value: 12 } });
});

test('discard drops the draft; "Advanced: JSON" edits the same draft and a bad layer holds Save layer with the reason', async () => {
  const e = editor(() => ({ body: profile({ 'ample.voice': { value: 'voice' } }) }));
  await settle();
  click(e.button('ample.voice', 'Disable'));
  click(byText(e.el, 'Discard changes'));
  assert.equal(e.panel.dirty(), false);
  assert.equal(e.row('ample.voice').getAttribute('data-state'), 'own');
  const json = e.el.querySelector('textarea')!;
  json.value = '{"ample.voice": {"value": "typed"}, "x": null}';
  (json as unknown as { oninput(): void }).oninput();
  assert.match(e.draft(), /ample\.voice: "voice" → "typed"/);
  assert.match(e.draft(), /x: inherit → disabled/);
  json.value = '{"bad slot": 1}';
  (json as unknown as { oninput(): void }).oninput();
  assert.match(e.draft(), /Advanced: JSON — "bad slot": A slot name starts with a letter/);
  assert.ok(isDisabled(byText(e.el, 'Save layer')!));
});

test('a save conflict lists what changed on the server; Keep editing rebases the draft on the new revision, Reload drops it', async () => {
  let revision = 4;
  let server: HarnessLayer = { 'ample.voice': { value: 'voice' } };
  const e = editor((method) => {
    if (method === 'POST') return { status: 409, body: { error: 'Profiles changed elsewhere. Reload before saving.' } };
    return { body: profile(server, {}, revision) };
  });
  await settle();
  click(e.button('house.style', 'Disable'));
  // Someone else saves: ample.voice changes, a slot is added.
  revision = 5;
  server = { 'ample.voice': { value: 'server' }, 'new.slot': { value: 1 } };
  click(byText(e.el, 'Save layer'));
  await settle();
  const alert = e.el.querySelector('div.harness-conflict')!;
  assert.equal(alert.hidden, false);
  assert.match(alert.textContent, /You started from revision 4; the store is at revision 5 now/);
  assert.match(alert.textContent, /ample\.voice: "voice" → "server"/);
  assert.match(alert.textContent, /new\.slot: inherit → 1/);
  assert.ok(isDisabled(byText(e.el, 'Save layer')!), 'no save until the conflict is resolved');
  assert.equal(e.panel.dirty(), true, 'the draft is kept');
  click(byText(alert, 'Keep editing'));
  assert.equal(alert.hidden, true);
  assert.match(e.draft(), /^house\.style: inherit → disabled$/, 'only the draft\'s own change is left, on top of revision 5');
  assert.equal(e.row('ample.voice').textContent.includes('"server"'), true, 'the other save is kept');
  // Again, and Reload this time.
  revision = 6;
  server = { 'ample.voice': { value: 'later' } };
  click(byText(e.el, 'Save layer'));
  await settle();
  click(byText(e.el.querySelector('div.harness-conflict')!, 'Reload (drop my draft)'));
  assert.match(e.draft(), /This level is as saved in revision 6/);
  assert.equal(e.panel.dirty(), false);
});

test('403 and 503 say what to do; a member\'s editor is read-only with the reason, and its buttons do nothing', async () => {
  const e = editor((method) => (method === 'POST' ? { status: 503, body: { error: 'Another office is saving harness profiles.' } } : { body: profile({ 'ample.voice': { value: 'voice' } }) }));
  await settle();
  click(e.button('ample.voice', 'Disable'));
  click(byText(e.el, 'Save layer'));
  await settle();
  assert.match(e.el.querySelector('p.harness-save-status')!.textContent, /^Not saved: Another office is saving harness profiles\. Nothing was written; try again in a moment\.$/);
  const forbidden = editor((method) => (method === 'POST' ? { status: 403, body: { error: 'Only administrators and their active orchestrator can assign harness profiles.' } } : { body: profile({}) }));
  await settle();
  click(forbidden.button('house.style', 'Disable'));
  click(byText(forbidden.el, 'Save layer'));
  await settle();
  assert.match(forbidden.el.querySelector('p.harness-save-status')!.textContent, /Not saved: Only administrators .* Ask an administrator to save it\./);

  const member = editor(() => ({ body: profile({ 'ample.voice': { value: 'voice' } }, { writable: false, globalWrite: false }) }), { id: 'el:project:1', title: 'x' });
  await settle();
  const note = member.el.querySelector('p.harness-readonly')!;
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /^Read-only: only administrators/);
  for (const label of ['Assign open element', 'Reset to inherited', 'Disable', 'Set value']) assert.ok(isDisabled(member.button('ample.voice', label)), label + ' is disabled');
  assert.ok(isDisabled(byText(member.el, 'Save layer')!));
  assert.ok(isDisabled(byText(member.el, 'Add slot')!));
  assert.match(member.panel.assign({ id: 'el:project:1', title: 'x' }, 'rules.x'), /^Read-only/);
  assert.equal(member.panel.dirty(), false, 'nothing changed');
});

test('the element detail: ID, revision and a short digest with copy (the full digest copied), purpose, availability with the fix, usage', () => {
  const copied: string[] = [];
  const detail = elementDetail({ copy: (t) => copied.push(t), assign: (e, slot) => `assigned ${e.id} to ${slot}`, slotNames: () => ['rules.start'], usage: () => ({ saved: ['Global · rules.start', 'Sector Kitchen · rules.x'], draft: true }), assignBlocked: () => '' });
  const e = bulk(1)[0];
  const digest = '0123456789abcdef'.repeat(4);
  detail.show({ ...e, digest, version: 3 }, [{ name: e.source, available: true, reason: 'over-budget' }]);
  const el = node(detail.el);
  assert.equal(el.querySelector('code.harness-id')!.textContent, e.id);
  assert.equal(el.querySelector('span.harness-revision')!.textContent, 'revision 3');
  assert.equal(el.querySelector('code.harness-digest-short')!.textContent, 'sha256:0123456789ab…');
  assert.equal(el.querySelector('code.harness-digest-short')!.getAttribute('title'), 'sha256:' + digest);
  click(el.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Copy digest'));
  click(el.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Copy element ID'));
  assert.deepEqual(copied, [digest, e.id]);
  assert.match(el.querySelector('p.harness-detail-purpose')!.textContent, /Task framing/);
  assert.match(el.querySelector('span.harness-availability')!.textContent, /^Available: listed and readable now\. Its source was not read in full \(over-budget\): Discovery stopped at its limit/);
  assert.equal(el.querySelector('span.harness-usage')!.textContent, 'Global · rules.start, Sector Kitchen · rules.x · ✎ changed in the draft');
  assert.equal(el.querySelector('input')!.value, 'instructions.element-0000', 'a slot suggested from the category and title');
  click(byText(el, 'Assign to slot'));
  assert.equal(el.querySelector('p.harness-assign-status')!.textContent, `assigned ${e.id} to instructions.element-0000`);
  el.querySelector('input')!.value = 'not a slot';
  click(byText(el, 'Assign to slot'));
  assert.match(el.querySelector('p.harness-assign-status')!.textContent, /A slot name starts with a letter/);
  detail.show({ ...e, digest }, [], 'This element is not listed any more (moved, deleted or no longer publishable).');
  assert.equal(el.getAttribute('data-available'), 'false');
  assert.match(el.querySelector('span.harness-availability')!.textContent, /^Unavailable: This element is not listed any more .* Refresh the library/);
  assert.equal(suggestSlot({ category: 'skills', title: 'Review / SKILL.md' }), 'skills.review-skill');
  assert.deepEqual(sourceLines([{ name: 'A', available: true }, { name: 'B', available: false, reason: 'missing' }, { name: 'C', available: true, reason: 'unreadable' }]).map((p) => node(p).getAttribute('data-reason')), ['ok', 'missing', 'unreadable']);
});

test('what the worker receives names an element with its revision and short digest, or why it is unavailable', () => {
  assert.equal(resourceText('guide:testing', undefined), 'resource guide:testing');
  assert.equal(resourceText('el:project:1', { status: 'available', title: 'checklist.md', category: 'rules', group: 'review', source: 'Project / .harness', path: 'rules/review/checklist.md', version: 2, digest: 'ef'.repeat(32) }), 'resource checklist.md · el:project:1 · revision 2 · sha256:efefefefefef');
  assert.match(resourceText('el:project:1', { status: 'missing', title: 'x', category: 'rules', source: 's', path: 'rules/x.md', version: 1, digest: '', missingSince: '2026-10-20T10:00:00Z', lastSeenAt: '' }), /unavailable: missing since 2026-10-20 \(rules\/x\.md\)/);
});

test('the model: diff, rebase, layer text, settings and inheritance', () => {
  assert.deepEqual(model.diffLayers({ a: { value: 1 }, b: null }, { a: { value: 2 }, c: { resource: 'x' } }), [{ slot: 'a', from: { value: 1 }, to: { value: 2 } }, { slot: 'b', from: null, to: undefined }, { slot: 'c', from: undefined, to: { resource: 'x' } }]);
  assert.deepEqual(model.rebase({ a: { value: 1 }, b: { value: 1 } }, { a: { value: 9 } }, { a: { value: 2 }, b: { value: 3 }, n: null }), { a: { value: 9 }, n: null }, 'the draft removed b and changed a; the server\'s new slot stays');
  assert.ok('error' in model.parseLayerText('[]'));
  assert.ok('error' in model.parseLayerText('{"a": {"value": 1, "resource": "x"}}'));
  assert.ok('error' in model.parseLayerText('{"__proto__": null}'));
  assert.deepEqual(model.parseLayerText('{"a": null, "b": {"value": true}}'), { layer: { a: null, b: { value: true } } });
  assert.deepEqual(model.parseSetting('true', 'boolean'), { value: true });
  assert.ok('error' in model.parseSetting('x'.repeat(4001), 'string'));
  const inherited = model.inheritedAt({ global: { a: { value: 1 } }, project: { a: { value: 2 }, b: null }, sector: { c: { value: 3 } } }, [{ level: 'sector', node: 'opora:p:w:s', name: 'S' }], 'sector');
  assert.deepEqual(Object.keys(inherited).sort(), ['a', 'b'], 'a sector inherits Global and the project, not its own slots');
  assert.equal(inherited.a.scope, 'project');
  assert.equal(formProblem('../x', 'a.md', 'x'), 'The group folder takes up to 64 letters, digits, ".", "_" or "-" (no slashes, no "..").');
  assert.match(formProblem('', 'a.exe', 'x'), /Use a text type/);
  assert.equal(formProblem('review', 'a.md', 'x'), '');
});

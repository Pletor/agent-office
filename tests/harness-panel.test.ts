// The library's panels under node's fake DOM (tests/support/fake-dom.ts): "What the worker receives"
// (src/client/features/harness/receives.ts) never shows a blank node and names each slot's level and
// node; the editor (cascade.ts) shows the no-area notice for the loaded specialization's path, not for the
// whole canvas. Layout and the real browser are tests/harness.browser.mjs and tests/harness-context.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, rows, type FakeNode } from './support/fake-dom.js';
import { HARNESS_LEVELS, type HarnessPath, type HarnessProfile } from '../src/shared/harness-cascade.js';

installFakeDom();
const { receivesPanel } = await import('../src/client/features/harness/receives.js');
const { cascadePanel } = await import('../src/client/features/harness/cascade.js');

type View = HarnessProfile & { tasks: unknown[]; audit: never[]; writable: boolean; globalWrite: boolean; preview: string; warning: string; levels: readonly string[] };
function view(path: HarnessPath, effective: HarnessProfile['effective']): View {
  const layers = Object.fromEntries(HARNESS_LEVELS.map((l) => [l, {}])) as HarnessProfile['layers'];
  return { revision: 3, path, layers, effective, tasks: [], audit: [], writable: true, globalWrite: true, preview: '', warning: '', levels: HARNESS_LEVELS };
}
const task = { kind: 'node', floor: 'f', node: 'opora:p:w:card', level: 'task', name: 'Card 1' } as const;

test('the preview names each slot\'s level and node, and falls back to the key when the canvas gave the node no name', () => {
  const path: HarnessPath = [{ level: 'page', node: 'opora:p:w:page', name: 'Shop' }, { level: 'sector', node: 'opora:p:w:sector' }, { level: 'task', node: 'opora:p:w:card', name: 'Card 1' }];
  const panel = receivesPanel();
  panel.show(view(path, {
    color: { binding: { value: 'red' }, scope: 'global' },
    voice: { binding: { value: 'calm' }, scope: 'project' },
    tone: { binding: { value: 'terse' }, scope: 'page', node: 'opora:p:w:page', nodeName: 'Shop' },
    pace: { binding: null, scope: 'sector', node: 'opora:p:w:sector' },
    rule: { binding: { resource: 'guide:testing' }, scope: 'task', node: 'opora:p:w:card', nodeName: '' },
  }), task, 'Project shop › Task Card 1', 'Project shop');
  const table = (panel.el as unknown as FakeNode).querySelector('table')!;
  assert.deepEqual(rows(table), [
    ['color', '"red"', 'Global', 'Global'],
    ['voice', '"calm"', 'Project', 'Project shop'],
    ['tone', '"terse"', 'Page', 'Shop'],
    ['pace', 'null (disabled)', 'Sector', 'opora:p:w:sector'],
    ['rule', 'resource guide:testing', 'Task', 'Card 1'],
  ], 'an unnamed sector shows its key, an empty nodeName falls back to the path\'s name, and no cell is ever blank');
  for (const row of rows(table)) assert.ok(row.every((cell) => cell.trim()), `no empty cell in ${row}`);
});

test('a custom task with nothing above it shows its id as the node, never an empty cell', () => {
  const panel = receivesPanel();
  panel.show(view([{ level: 'task', node: 'custom-42' }], { color: { binding: { value: 'x' }, scope: 'task', node: 'custom-42' } }), { ...task, node: 'custom-42' }, 'Task custom-42', 'Project shop');
  assert.deepEqual(rows((panel.el as unknown as FakeNode).querySelector('table')!), [['color', '"x"', 'Task', 'custom-42']]);
});

/** The editor after showing `ctx` with `data` as the profile reply. */
async function editor(data: View, ctx: Parameters<ReturnType<typeof cascadePanel>['show']>[0]) {
  globalThis.fetch = (async () => ({ ok: true, json: async () => data })) as unknown as typeof fetch;
  let shown = false;
  const panel = cascadePanel({ opened: 'f', signal: new AbortController().signal, label: () => 'here', repoOf: () => 'r', onView: () => { shown = true; } });
  panel.show(ctx);
  for (let i = 0; i < 50 && !shown; i++) await new Promise((r) => setImmediate(r));
  return (panel.el as unknown as FakeNode).querySelector('p.harness-notice')!;
}

test('the no-area notice is about the loaded specialization\'s path: shown for a path without an area, hidden with one and for the project', async () => {
  const noArea = await editor(view([{ level: 'page', node: 'opora:p:w:page', name: 'Shop' }, { level: 'task', node: 'opora:p:w:card', name: 'Card 1' }], {}), task);
  assert.equal(noArea.hidden, false);
  assert.match(noArea.textContent, /this target has no area on its path/);
  const withArea = await editor(view([{ level: 'page', node: 'opora:p:w:page' }, { level: 'area', node: 'opora:p:w:area', name: 'Area' }, { level: 'sector', node: 'opora:p:w:sector' }, { level: 'task', node: 'opora:p:w:card' }], {}), task);
  assert.equal(withArea.hidden, true);
  const project = await editor(view([], {}), { kind: 'project', floor: 'f' });
  assert.equal(project.hidden, true, 'the project alone has no path to speak of');
});

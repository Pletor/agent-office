// The inheritance editor's rendering (src/client/features/harness/cascade.ts) under node's fake DOM
// (tests/support/fake-dom.ts): the effective table never shows a blank node, and the no-area notice
// speaks of the loaded target's path, not of the whole canvas. Layout and the real browser are
// tests/harness.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byText, installFakeDom, rows, type FakeNode } from './support/fake-dom.js';
import { HARNESS_LEVELS, type HarnessPath, type HarnessProfile } from '../src/shared/harness-cascade.js';

installFakeDom();
const { cascadePanel } = await import('../src/client/features/harness/cascade.js');

type View = HarnessProfile & { tasks: unknown[]; audit: unknown[]; writable: boolean; globalWrite: boolean; preview: string; warning: string; levels: readonly string[] };
function view(path: HarnessPath, effective: HarnessProfile['effective'], audit: unknown[] = []): View {
  const layers = Object.fromEntries(HARNESS_LEVELS.map((l) => [l, {}])) as HarnessProfile['layers'];
  return { revision: 3, path, layers, effective, tasks: [], audit, writable: true, globalWrite: true, preview: '', warning: '', levels: HARNESS_LEVELS };
}
/** The panel after loading `data` through its reload button (fetch is the panel's only way in). */
async function render(data: View) {
  globalThis.fetch = (async () => ({ ok: true, json: async () => data })) as unknown as typeof fetch;
  const panel = cascadePanel('floor', new AbortController().signal);
  const el = panel.el as unknown as FakeNode;
  (byText(el, 'Load task / reload') as unknown as { onclick(): void }).onclick();
  for (let i = 0; i < 50 && !el.querySelector('tbody')?.children.length; i++) await new Promise((r) => setImmediate(r));
  const table = el.querySelector('table')!;
  const notice = el.querySelector('p.harness-notice')!;
  return { el, table, notice, rows: rows(table) };
}

test('the effective table names each slot\'s node, and falls back to the key when the canvas gave the node no name', async () => {
  const path: HarnessPath = [{ level: 'page', node: 'opora:p:w:page', name: 'Shop' }, { level: 'sector', node: 'opora:p:w:sector' }, { level: 'task', node: 'opora:p:w:card', name: 'Card 1' }];
  const { rows, el } = await render(view(path, {
    color: { binding: { value: 'red' }, scope: 'global' },
    tone: { binding: { value: 'terse' }, scope: 'page', node: 'opora:p:w:page', nodeName: 'Shop' },
    pace: { binding: null, scope: 'sector', node: 'opora:p:w:sector' },
    rule: { binding: { resource: 'guide:testing' }, scope: 'task', node: 'opora:p:w:card', nodeName: '' },
  }, [{ at: '2026-10-20T10:00:00.000Z', revision: 3, level: 'sector', node: 'opora:p:w:sector', by: 'account:ana', slots: ['pace'] }]));
  assert.deepEqual(rows, [
    ['color', '"red"', 'global', '—'],
    ['tone', '"terse"', 'page', 'Shop'],
    ['pace', 'null (disabled)', 'sector', 'opora:p:w:sector'],
    ['rule', 'resource guide:testing', 'task', 'Card 1'],
  ], 'an unnamed sector shows its key, an empty nodeName falls back to the path\'s name, and no cell is ever blank');
  for (const row of rows) assert.ok(row.every((cell) => cell.trim()), `no empty cell in ${row}`);
  assert.match(el.querySelectorAll('pre.harness-effective')[1].textContent, /sector opora:p:w:sector by account:ana: pace/, 'the audit names the unnamed node by its key too');
});

test('a custom task with nothing above it shows its id as the node, never an empty cell', async () => {
  const { rows } = await render(view([{ level: 'task', node: 'custom-42' }], { color: { binding: { value: 'x' }, scope: 'task', node: 'custom-42' } }));
  assert.deepEqual(rows, [['color', '"x"', 'task', 'custom-42']]);
});

test('the no-area notice is about the loaded target\'s path: shown for a path without an area, hidden with one and for the project alone', async () => {
  const noArea = await render(view([{ level: 'page', node: 'opora:p:w:page', name: 'Shop' }, { level: 'task', node: 'opora:p:w:loose', name: 'Loose card' }], { color: { binding: { value: 'red' }, scope: 'global' } }));
  assert.equal(noArea.notice.hidden, false);
  assert.match(noArea.notice.textContent, /this target has no area on its path/);
  assert.doesNotMatch(noArea.notice.textContent, /this canvas has no area/);
  const withArea = await render(view([{ level: 'page', node: 'opora:p:w:page' }, { level: 'area', node: 'opora:p:w:area', name: 'Area' }, { level: 'sector', node: 'opora:p:w:sector' }, { level: 'task', node: 'opora:p:w:card' }], { color: { binding: { value: 'red' }, scope: 'area', node: 'opora:p:w:area', nodeName: 'Area' } }));
  assert.equal(withArea.notice.hidden, true);
  const projectOnly = await render(view([], { color: { binding: { value: 'red' }, scope: 'project' } }));
  assert.equal(projectOnly.notice.hidden, true, 'the project alone has no path to speak of');
});

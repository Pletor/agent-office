// The category navigator and the level editor end to end (docs/harness.md "Categories and the editor"):
// the four-floor office of tests/support/harness-context-office.ts with the element route, Tajemství's
// checkout holding 1,250 extra elements (tests/fixtures/harness-editor-office.ts), through the visual lab on Vite.
//
// Run Vite on HARNESS_LAB_URL (default http://localhost:5211/lab/harness.html): `npx vite --port 5211`.
// Then `node tests/harness-editor.browser.mjs`. Screenshots go to HARNESS_SHOTS (or the OS temp folder).
//
// Checks: an administrator creates an element in .harness from the library, assigns it at project level
// without typing JSON, saves, sees it in "What the worker receives" with its revision and digest, resets
// it to inherited, disables an inherited Global slot, and gets a save conflict from a second session (what
// changed is listed; Keep editing rebases the draft); a named member gets a read-only editor with the reason
// and a 403 from the element route; 1,250 elements are navigated by category and shelf (never one flat list,
// with the truncation notice) and searched as an add-on, timed; an unbound floor is bound after a confirmation;
// 1440 and 390 px have no sideways scroll; Esc and ✕ close the library.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, request } from 'playwright-core';

const lab = process.env.HARNESS_LAB_URL ?? 'http://localhost:5211/lab/harness.html';
const shots = process.env.HARNESS_SHOTS ?? os.tmpdir();
mkdirSync(shots, { recursive: true });

const home = mkdtempSync(path.join(os.tmpdir(), 'harness-editor-home-'));
const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/harness-editor-office.ts'], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, HOME: home, USERPROFILE: home } });
const base = await new Promise((resolve, reject) => {
  let out = '';
  child.stdout.on('data', (d) => { out += d; const m = /READY (\S+)/.exec(out); if (m) resolve(m[1]); });
  child.on('exit', (code) => reject(new Error('the office stopped: ' + code)));
});
const api = await request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
async function save(floor, scope, layer) {
  const url = '/api/harness/profile?' + new URLSearchParams({ floor });
  const read = await (await api.get(url)).json();
  const response = await api.post(url, { data: { scope, layer, revision: read.revision } });
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}
await save('ample', 'global', { 'house.style': { value: 'shared style' }, 'rules.start': { resource: 'guide:instructions' } });
await save('ample', 'project', { 'ample.voice': { value: 'Ample voice' } });

const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
const timings = {};
async function open(width, height, floor = 'ample', role = 'admin') {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 700, isMobile: width < 700 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/harness**', async (route) => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    const headers = { 'content-type': 'application/json', ...(role === 'member' ? { 'x-test-role': 'member' } : {}) };
    const response = await api.fetch(url.pathname + url.search, { method: incoming.method(), headers, ...(incoming.postData() ? { data: incoming.postData() } : {}) });
    await route.fulfill({ status: response.status(), headers: response.headers(), body: await response.body() }).catch(() => {});
  });
  await page.goto(lab + '?floor=' + floor);
  await page.waitForFunction(() => window.__ready);
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Open Harness', exact: true }).click();
  await page.getByRole('dialog', { name: 'Harness library' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.harness-list') && !document.querySelector('.harness-list').getAttribute('aria-busy') && document.querySelector('.harness-cat'), null, { timeout: 15000 });
  return { page, errors, openMs: Date.now() - t0 };
}
async function shot(page, name) {
  // Taken once the window's opening and the panes' slide-in have finished.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)));
  await page.screenshot({ path: path.join(shots, name) });
}
async function noSideways(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
}
async function openPanel(page, name, open = true) {
  const panel = page.locator(name === 'editor' ? '.harness-cascade' : '.harness-receives');
  if ((await panel.getAttribute('open')) !== null !== open) await panel.locator('> summary').click();
}
/** A category's button in the column, by its exact name (purposes mention other categories' names). */
const category = (page, name) => page.locator('.harness-cat', { has: page.locator('.harness-cat-name', { hasText: new RegExp('^' + name + '$') }) });
const slotRow = (page, slot) => page.locator('.harness-slot', { has: page.locator('.harness-slot-name', { hasText: new RegExp('^' + slot.replaceAll('.', '\\.') + '$') }) });
async function receivedRow(page, slot) {
  const rows = await page.locator('.harness-receives-table tbody tr').allInnerTexts();
  return rows.find((r) => r.startsWith(slot + '\t') || r.split(/\s+/)[0] === slot);
}
async function saved(page) {
  await page.getByRole('button', { name: 'Save layer' }).click();
  await page.locator('.harness-save-status').getByText(/^Saved as revision \d+/).waitFor();
}

try {
  // ── An administrator on Ample: create, assign, save, reset, disable, conflict ─────────────────────────
  {
    const { page, errors } = await open(1440, 900);
    await category(page, 'instructions').waitFor();
    assert.equal(await page.locator('.harness-cat').count(), 13, 'all thirteen categories are listed');
    await page.locator('.harness-list').getByText('ample-rules.md', { exact: true }).waitFor();
    await noSideways(page);
    await shot(page, 'editor-navigator-desktop.png');

    // Create an element in .harness/rules/review/ from the library.
    await page.getByRole('button', { name: '+ New element' }).click();
    await page.getByLabel('New element category').selectOption('rules');
    await page.getByLabel('New element group folder').fill('review');
    await page.getByLabel('New element file name').fill('checklist.md');
    await page.getByLabel('New element content').fill('# Review checklist\n\nRun the tests before asking for review.\n');
    await page.getByRole('button', { name: 'Create element' }).click();
    await page.getByRole('heading', { name: 'checklist.md', exact: true }).waitFor();
    const id = await page.locator('.harness-id').innerText();
    assert.match(id, /^el:project:[0-9a-f]{20}$/);
    assert.match(await page.locator('.harness-revision').innerText(), /^revision [1-9]\d*$/);
    assert.match(await page.locator('.harness-digest-short').innerText(), /^sha256:[0-9a-f]{12}…$/);
    assert.match(await page.locator('.harness-digest-short').getAttribute('title'), /^sha256:[0-9a-f]{64}$/, 'the full digest is the tooltip');
    assert.match(await page.locator('.harness-availability').innerText(), /^Available/);
    assert.equal(await page.locator('.harness-cat[aria-pressed=true] .harness-cat-name').textContent(), 'rules', 'the new element\'s category is shown');
    // Creating it again never overwrites it.
    await page.getByLabel('New element file name').fill('checklist.md');
    await page.getByLabel('New element content').fill('replacement');
    await page.getByRole('button', { name: 'Create element' }).click();
    await page.locator('.harness-create').getByText(/already exists: the library never overwrites/).waitFor();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await noSideways(page);
    await shot(page, 'editor-detail-desktop.png');

    // Assign it at project level, without JSON: the detail's slot picker, then the draft diff.
    assert.equal(await page.getByLabel('Slot to assign to').inputValue(), 'rules.checklist', 'a slot name is suggested from the category and title');
    await page.getByRole('button', { name: 'Assign to slot' }).click();
    // Assign opens the level's editor on the draft.
    await page.locator('.harness-cascade[open]').waitFor();
    assert.equal(await slotRow(page, 'rules.checklist').getAttribute('data-draft'), 'true');
    assert.match(await page.locator('.harness-draft').innerText(), /rules\.checklist: inherit → checklist\.md \(revision \d+ ·|rules\.checklist: inherit → checklist\.md/);
    assert.match(await page.locator('.harness-legend').innerText(), /Draft \(unsaved\)[\s\S]*Saved profile \(revision \d+\)[\s\S]*Ad-hoc pack \(exported, never saved\)/);
    await noSideways(page);
    await shot(page, 'editor-draft-desktop.png');
    await saved(page);
    await openPanel(page, 'preview');
    const assigned = await receivedRow(page, 'rules.checklist');
    assert.ok(assigned, 'the worker receives the slot');
    assert.match(assigned, new RegExp('checklist\\.md · ' + id + ' · revision \\d+ · sha256:[0-9a-f]{12}'), 'with its revision and digest: ' + assigned);
    assert.match(assigned, /Project/);
    await openPanel(page, 'preview', false);

    // Reset it to inherited: the slot leaves this level (nothing above sets it, so it is gone).
    await openPanel(page, 'editor');
    await slotRow(page, 'rules.checklist').getByRole('button', { name: 'Reset to inherited' }).click();
    assert.match(await page.locator('.harness-draft').innerText(), /rules\.checklist: checklist\.md[^→]*→ inherit/);
    await saved(page);
    await openPanel(page, 'preview');
    assert.equal(await receivedRow(page, 'rules.checklist'), undefined, 'reset: the worker no longer receives it');
    await openPanel(page, 'preview', false);

    // Disable a slot inherited from Global: null at the project, the worker receives it disabled.
    await openPanel(page, 'editor');
    assert.equal(await slotRow(page, 'house.style').getAttribute('data-state'), 'inherited');
    await slotRow(page, 'house.style').getByRole('button', { name: 'Disable' }).click();
    assert.equal(await slotRow(page, 'house.style').getAttribute('data-state'), 'disabled');
    await saved(page);
    await openPanel(page, 'preview');
    assert.match(await receivedRow(page, 'house.style'), /null \(disabled\)\s+Project/);
    await openPanel(page, 'preview', false);

    // A save conflict: the draft overrides ample.voice; a second session saves the project layer first.
    await openPanel(page, 'editor');
    await slotRow(page, 'ample.voice').getByLabel('Value of ample.voice').fill('draft voice');
    await slotRow(page, 'ample.voice').getByRole('button', { name: 'Set value' }).click();
    const now = await (await api.get('/api/harness/profile?floor=ample')).json();
    await save('ample', 'project', { ...now.layers.project, 'ample.voice': { value: 'server voice' } });
    await page.getByRole('button', { name: 'Save layer' }).click();
    const conflict = page.getByRole('alert').filter({ hasText: 'Not saved: the profile changed since you opened this draft' });
    await conflict.waitFor();
    assert.match(await conflict.innerText(), /ample\.voice: "Ample voice" → "server voice"/, 'what changed on the server is listed');
    await noSideways(page);
    await shot(page, 'editor-conflict-desktop.png');
    await conflict.getByRole('button', { name: 'Keep editing' }).click();
    assert.match(await page.locator('.harness-draft').innerText(), /ample\.voice: "server voice" → "draft voice"/, 'the draft sits on top of the newer revision');
    await saved(page);
    const after = await (await api.get('/api/harness/profile?floor=ample')).json();
    assert.deepEqual(after.layers.project['ample.voice'], { value: 'draft voice' });
    assert.equal(after.layers.project['house.style'], null, 'the disabled slot survived the rebase');

    // The raw layer is still there, optional.
    await page.locator('.harness-advanced > summary').click();
    assert.match(await page.getByLabel('Harness layer JSON').inputValue(), /"draft voice"/);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0, 'Esc closes the library');
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── A named member: read-only editor with the reason; the element route refuses ───────────────────────
  for (const [width, height, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
    const { page, errors } = await open(width, height, 'ample', 'member');
    await openPanel(page, 'editor');
    await page.locator('.harness-readonly').getByText(/Read-only: only administrators/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save layer' }).isDisabled(), true);
    assert.equal(await slotRow(page, 'ample.voice').getByRole('button', { name: 'Disable' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '+ New element' }).isDisabled(), true);
    await noSideways(page);
    await shot(page, `editor-readonly-${tag}.png`);
    assert.deepEqual(errors, []);
    await page.close();
  }
  const refused = await api.post('/api/harness/element?floor=ample', { headers: { 'x-test-role': 'member' }, data: { category: 'rules', name: 'x.md', content: 'x' } });
  assert.equal(refused.status(), 403, 'a member cannot create elements through the API either');

  // ── 1,250 elements on Tajemství: categories and shelves, never a flat list; search as an add-on ──────
  {
    const { page, errors, openMs } = await open(1440, 900, 'tajemstvi');
    timings.openToListMs = openMs;
    await page.locator('.harness-truncated').first().waitFor();
    assert.match(await page.locator('.harness-truncated').innerText(), /Catalog truncated/);
    const total = Number((await page.locator('.harness-status').innerText()).match(/^(\d+)/)[1]);
    assert.ok(total >= 1100, 'the big catalog is listed: ' + total);
    const entries = await page.locator('.harness-entry').count();
    assert.ok(entries <= 3 * 40, `a category shows a page of a shelf at a time, not ${total} rows: ${entries}`);
    timings.categoryClickMs = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.harness-cat')].find((x) => x.textContent.startsWith('memory'));
      const t = performance.now(); b.click(); void document.body.offsetHeight; return Math.round((performance.now() - t) * 10) / 10;
    });
    timings.searchAllMs = await page.evaluate(() => {
      const scope = document.querySelector('select[aria-label="Search scope"]'); scope.value = 'all';
      const input = document.querySelector('input[aria-label="Search harness resources"]'); input.value = 'element-0042';
      const t = performance.now(); input.dispatchEvent(new Event('input')); void document.body.offsetHeight; return Math.round((performance.now() - t) * 10) / 10;
    });
    await page.locator('.harness-list').getByText('element-0042.md', { exact: true }).waitFor();
    assert.equal(await page.locator('.harness-entry').count(), 1, 'the search across all categories finds the one element');
    await page.getByLabel('Search harness resources').fill('');
    await category(page, 'instructions').click();
    const groupHeads = await page.locator('.harness-group').allInnerTexts();
    assert.ok(groupHeads.some((g) => g.includes('a-group-folder-with-a-rather-long-name')), 'groups are the folders');
    const longShelf = page.locator('.harness-group', { hasText: 'a-group-folder-with-a-rather-long-name' });
    if ((await longShelf.getAttribute('aria-expanded')) !== 'true') await longShelf.click();
    await page.getByRole('button', { name: /an-element-with-a-very-long-file-name/ }).click();
    await page.getByRole('heading', { name: /an-element-with-a-very-long-file-name/ }).waitFor();
    await noSideways(page);
    await shot(page, 'editor-navigator-1200-desktop.png');
    // "Show more" pages through a big shelf.
    await category(page, 'commands').click();
    const before = await page.locator('.harness-entry').count();
    await page.locator('.harness-more').first().click();
    assert.ok(await page.locator('.harness-entry').count() > before, 'Show more adds the next page');
    timings.entriesRendered = before;
    await page.setViewportSize({ width: 390, height: 844 });
    await noSideways(page);
    await shot(page, 'editor-navigator-1200-mobile.png');
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── Bind an unbound floor, after a confirmation ──────────────────────────────────────────────────────
  {
    const { page, errors } = await open(1440, 900, 'loose');
    await page.getByRole('button', { name: 'Bind this floor to Opora Ample' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Confirm binding' });
    await confirm.getByText(/Bind floor loose-repo to Opora project Ample \(p-ample\), workspace w-ample\?/).waitFor();
    await shot(page, 'editor-bind-desktop.png');
    await confirm.getByRole('button', { name: 'Bind floor' }).click();
    await page.waitForFunction(() => !document.querySelector('.harness-spec select')?.disabled, null, { timeout: 10000 });
    const binding = await (await api.get('/api/harness/binding?floor=loose')).json();
    assert.deepEqual([binding.binding?.project, binding.binding?.workspace], ['p-ample', 'w-ample']);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── Phone: navigator, detail, draft and conflict at 390 px ───────────────────────────────────────────
  {
    const { page, errors } = await open(390, 844);
    await noSideways(page);
    await shot(page, 'editor-navigator-mobile.png');
    await category(page, 'rules').click();
    await page.getByRole('button', { name: /checklist\.md/ }).click();
    await page.getByRole('heading', { name: 'checklist.md', exact: true }).waitFor();
    await noSideways(page);
    await shot(page, 'editor-detail-mobile.png');
    await page.getByRole('button', { name: 'Assign to slot' }).click();
    await page.locator('.harness-cascade[open]').waitFor();
    await page.locator('.harness-draft').getByText(/rules\.checklist: inherit →/).waitFor();
    await noSideways(page);
    await shot(page, 'editor-draft-mobile.png');
    const now = await (await api.get('/api/harness/profile?floor=ample')).json();
    await save('ample', 'project', { ...now.layers.project, 'ample.voice': { value: 'phone race' } });
    await page.getByRole('button', { name: 'Save layer' }).click();
    await page.getByRole('alert').filter({ hasText: 'Not saved: the profile changed' }).waitFor();
    await noSideways(page);
    await shot(page, 'editor-conflict-mobile.png');
    await page.getByRole('button', { name: 'Reload (drop my draft)' }).click();
    assert.match(await page.locator('.harness-draft').innerText(), /No unsaved changes/);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('TIMINGS ' + JSON.stringify(timings));
  console.log('PASS: create in .harness, assign without JSON, save, received with revision and digest, reset, disable an inherited slot, save conflict with Keep editing and Reload, member read-only and 403, 1,250 elements by category and shelf with search, bind after confirmation, 1440 and 390 px.');
} finally {
  await browser.close();
  await api.dispose();
  child.stdin.end();
  child.kill();
  rmSync(home, { recursive: true, force: true });
}

// The library's context end to end (docs/harness.md "Choosing the context"): two floors bound to two Opora
// projects, Ample and Tajemství opory, with stub Opora canvases (tests/support/harness-context-office.ts,
// the real harness routes in a child process), through the visual lab on Vite.
//
// Run Vite on HARNESS_LAB_URL (default http://localhost:5197/lab/harness.html): `npx vite --port 5197`.
// Then `node tests/harness-context.browser.mjs`. Screenshots go to HARNESS_SHOTS (or the OS temp folder).
//
// Checks: Global lists only global elements and the global layer; a project only its own elements, layer
// and tree; a specialization is chosen from the real tree and only after a project; no slot, element or
// node name of one project ever shows in the other's view, after fast switching and after a slow reply
// of the project left behind arrives late (stale response); unsaved edits are guarded; the context is kept
// across close and reopen; the new controls are inside the focus trap; 390 px has no sideways scroll.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, request } from 'playwright-core';

const lab = process.env.HARNESS_LAB_URL ?? 'http://localhost:5197/lab/harness.html';
const shots = process.env.HARNESS_SHOTS ?? os.tmpdir();
const key = (project, workspace, id) => `opora:${project}:${workspace}:${id}`;
const AMPLE = { project: 'p-ample', workspace: 'w-ample' };
const TAJ = { project: 'p-tajemstvi', workspace: 'w-tajemstvi' };

// The office: a child process, stopped (and its data removed) when this script ends.
// Its home is an empty folder, so the machine's own skills folders stay out of the catalog (and the screenshots).
const home = mkdtempSync(path.join(os.tmpdir(), 'harness-context-home-'));
const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/harness-context-office.ts'], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, HOME: home, USERPROFILE: home } });
const base = await new Promise((resolve, reject) => {
  let out = '';
  child.stdout.on('data', (d) => { out += d; const m = /READY (\S+)/.exec(out); if (m) resolve(m[1]); });
  child.on('exit', (code) => reject(new Error('the office stopped: ' + code)));
});
const api = await request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
async function save(floor, scope, layer, node) {
  const url = '/api/harness/profile?' + new URLSearchParams({ floor, ...(node ? { node } : {}) });
  const read = await (await api.get(url)).json();
  const at = node ? read.path.find((p) => p.level === scope)?.node : undefined;
  const response = await api.post(url, { data: { scope, layer, revision: read.revision, ...(at ? { at } : {}) } });
  assert.equal(response.status(), 200, await response.text());
}
await save('ample', 'global', { 'house.style': { value: 'shared style' }, 'rules.start': { resource: 'guide:instructions' } });
await save('ample', 'project', { 'ample.voice': { value: 'Ample voice' } });
await save('tajemstvi', 'project', { 'tajemstvi.voice': { value: 'Tajemství hlas' } });
await save('ample', 'sector', { 'ample.sector': { value: 'Ample sector rule' } }, key(AMPLE.project, AMPLE.workspace, 'am-sector'));
await save('tajemstvi', 'task', { 'tajemstvi.task': { value: 'Tajemství task rule' } }, key(TAJ.project, TAJ.workspace, 'ta-task'));

const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
/** Replies held back on purpose: a matcher on the request URL and how long. */
const delays = [];
/** Every profile reply the page got, in the order it got them: [floor, node]. */
const delivered = [];
async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 700, isMobile: width < 700 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/harness**', async (route) => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    const response = await api.fetch(url.pathname + url.search, { method: incoming.method(), headers: { 'content-type': 'application/json' }, ...(incoming.postData() ? { data: incoming.postData() } : {}) });
    const body = await response.body();
    const wait = delays.find((d) => d.match(url))?.ms ?? 0;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (url.pathname.endsWith('/profile')) delivered.push([url.searchParams.get('floor'), url.searchParams.get('node') ?? '']);
    await route.fulfill({ status: response.status(), headers: response.headers(), body }).catch(() => {}); // an aborted request is gone
  });
  await page.goto(lab + '?floor=ample');
  await page.waitForFunction(() => window.__ready);
  await page.getByRole('button', { name: 'Open Harness', exact: true }).click();
  await page.getByRole('dialog', { name: 'Harness library' }).waitFor();
  return { page, errors };
}
const dialog = (page) => page.getByRole('dialog', { name: 'Harness library' });
const trail = (page) => page.locator('.harness-trail').innerText();
/** Everything a reader sees of the context, except the project picker (which names every floor on purpose). */
const viewText = (page) => page.evaluate(() => {
  const root = document.querySelector('.harness-window');
  const parts = [...root.querySelectorAll('.harness-trail, .harness-spec, .harness-context-notice, .harness-cascade, .harness-receives, .harness-list, .harness-reader')];
  return parts.map((p) => (p.matches('details') ? p.textContent + ' ' + [...p.querySelectorAll('textarea')].map((t) => t.value).join(' ') : p.textContent)).join('\n');
});
async function settled(page, text) {
  await page.waitForFunction((t) => document.querySelector('.harness-receives')?.textContent.includes(t), text, { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('.harness-list')?.getAttribute('aria-busy'));
}
function noLeak(text, foreign, where) {
  for (const word of foreign) assert.ok(!text.includes(word), `${where}: "${word}" of the other project leaked into this view`);
}
const AMPLE_WORDS = ['Ample', 'ample.voice', 'ample.sector', 'ample-rules.md', 'p-ample'];
const TAJ_WORDS = ['Tajemství', 'tajemstvi.voice', 'tajemstvi.task', 'tajemstvi-rules.md', 'p-tajemstvi'];
const shot = (page, name) => page.screenshot({ path: path.join(shots, name) });
async function openPanel(page, name, open = true) {
  const panel = page.locator(name === 'editor' ? '.harness-cascade' : '.harness-receives');
  if ((await panel.getAttribute('open')) !== null !== open) await panel.locator('> summary').click();
}
async function noSideways(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.harness-context').scrollWidth <= document.querySelector('.harness-context').clientWidth + 1), true, 'no sideways scroll');
}

try {
  for (const [width, height, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
    const { page, errors } = await open(width, height);
    // A first open lands on the project you're on.
    if (tag === 'desktop') {
      await settled(page, 'Ample voice');
      assert.equal(await trail(page), 'Project ample-shop');
      await page.locator('.harness-list').getByText('ample-rules.md', { exact: true }).waitFor();
      noLeak(await viewText(page), TAJ_WORDS, 'Ample project');
      assert.equal(await page.locator('.harness-list').getByText('Start here', { exact: true }).count(), 0, 'a global element is not one of the project\'s own');
    } else {
      // The context is remembered for the page's lifetime, not across pages: a fresh page starts on the floor's project.
      await settled(page, 'Ample voice');
    }
    await noSideways(page);

    // Global: global elements and the global layer only; a specialization (a task) can't be chosen.
    await page.getByRole('button', { name: 'Global', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.harness-trail')?.textContent === 'Global');
    await settled(page, 'shared style');
    const spec = page.locator('.harness-spec select');
    assert.equal(await spec.count(), 1);
    assert.equal(await spec.isDisabled(), true, 'no specialization without a project');
    assert.equal(await spec.innerText(), 'Choose a project first');
    assert.equal(await page.getByRole('combobox', { name: 'Project', exact: true }).isDisabled(), true);
    await page.locator('.harness-list').getByText('Start here').first().waitFor();
    const global = await viewText(page);
    noLeak(global, [...AMPLE_WORDS, ...TAJ_WORDS], 'Global');
    await noSideways(page);
    await shot(page, `harness-context-global-${tag}.png`);

    // Project Tajemství opory: its own layer, elements and tree; nothing of Ample.
    await page.getByRole('button', { name: 'Project', exact: true }).click();
    await settled(page, 'Ample voice');
    await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('tajemstvi');
    await settled(page, 'Tajemství hlas');
    assert.equal(await trail(page), 'Project tajemstvi-opory');
    await page.locator('.harness-list').getByText('tajemstvi-rules.md', { exact: true }).waitFor();
    await openPanel(page, 'editor');
    assert.match(await page.getByLabel('Harness layer JSON').inputValue(), /tajemstvi\.voice/);
    noLeak(await viewText(page), AMPLE_WORDS, 'Tajemství project');
    await noSideways(page);
    await shot(page, `harness-context-project-${tag}.png`);

    // A specialization from the real tree: page › layer › area › sector › task.
    for (const [label, option] of [['Specialization', 'Page: Tajemství page'], ['Specialization under Page Tajemství page', 'Layer: [vrstva 01] Tajemství layer'], ['Specialization under Layer [vrstva 01] Tajemství layer', 'Area: Tajemství area'], ['Specialization under Area Tajemství area', 'Sector: Tajemství sector'], ['Specialization under Sector Tajemství sector', 'Task: Tajemství task']]) {
      await page.getByRole('combobox', { name: label, exact: true }).selectOption({ label: option });
    }
    await settled(page, 'Tajemství task rule');
    assert.equal(await trail(page), 'Project tajemstvi-opory › Page Tajemství page › Layer [vrstva 01] Tajemství layer › Area Tajemství area › Sector Tajemství sector › Task Tajemství task');
    assert.match(await page.getByLabel('Harness layer JSON').inputValue(), /tajemstvi\.task/);
    assert.doesNotMatch(await page.getByLabel('Harness layer JSON').inputValue(), /tajemstvi\.voice/, 'the editor shows this level\'s own slots only');
    await openPanel(page, 'preview');
    const rows = await page.locator('.harness-receives-table tbody tr').allInnerTexts();
    assert.ok(rows.some((r) => /tajemstvi\.task\s+"Tajemství task rule"\s+Task\s+Tajemství task/.test(r)), 'a slot names its level and node: ' + rows.join(' | '));
    assert.ok(rows.some((r) => /tajemstvi\.voice\s+"Tajemství hlas"\s+Project\s+Project tajemstvi-opory/.test(r)), 'the project still inherits down');
    assert.ok(rows.some((r) => /house\.style\s+"shared style"\s+Global\s+Global/.test(r)), 'global is inherited, never switched off by the view');
    assert.match(await page.locator('.harness-digest').innerText(), /Manifest digest \(snapshot SHA-256\): [0-9a-f]{64}/);
    noLeak(await viewText(page), AMPLE_WORDS, 'Tajemství task');
    await noSideways(page);
    await shot(page, `harness-context-specialization-${tag}.png`);
    await openPanel(page, 'editor', false);
    await shot(page, `harness-context-preview-${tag}.png`);
    await openPanel(page, 'preview', false);

    // An unbound project: the project level only, with the reason; an unreachable one likewise.
    await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('loose');
    await page.locator('.harness-context-notice').getByText(/Not linked to an Opora project/).waitFor();
    assert.equal(await page.locator('.harness-spec select').isDisabled(), true);
    assert.equal(await page.locator('.harness-spec select').innerText(), 'Not linked: project level only');
    noLeak(await page.locator('.harness-spec').innerText(), ['Loose'], 'an unbound floor offers no tree');
    await noSideways(page);
    await shot(page, `harness-context-unbound-${tag}.png`);
    await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('dark');
    await page.locator('.harness-context-notice').getByText(/Opora isn't answering/).waitFor();
    assert.equal(await page.locator('.harness-spec select').isDisabled(), true);
    if (tag === 'mobile') { assert.deepEqual(errors, []); await page.close(); continue; }

    // Stale response: Ample's profile is held back; the user moves on to Tajemství before it arrives.
    const picker = page.getByRole('combobox', { name: 'Project', exact: true });
    delays.push({ match: (u) => u.pathname.endsWith('/profile') && u.searchParams.get('floor') === 'ample', ms: 1500 });
    const before = delivered.length;
    await picker.selectOption('ample');
    await picker.selectOption('tajemstvi');
    await settled(page, 'Tajemství hlas');
    await page.waitForFunction(() => true);
    await new Promise((r) => setTimeout(r, 1800));
    assert.ok(delivered.slice(before).some(([f]) => f === 'ample'), 'the held-back Ample reply came back after the switch');
    assert.equal(await trail(page), 'Project tajemstvi-opory');
    noLeak(await viewText(page), AMPLE_WORDS, 'after the late Ample reply');
    // Fast switching, every Ample reply late: the view always ends on the last choice, clean.
    for (let i = 0; i < 6; i++) { await picker.selectOption(i % 2 ? 'tajemstvi' : 'ample'); }
    await settled(page, 'Tajemství hlas');
    await new Promise((r) => setTimeout(r, 1800));
    noLeak(await viewText(page), AMPLE_WORDS, 'after fast switching');
    delays.length = 0;

    // Unsaved edits: switching asks; Keep editing stays with the edit, Discard switches.
    await openPanel(page, 'editor');
    const editor = page.getByLabel('Harness layer JSON');
    await editor.fill('{ "tajemstvi.voice": { "value": "unsaved" } }');
    await page.getByRole('button', { name: 'Global', exact: true }).click();
    await page.getByRole('alert').getByText(/Unsaved changes to Project tajemstvi-opory would be lost/).waitFor();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    assert.equal(await trail(page), 'Project tajemstvi-opory');
    assert.match(await editor.inputValue(), /unsaved/);
    await page.getByRole('button', { name: 'Global', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes and switch' }).click();
    await settled(page, 'shared style');
    assert.equal(await trail(page), 'Global');

    // The new controls are inside the focus trap: Tab reaches the segmented control and never leaves the window.
    const seen = new Set();
    await page.getByRole('button', { name: 'Global', exact: true }).focus();
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => !!document.activeElement?.closest('.harness-window'));
      assert.ok(inside, 'focus stays in the library');
      seen.add(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim()));
    }
    assert.ok(seen.has('Global') && seen.has('Project'), 'the segmented control is reachable by Tab');

    // Closed and reopened, the library comes back to the context it was in; Esc closes it.
    await page.getByRole('combobox', { name: 'Project', exact: true }).isDisabled();
    await page.getByRole('button', { name: 'Project', exact: true }).click();
    await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('tajemstvi');
    await page.getByRole('combobox', { name: 'Specialization', exact: true }).selectOption({ label: 'Page: Tajemství page' });
    await page.waitForFunction(() => document.querySelector('.harness-trail')?.textContent.endsWith('Page Tajemství page'));
    await page.keyboard.press('Escape');
    assert.equal(await dialog(page).count(), 0);
    await page.getByRole('button', { name: 'Open Harness', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.harness-trail')?.textContent === 'Project tajemstvi-opory › Page Tajemství page');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await dialog(page).count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS: Global/Project/specialization views, two projects without leaks (also after fast switching and a late reply), unbound and unreachable projects, unsaved-edit guard, focus trap, reopen, 1440 and 390 px.');
} finally {
  await browser.close();
  await api.dispose();
  child.stdin.end();
  child.kill();
  rmSync(home, { recursive: true, force: true });
}

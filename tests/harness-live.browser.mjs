// Real running office API (no mocked catalog/settings), rendered through the visual lab.
// Run the office (HARNESS_OFFICE_URL, default http://127.0.0.1:4617, password HARNESS_PASSWORD) and Vite on
// HARNESS_LAB_URL (default http://127.0.0.1:5187/lab/harness.html). HARNESS_FLOOR picks the floor (default:
// the office's first). Saves the project and global layers through the context bar, checks inheritance and
// "What the worker receives", reopens, and restores the layers unless someone edited them concurrently.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chromium, request } from 'playwright-core';
const base = process.env.HARNESS_OFFICE_URL ?? 'http://127.0.0.1:4617';
const api = await request.newContext({ baseURL: base });
assert.equal((await api.post('/api/login', { data: { password: process.env.HARNESS_PASSWORD ?? 'harness-preview' } })).status(), 200);
const floor = process.env.HARNESS_FLOOR ?? (await (await api.get('/api/harness/projects')).json()).projects[0].floor;
const endpoint = '/api/harness/profile?' + new URLSearchParams({ floor });
const before = await (await api.get(endpoint)).json();
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
let revision = before.revision;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/harness**', async (route) => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    const response = await api.fetch(url.pathname + url.search, { method: incoming.method(), headers: { origin: base, 'content-type': 'application/json' }, ...(incoming.postData() ? { data: incoming.postData() } : {}) });
    await route.fulfill({ response });
  });
  await page.goto((process.env.HARNESS_LAB_URL ?? 'http://127.0.0.1:5187/lab/harness.html') + '?floor=' + encodeURIComponent(floor));
  await page.waitForFunction(() => window.__ready);
  await page.getByRole('button', { name: 'Open Harness', exact: true }).click();
  await page.getByRole('dialog', { name: 'Harness library' }).waitFor();
  const editor = page.getByLabel('Harness layer JSON');
  await page.locator('.harness-cascade > summary').click();
  await page.getByText(new RegExp('[Rr]evision ' + revision + '\\.')).waitFor();
  assert.match(await page.locator('.harness-trail').innerText(), /^Project /, 'a first open is on the floor\'s project');
  for (const [scope, color] of [['project', 'blue'], ['global', 'red']]) {
    if (scope === 'global') {
      await page.getByRole('button', { name: 'Global', exact: true }).click();
      await page.getByText(new RegExp('[Rr]evision ' + revision + '\\.')).waitFor();
    }
    const layer = { ...before.layers[scope], 'qa.color': { value: color } };
    if (scope === 'global') layer['qa.instructions'] = { resource: 'guide:instructions' };
    await editor.fill(JSON.stringify(layer, null, 2));
    await page.getByRole('button', { name: 'Save layer' }).click();
    await page.getByText(new RegExp('[Rr]evision ' + (++revision) + '\\.')).waitFor();
  }
  const resolved = await (await api.get(endpoint)).json();
  assert.deepEqual(resolved.effective['qa.color'], { binding: { value: 'blue' }, scope: 'project' }, 'the project overrides Global');
  assert.equal(resolved.effective['qa.instructions'].scope, 'global');
  assert.match(resolved.preview, /Start here/);
  // Back on the project: what its workers receive, with the origin of each slot.
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.locator('.harness-receives > summary').click();
  await page.locator('.harness-receives-table').getByText('qa.color').waitFor();
  const row = await page.locator('.harness-receives-table tr', { hasText: 'qa.color' }).innerText();
  assert.match(row, /"blue"\s+Project/);
  assert.match(await page.locator('.harness-digest').innerText(), /Manifest digest \(snapshot SHA-256\): [0-9a-f]{64}/);
  await page.screenshot({ path: path.join(process.env.HARNESS_SHOTS ?? os.tmpdir(), 'harness-cascade.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByRole('button', { name: 'Open Harness', exact: true }).click();
  await page.locator('.harness-cascade > summary').click();
  await page.getByText(new RegExp('[Rr]evision ' + revision + '\\.')).waitFor();
  assert.match(await editor.inputValue(), /blue/, 'reopened on the project it was left on');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(process.env.HARNESS_SHOTS ?? os.tmpdir(), 'harness-cascade-mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS: real authenticated API, project and global layers through the context bar, inheritance, what the worker receives, reopen, responsive screenshot.');
} finally {
  // Restore only if no one edited concurrently; never overwrite a user's newer revision.
  for (const scope of ['project', 'global']) {
    const response = await api.post(endpoint, { headers: { origin: base }, data: { scope, revision, layer: before.layers[scope] } });
    if (!response.ok()) { console.error('Restore stopped: profiles changed concurrently.'); break; }
    revision = (await response.json()).revision;
  }
  await browser.close();
  await api.dispose();
}

// Real running office API (no mocked catalog/settings), rendered through the visual lab.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chromium, request } from 'playwright-core';
const base = process.env.HARNESS_OFFICE_URL ?? 'http://127.0.0.1:4617';
const floor = process.env.HARNESS_FLOOR ?? 'harness-library';
const api = await request.newContext({ baseURL: base });
assert.equal((await api.post('/api/login', { data: { password: process.env.HARNESS_PASSWORD ?? 'harness-preview' } })).status(), 200);
const endpoint = '/api/harness/profile?' + new URLSearchParams({ floor, task: 'qa:cascade' });
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
  await page.getByRole('navigation').getByRole('button', { name: 'Equipment' }).click();
  await page.getByText('Advanced layer JSON', { exact: true }).click();
  await page.getByText(new RegExp('Revision ' + revision + '\\.')).waitFor();
  await page.getByLabel('Harness task', { exact: true }).fill('qa:cascade');
  await page.getByRole('button', { name: 'Load task / reload' }).click();
  await page.waitForResponse((r) => r.url().includes('/profile') && r.request().method() === 'GET');
  for (const [scope, color] of [['global', 'red'], ['repository', 'blue'], ['task', 'green']]) {
    await page.getByLabel('Harness scope').selectOption(scope);
    const layer = { ...before.layers[scope], 'qa.color': { value: color } };
    if (scope === 'global') layer['qa.instructions'] = { resource: 'guide:instructions' };
    await page.getByLabel('Harness layer JSON').fill(JSON.stringify(layer, null, 2));
    await page.getByRole('button', { name: 'Save layer' }).click();
    await page.getByText(new RegExp('Revision ' + (++revision) + '\\.')).waitFor();
  }
  const resolved = await (await api.get(endpoint)).json();
  assert.deepEqual(resolved.effective['qa.color'], { binding: { value: 'green' }, scope: 'task' });
  assert.equal(resolved.effective['qa.instructions'].scope, 'global');
  assert.match(resolved.preview, /Start here/);
  await page.getByText('Effective slots and their origins', { exact: true }).click();
  await page.screenshot({ path: path.join(process.env.HARNESS_SHOTS ?? os.tmpdir(), 'harness-cascade.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByRole('button', { name: 'Open Harness', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Equipment' }).click();
  await page.getByText(new RegExp('Revision ' + revision + '\\.')).waitFor();
  assert.match(await page.getByLabel('Harness layer JSON').inputValue(), /blue/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(process.env.HARNESS_SHOTS ?? os.tmpdir(), 'harness-cascade-mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS: real authenticated API, 3-level persistence/inheritance, handoff preview, reopen, responsive screenshot.');
} finally {
  // Restore only if no one edited concurrently; never overwrite a user's newer revision.
  for (const scope of ['task', 'repository', 'global']) {
    const response = await api.post(endpoint, { headers: { origin: base }, data: { scope, revision, layer: before.layers[scope] } });
    if (!response.ok()) { console.error('Restore stopped: profiles changed concurrently.'); break; }
    revision = (await response.json()).revision;
  }
  await browser.close();
  await api.dispose();
}

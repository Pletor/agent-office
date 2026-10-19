// Run with a Vite server on HARNESS_LAB_URL (default localhost:5187).
// Uses the real catalog and reader; screenshots go to HARNESS_SHOTS or the OS temp folder.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { HarnessLibrary, harnessSources } from '../dist/server/server/harness/catalog.js';
const library = new HarnessLibrary(harnessSources(process.cwd(), true));
const catalog = await library.list();
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/harness**', async (route) => {
    const url = new URL(route.request().url());
    const data = url.pathname.endsWith('/file') ? await library.read(url.searchParams.get('id')) : catalog;
    await route.fulfill({ status: data ? 200 : 404, contentType: 'application/json', body: JSON.stringify(data ?? { error: 'Not found' }) });
  });
  await page.goto(process.env.HARNESS_LAB_URL ?? 'http://localhost:5187/lab/harness.html');
  await page.waitForFunction(() => window.__ready);
  const shots = process.env.HARNESS_SHOTS ?? os.tmpdir();
  await page.screenshot({ path: path.join(shots, 'harness-shelves.png') });
  await page.getByRole('button', { name: 'Open Harness', exact: true }).click();
  await page.getByRole('heading', { name: 'Start here', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add to pack', exact: true }).click();
  await page.getByLabel('Resource category').selectOption('memory');
  await page.getByLabel('Resource source').selectOption('Harness handbook');
  await page.getByRole('button', { name: /OpenViking: recall and persist/ }).click();
  await page.getByRole('heading', { name: 'OpenViking: recall and persist' }).waitFor();
  await page.getByRole('button', { name: 'Add to pack', exact: true }).click();
  await page.screenshot({ path: path.join(shots, 'harness-library.png') });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download pack' }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  let pack = '';
  for await (const chunk of stream) pack += chunk.toString();
  assert.match(pack, /# Harness context pack/);
  assert.match(pack, /OpenViking: recall and persist/);
  assert.match(pack, /Source: Harness handbook/);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByRole('button', { name: 'Open Harness', exact: true }).click();
  await page.getByRole('heading', { name: 'Start here', exact: true }).waitFor();
  await page.getByLabel('Search harness resources').fill('no-match-6f973');
  await page.getByText('No matching resources.', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(shots, 'harness-mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: real office geometry, catalog, filters, selection, pack download, Esc/close and mobile layout');
} finally { await browser.close(); }

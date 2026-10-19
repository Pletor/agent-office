// Production bundle + actual office session: keyboard entry and modal focus restoration.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
const base = process.env.HARNESS_OFFICE_URL ?? 'http://127.0.0.1:4617';
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  assert.equal((await context.request.post(base + '/api/login', { data: { password: process.env.HARNESS_PASSWORD ?? 'harness-preview' } })).status(), 200);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(e.message));
  await page.goto(base + '/?3d');
  await page.getByRole('button', { name: 'Enter the office', exact: false }).click({ timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.keyboard.press('F8');
  await page.getByRole('dialog', { name: 'Harness library' }).waitFor();
  await page.getByRole('heading', { name: 'Start here', exact: true }).waitFor();
  await page.screenshot({ path: path.join(process.env.HARNESS_SHOTS ?? os.tmpdir(), 'harness-office.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForFunction(() => !!document.pointerLockElement);
  await page.keyboard.press('F8');
  await page.getByRole('dialog', { name: 'Harness library' }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !!document.pointerLockElement);
  assert.equal(await page.getByRole('dialog').count(), 0);
  console.log('PASS: production office, F8 library, real catalog, X and Escape restore mouse-look without another click.');
} finally { await browser.close(); }

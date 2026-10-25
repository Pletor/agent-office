// Production bundle + actual office session: keyboard entry (F8 and E at the shelf) and modal focus restoration.
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
  const search = page.getByRole('searchbox', { name: 'Search harness resources' });
  page.on('pageerror', (e) => console.error(e.message));
  await page.goto(base + '/?3d');
  await page.getByRole('button', { name: 'Enter the office', exact: false }).click({ timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.keyboard.press('F8');
  await page.getByRole('dialog', { name: 'Harness library' }).waitFor();
  await page.getByRole('navigation').getByRole('button', { name: 'Resources' }).click();
  await page.getByRole('heading', { name: 'Start here', exact: true }).waitFor();
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)));
  const box = await page.getByRole('dialog').boundingBox();
  assert.deepEqual([box.x, box.y, Math.round(box.width), Math.round(box.height)], [0, 0, 1440, 900], 'the library covers the whole browser');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Search harness resources', 'search has focus');
  assert.equal(await search.inputValue(), '', 'F8 opens with an empty search');
  await page.screenshot({ path: path.join(process.env.HARNESS_SHOTS ?? os.tmpdir(), 'harness-office.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForFunction(() => !!document.pointerLockElement);
  await page.keyboard.press('F8');
  await page.getByRole('dialog', { name: 'Harness library' }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !!document.pointerLockElement);
  assert.equal(await page.getByRole('dialog').count(), 0);
  // E at the shelf: the key that opens the library must not end up in its search.
  const atShelf = () => page.evaluate(() => {
    const o = window.__office, it = o.office.interactables.find((i) => i.kind === 'harness'), p = o.player;
    p.pos.set(it.x, 0, it.z - 1.4); p.camYaw = Math.PI; p.lookPitch = 0;
  });
  for (const close of ['Escape', 'Close']) {
    await atShelf();
    await page.waitForTimeout(700);
    await page.keyboard.press('KeyE');
    await page.getByRole('dialog', { name: 'Harness library' }).waitFor();
    await page.getByRole('navigation').getByRole('button', { name: 'Resources' }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Search harness resources');
    assert.equal(await search.inputValue(), '', 'E opens with an empty search');
    await page.keyboard.type('hooks');
    assert.equal(await search.inputValue(), 'hooks');
    await page.locator('.harness-entry', { hasText: 'Hooks and lifecycle' }).first().waitFor();
    if (close === 'Escape') await page.keyboard.press('Escape');
    else await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForFunction(() => !!document.pointerLockElement);
    assert.equal(await page.getByRole('dialog').count(), 0);
  }
  console.log('PASS: production office, F8 and E at the shelf open the full-screen library with an empty search in focus, typing finds Hooks and lifecycle, X and Escape restore mouse-look without another click.');
} finally { await browser.close(); }

// Run with a Vite server on HARNESS_LAB_URL (default localhost:5187), after `npm run build`.
// The full-screen library in every state, at desktop (1440×900) and phone (390×844) widths:
// screenshots go to HARNESS_SHOTS or the OS temp folder.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { HarnessLibrary, harnessSources } from '../dist/server/server/harness/catalog.js';
const library = new HarnessLibrary(harnessSources(process.cwd(), true));
const catalog = await library.list();
const lab = process.env.HARNESS_LAB_URL ?? 'http://localhost:5187/lab/harness.html';
const shots = process.env.HARNESS_SHOTS ?? os.tmpdir();
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
const long = { id: 'guide:long', title: 'A resource with a very long title that keeps going well past the width of a phone screen without any breaks', category: 'instructions', source: 'Harness handbook', path: 'a/very/deeply/nested/path/that/also/keeps/going/and/going/without/a/single/space/README.md' };

/** A page whose /api/harness answers as `mode` says: real, slow (never answers), failing, or empty. */
async function open(width, height, mode = 'real', reduced = false) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: reduced ? 'reduce' : 'no-preference', hasTouch: width < 700, isMobile: width < 700 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/harness**', async (route) => {
    const url = new URL(route.request().url());
    const file = url.pathname.endsWith('/file');
    if (mode === 'slow') return;
    if (mode === 'error') return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    if (mode === 'empty') return route.fulfill({ status: file ? 404 : 200, contentType: 'application/json', body: JSON.stringify(file ? {} : { ...catalog, entries: [] }) });
    if (file && url.searchParams.get('id') === 'guide:broken') return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    if (file && url.searchParams.get('id') === 'guide:long') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...long, text: 'word '.repeat(4000) + 'x'.repeat(600) }) });
    const data = file ? await library.read(url.searchParams.get('id')) : { ...catalog, entries: [...catalog.entries, long, { ...long, id: 'guide:broken', title: 'Broken resource' }] };
    await route.fulfill({ status: data ? 200 : 404, contentType: 'application/json', body: JSON.stringify(data ?? { error: 'Not found' }) });
  });
  // On Global: the handbook's elements are Global's (a project lists its own, see tests/harness-context.browser.mjs).
  await page.goto(lab + '?context=global');
  await page.waitForFunction(() => window.__ready);
  await page.getByRole('button', { name: 'Open Harness', exact: true }).click();
  await page.getByRole('dialog', { name: 'Harness library' }).waitFor();
  return { page, errors };
}
async function fillsTheScreen(page) {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)));
  const box = await page.getByRole('dialog').boundingBox();
  const view = page.viewportSize();
  assert.deepEqual([box.x, box.y, Math.round(box.width), Math.round(box.height)], [0, 0, view.width, view.height], 'the library covers the whole browser');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
  const x = await page.getByRole('button', { name: 'Close', exact: true }).boundingBox();
  assert.ok(x.x + x.width > view.width - 40 && x.y < 40 && x.width >= 44, '✕ is a full-size target in the top-right corner');
}
/** The reader's Try again shows only when a read failed. */
const retryShown = (page) => page.locator('.harness-reader .harness-retry').isVisible();
const shot = (page, name) => page.screenshot({ path: path.join(shots, name) });

try {
  for (const [width, height, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
    const { page, errors } = await open(width, height);
    await (tag === 'mobile' ? page.getByRole('button', { name: /Start here/ }) : page.getByRole('heading', { name: 'Start here', exact: true })).waitFor();
    await fillsTheScreen(page);
    if (tag === 'desktop') {
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Search harness resources', 'search has focus on open');
      // Tab never leaves the window, either way round.
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press(i % 3 ? 'Tab' : 'Shift+Tab');
        assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), true, 'focus stays in the library');
      }
      await page.getByRole('button', { name: /Start here/ }).focus();
      await page.keyboard.press('ArrowDown');
      // The next element of the category's shelves (the navigator lists one category at a time).
      const next = await page.evaluate(() => document.activeElement?.querySelector('strong')?.textContent);
      assert.ok(next && next !== 'Start here', 'ArrowDown moves to the next element');
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: next, exact: true }).waitFor();
      await page.locator('.harness-text:not([aria-busy])').waitFor();
      assert.equal(await retryShown(page), false, 'no Try again after a successful read');
      await page.keyboard.press('/');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Search harness resources', '/ jumps to search');
      await shot(page, 'harness-full-desktop.png');
    } else {
      assert.equal(await page.locator('.harness-reader').isVisible(), false, 'a phone starts on the list');
      await shot(page, 'harness-full-mobile-list.png');
      await page.getByRole('button', { name: /Start here/ }).click();
      await page.getByRole('button', { name: '← Resources' }).waitFor();
      assert.equal(await page.locator('.harness-body > aside').isVisible(), false, 'the reader takes the screen');
      await fillsTheScreen(page);
      await page.locator('.harness-text:not([aria-busy])').waitFor();
      assert.equal(await retryShown(page), false, 'no Try again after a successful read');
      await shot(page, 'harness-full-mobile-reader.png');
      await page.getByRole('button', { name: '← Resources' }).click();
      await page.getByRole('button', { name: /Start here/ }).waitFor();
    }
    // A resource that fails to read offers Try again, and only then.
    await page.getByLabel('Search harness resources').fill('Broken resource');
    await page.getByRole('button', { name: /Broken resource/ }).click();
    await page.getByRole('heading', { name: 'Unable to read' }).waitFor();
    assert.equal(await retryShown(page), true, 'Try again after a failed read');
    await shot(page, `harness-read-error-${tag}.png`);
    if (tag === 'mobile') await page.getByRole('button', { name: '← Resources' }).click();
    // Long titles, paths and unbroken text wrap rather than push the page sideways.
    await page.getByLabel('Search harness resources').fill('very long title');
    await page.getByRole('button', { name: /very long title/ }).click();
    await page.getByRole('heading', { name: /very long title/ }).waitFor();
    assert.equal(await retryShown(page), false, 'a new read hides Try again');
    await page.locator('.harness-text:not([aria-busy])').waitFor();
    await fillsTheScreen(page);
    await shot(page, `harness-long-${tag}.png`);
    // No matches, with a way back.
    if (tag === 'mobile') await page.getByRole('button', { name: '← Resources' }).click();
    await page.getByLabel('Search harness resources').fill('no-match-6f973');
    await page.getByText('No matching resources.', { exact: true }).waitFor();
    await shot(page, `harness-nomatch-${tag}.png`);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    assert.equal(await page.getByLabel('Search harness resources').inputValue(), '');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    if (tag === 'desktop') assert.equal(await page.evaluate(() => document.activeElement?.id), 'open-harness', 'focus goes back where it was');
    assert.deepEqual(errors, []);
    await page.close();

    for (const mode of ['slow', 'error', 'empty']) {
      const { page, errors } = await open(width, height, mode, true);
      if (mode === 'slow') await page.locator('.harness-skeleton').first().waitFor();
      if (mode !== 'error') assert.equal(await retryShown(page), false, 'no reader Try again while loading or empty');
      if (mode === 'error') await page.getByRole('button', { name: 'Try again' }).first().waitFor();
      if (mode === 'empty') await page.getByText(/No resources published yet/).waitFor();
      await fillsTheScreen(page);
      await shot(page, `harness-${mode === 'slow' ? 'loading' : mode}-${tag}.png`);
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  console.log('PASS: full-screen library at 1440 and 390 px, ✕ top-right, focus trap and return, ↑/↓ and / keys, phone panes, long content, loading/error/empty/no-match, no overflow');
} finally { await browser.close(); }

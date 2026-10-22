// Run against an isolated production preview. Uses the real generals.io website.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const base = process.env.GENERALS_OFFICE_URL ?? 'http://127.0.0.1:4659';
const shots = process.env.GENERALS_SHOTS ?? 'generals-shots';
await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  assert.equal((await context.request.post(base + '/api/login', { data: { password: 'generals-preview' } })).status(), 200);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.goto(base + '/?3d');
  await page.getByRole('button', { name: /Enter the office/ }).click();
  await page.waitForFunction(() => window.__office?.store.floor);
  await page.keyboard.press('j');
  assert.equal(await page.locator('.generals').count(), 0, 'unavailable away from the PC');
  // Place the player at the actual chair; E still goes through the office interaction registry.
  await page.evaluate(() => {
    const o = window.__office, s = o.plan().seatingById.get('boss-chair');
    o.player.setView('first');
    o.player.pos.set(s.x, s.y, s.z + 1.2);
    o.player.vy = 0; o.player.camYaw = 0; o.player.lookPitch = -.7;
  });
  await page.waitForTimeout(1000);
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__office.player.seat?.seatId === 'boss-chair');
  for (const width of [1440, 800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(() => {
      const launcher = document.querySelector('.generals-launch'), hint = document.getElementById('hint');
      return launcher.getBoundingClientRect().bottom + 10 <= hint.getBoundingClientRect().top;
    });
    const layout = await page.evaluate(() => {
      const launcher = document.querySelector('.generals-launch');
      const key = launcher.querySelector('kbd').getBoundingClientRect(), label = launcher.querySelector('span').getBoundingClientRect();
      return { fits: launcher.scrollWidth <= launcher.clientWidth, separated: key.right < label.left, hint: document.getElementById('hint').textContent };
    });
    assert.ok(layout.fits && layout.separated, `J and label fit at ${width}px`);
    assert.doesNotMatch(layout.hint, /W A S D|Get up/);
    await page.screenshot({ path: `${shots}/boss-pc-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${shots}/boss-pc.png` });
  await page.keyboard.press('j');
  const game = page.frameLocator('iframe[title="generals.io online game"]');
  await game.locator('body').waitFor();
  await page.waitForTimeout(5000);
  const body = await game.locator('body').innerText();
  assert.match(body, /generals|Play|FFA|1v1/i, 'real online lobby loaded');
  console.log('Live game text:', body.slice(0, 500));
  await page.screenshot({ path: `${shots}/generals-window.png` });
  await page.getByRole('button', { name: /Full screen/ }).click();
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('generals'));
  await page.screenshot({ path: `${shots}/generals-fullscreen.png` });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.generals') && !!document.pointerLockElement);
  await page.keyboard.press('j');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.generals') && !!document.pointerLockElement);
  await page.keyboard.press('j');
  await page.getByRole('button', { name: /Full screen/ }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  // Same fullscreenchange path as the browser's native Esc (not a synthetic DOM key).
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.querySelector('.generals'));
  await page.keyboard.press('j');
  await page.evaluate(() => { document.querySelector('.generals').requestFullscreen = () => Promise.reject(new Error('denied')); });
  await page.getByRole('button', { name: /Full screen/ }).click();
  await page.waitForFunction(() => !!document.querySelector('.generals-expanded'));
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.generals') && !!document.pointerLockElement);
  console.log('PASS: real Boss chair/E, J gating, live iframe, fullscreen, close and toolbar Escape restore mouse-look');
} finally { await browser.close(); }

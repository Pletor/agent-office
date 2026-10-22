import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const base = process.env.GENERALS_OFFICE_URL ?? 'http://127.0.0.1:4661';
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
await mkdir('generals-shots', { recursive: true });
try {
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    assert.equal((await context.request.post(base + '/api/login', { data: { password: 'generals-preview' } })).status(), 200);
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(base + '/?3d');
    await page.getByRole('button', { name: /Enter the office/ }).click();
    await page.waitForFunction(() => window.__office?.store.floor);
    await page.evaluate(() => {
      const o = window.__office, s = o.plan().seatingById.get('boss-chair');
      o.player.setView('first'); o.player.pos.set(s.x, s.y, s.z + 1.2);
      o.player.vy = 0; o.player.camYaw = 0; o.player.lookPitch = -.7;
    });
    await page.waitForTimeout(1000);
    if (i === 0) {
      await page.keyboard.press('e');
      await page.waitForFunction(() => window.__office.player.seat?.seatId === 'boss-chair');
    }
    pages.push(page);
  }
  const [first, second] = pages;
  await second.waitForFunction(() => [...window.__office.store.peers.values()].some(p => p.id !== window.__office.store.you && p.seat === 'boss-chair:0'));
  assert.equal(await second.evaluate(() => !!window.__office.player.seat), false, 'visitor stays standing beside the occupied chair');
  await second.evaluate(() => {
    const o = window.__office, s = o.plan().seatingById.get('boss-chair');
    o.player.pos.set(s.x + 1.8, s.y, s.z + 1.2); o.player.vy = 0;
    o.player.camYaw = Math.PI / 6; o.player.lookPitch = -.12;
  });
  await second.locator('.boss-pc-launcher:not(.hidden)').waitFor();
  await second.waitForTimeout(200);
  await second.screenshot({ path: 'generals-shots/second-visitor-pc.png' });
  for (const page of pages) {
    await page.keyboard.press('j');
    await page.frameLocator('.generals iframe').getByText('Protect your general. Capture enemy generals.').waitFor({ state: 'attached' });
  }
  assert.equal(await first.locator('.generals').count(), 1);
  assert.equal(await second.locator('.generals').count(), 1);
  await second.screenshot({ path: 'generals-shots/second-visitor-game.png' });
  await first.locator('.generals .close').click();
  assert.equal(await second.locator('.generals').count(), 1, 'one visitor closing leaves the other game intact');
  // Deliberately disconnected Opora fixture avoids touching a real project or starting a service.
  await first.evaluate(() => { window.__office.store.opora.connected = false; });
  await first.keyboard.press('o');
  await first.locator('.opora-window').waitFor();
  assert.equal(await second.locator('.generals').count(), 1, 'work and play coexist');
  await second.locator('.generals .close').click();
  await second.evaluate(() => { window.__office.store.opora.connected = false; });
  await second.keyboard.press('o');
  await second.locator('.opora-window').waitFor();
  assert.equal(await first.locator('.opora-window').count(), 1, 'both can open their own workstation');
  await second.locator('.opora-window .close').click();
  await second.evaluate(() => {
    const o = window.__office, s = o.plan().seatingById.get('boss-chair');
    o.player.pos.set(s.x, 0, s.z); o.player.vy = 0;
  });
  await second.waitForFunction(() => document.querySelector('.boss-pc-launcher').classList.contains('hidden'));
  await second.keyboard.press('j');
  assert.equal(await second.locator('.generals').count(), 0, 'not accessible from downstairs');
  console.log('PASS: two real clients; occupied chair; concurrent games; independent closing; work/play and work/work; downstairs excluded. No external match joined.');
} finally { await browser.close(); }

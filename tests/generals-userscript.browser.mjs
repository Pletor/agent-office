import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const script = await readFile(new URL('../src/client/public/userscripts/generals-hide-ads.user.js', import.meta.url), 'utf8');
const slots = ['replay-ad-container', 'custom-queue-ad-top', 'custom-queue-ad', 'custom-queue-ad-skyscraper', 'custom-queue-ad-skyscraper-2', 'custom-queue-bottom-ad', 'div-gpt-ad-1521176753598-0'];
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
await mkdir('generals-shots', { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.route('https://office.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>Userscript test — synthetic ad slots in a separate-origin iframe</h1><iframe style="width:95%;height:600px" src="https://generals.io/__office_fixture"></iframe>' }));
  await page.route('https://generals.io/__office_fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<h2>Fixture game controls (not a real match)</h2><div id="custom-queue-content" style="padding:0 300px"><button id="leaderboard">Leaderboard</button><input placeholder="Game input"></div>${slots.map(id => `<div id="${id}" style="background:orange;padding:20px">Fixture ad: ${id}</div>`).join('')}` }));
  await page.goto('https://office.test/');
  const frame = page.frames().find(frame => frame.url().includes('__office_fixture'));
  assert.ok(frame);
  await frame.locator('#leaderboard').waitFor();
  assert.equal(await frame.locator('#custom-queue-ad').isVisible(), true);
  // Emulates execution by a userscript manager in the matching frame, not by the office.
  await frame.evaluate(script);
  for (const id of slots) assert.equal(await frame.locator(`#${id}`).isVisible(), false, id);
  await frame.locator('input').fill('Keyboard still works');
  assert.equal(await frame.locator('input').inputValue(), 'Keyboard still works');
  assert.equal(await frame.locator('#leaderboard').isVisible(), true);
  assert.equal(await frame.locator('#custom-queue-content').evaluate(el => getComputedStyle(el).paddingRight), '0px');
  await frame.evaluate(() => {
    const slot = document.createElement('div'); slot.id = 'div-gpt-ad-late'; slot.textContent = 'Late ad fixture'; document.body.append(slot);
  });
  assert.equal(await frame.locator('#div-gpt-ad-late').isVisible(), false);
  await frame.evaluate(script);
  assert.equal(await frame.locator('#office-generals-hide-ads').count(), 1);
  await page.evaluate(script);
  assert.equal(await page.locator('#office-generals-hide-ads').count(), 0, 'does not run on the office origin');
  await page.screenshot({ path: 'generals-shots/userscript-fixture.png' });
  await page.goto('https://generals.io/');
  await page.waitForTimeout(5000);
  await page.evaluate(script);
  assert.match(await page.locator('body').innerText(), /Protect your general/);
  assert.equal(await page.locator('#office-generals-hide-ads').count(), 1);
  await page.screenshot({ path: 'generals-shots/userscript-live.png' });
  console.log('PASS: separate-origin frame, all verified slots, dynamic insertion, game input, origin guard, idempotence, live-page compatibility. Manager installation not automated.');
} finally { await browser.close(); }

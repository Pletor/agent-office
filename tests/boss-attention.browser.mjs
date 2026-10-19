// Against an isolated production preview only. All card states below are UI fixtures, not real tasks.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

const base = process.env.BOSS_OFFICE_URL ?? 'http://127.0.0.1:4647';
const shots = process.env.BOSS_SHOTS ?? path.join(os.tmpdir(), 'boss-attention-shots');
await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
const empty = { project: { id: 'demo', name: 'Ukázka — Harness' }, workspace: { id: 'work', label: 'Pracovní prostor · UI fixture' },
  checkedAt: Date.now(), scope: 'linked-workspace', status: 'ready', items: [], system: [] };
const fixture = { ...empty, items: [{ id: 'ask', nodeId: 'task', kind: 'question', title: 'Potvrdit rozsah pilotního ověření',
  path: ['Ukázka — Harness', 'Pracovní prostor', 'Knihovna Harness', 'Vrstva 06', 'Pilotní ověření', 'Srovnání režimů'],
  reason: 'Má pilot běžet také na projektu Ample, nebo zatím pouze na agent-office?',
  action: 'Otevři kartu, doplň výběr projektu a odpověz na otázku.',
  guidance: { owner: 'Ty — rozhodnutí', activity: 'Čeká na tvoji odpověď', blockers: [],
    steps: ['Otevři kartu a rozklikni blok pilotního ověření.', 'Do Text bloku doplň vybraný projekt a ulož odpověď.', 'Po uložení se vrať a obnov seznam.'],
    expected: 'Položka zmizí až po vyřešení požadavku v Opoře.', linkLabel: 'Otevřít kartu a odpovědět v Opoře' },
  url: 'http://127.0.0.1:8740/?project=demo&workspace=work&screen=canvas&environment=editor&mode=structure&layer=pilot&node=task' }],
  system: [{ id: 'premature', nodeId: 'h05', kind: 'system', title: 'H05 — Celoobrazovková knihovna',
    path: ['Ukázka — Harness', 'Vrstva 02', 'Navigace a kontext'], reason: 'Návrh dokončení je předčasný: pipeline má hotové 2 ze 6 etap.',
    action: 'Nejde o tvé schválení. Agent musí dokončit kritiky a testovací etapu.',
    guidance: { owner: 'Orchestrátor / agenti', activity: 'Není doložen aktivní běh na této kartě. Tabule opravu nezadala.',
      steps: [], blockers: ['Nedokončené etapy: tři kritici a testy.', 'Review: chybí doklad.', 'Merge: chybí doklad.'],
      expected: 'Převzetí se nabídne až po doplnění podmínek.', linkLabel: 'Zobrazit stav karty (jen informace)' } }] };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  assert.equal((await context.request.post(base + '/api/login', { data: { password: process.env.BOSS_PASSWORD ?? 'boss-preview' } })).status(), 200);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  let mode = 'fixture';
  await page.route('**/api/boss-attention?*', async (route) => {
    if (mode === 'error') return route.fulfill({ status: 503, body: '{}' });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(mode === 'empty' ? empty : fixture) });
  });
  await page.goto(base + '/?3d');
  console.log('office loaded');
  await page.getByRole('button', { name: /Enter the office/ }).click({ timeout: 30000 });
  console.log('entered');
  await page.waitForFunction(() => window.__office?.store.floor);
  await page.evaluate(() => {
    const p = window.__office.player;
    p.setView('first'); p.pos.set(15.5, 3, 10.5); p.vy = 0; p.camYaw = -Math.PI / 2; p.lookPitch = 0.12;
  });
  await page.waitForTimeout(800);
  console.log('at board');
  await page.waitForFunction(() => !!document.pointerLockElement);
  await page.screenshot({ path: path.join(shots, 'boss-board.png') });
  // Oblique room views must show only the opaque panel, never the window/frame behind it.
  for (const [name, z, yaw] of [['north', 8.8, -2.05], ['south', 12.2, -1.09]]) {
    await page.evaluate(({ z, yaw }) => {
      const p = window.__office.player; p.pos.set(14.5, 3, z); p.camYaw = yaw; p.lookPitch = -0.03; p.vy = 0;
    }, { z, yaw });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shots, `boss-board-${name}.png`) });
  }
  await page.evaluate(() => {
    const p = window.__office.player; p.pos.set(15.5, 3, 10.5); p.camYaw = -Math.PI / 2; p.lookPitch = 0.12; p.vy = 0;
  });
  await page.waitForTimeout(250);
  await page.keyboard.press('KeyE');
  const dialog = page.getByRole('dialog', { name: 'Boss Office — Pro tebe', exact: true });
  await dialog.waitFor({ timeout: 10000 });
  await page.getByRole('heading', { name: 'Potvrdit rozsah pilotního ověření' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: /H05/ }).count(), 0, 'agent information is not in My tasks');
  assert.equal(await page.locator('.boss-attention-guide ol li').count(), 3, 'actionable ordered steps');
  const link = page.getByRole('link', { name: 'Otevřít kartu a odpovědět v Opoře' });
  const url = new URL(await link.getAttribute('href'));
  assert.equal(url.searchParams.get('node'), 'task');
  assert.equal(url.searchParams.get('layer'), 'pilot');
  assert.equal(await dialog.getByRole('button', { name: /Potvrdit/ }).count(), 0, 'No approval mutation button');
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press(i % 2 ? 'Tab' : 'Shift+Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('.boss-attention')), true);
  }
  await page.screenshot({ path: path.join(shots, 'boss-dialog-desktop.png') });
  await page.getByRole('tab', { name: 'Stav agentů (1)' }).click();
  await page.getByRole('heading', { name: /H05/ }).waitFor();
  assert.equal(await page.getByText('Tvoje akce nyní: žádná. Tuto položku nepotvrzuj.', { exact: true }).count(), 1);
  assert.equal(await page.locator('.boss-attention-guide').count(), 0, 'system state is not a human checklist');
  await page.screenshot({ path: path.join(shots, 'boss-agent-state.png') });
  await page.getByRole('button', { name: '↻ Obnovit' }).click();
  await page.getByRole('heading', { name: /H05/ }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Stav agentů (1)' }).getAttribute('aria-selected'), 'true', 'refresh preserves selected view');
  await page.getByRole('tab', { name: 'Moje úkoly (1)' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const box = await dialog.boundingBox();
  assert.deepEqual([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)], [0, 0, 390, 844]);
  await page.screenshot({ path: path.join(shots, 'boss-dialog-mobile.png') });
  mode = 'empty';
  await link.focus();
  // Simulate a polling refresh without moving focus off the soon-to-disappear card.
  await page.getByRole('button', { name: '↻ Obnovit' }).evaluate((button) => button.click());
  await page.getByText('Teď není vyžadován tvůj zásah.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Zavřít tabuli');
  await page.screenshot({ path: path.join(shots, 'boss-empty.png') });
  mode = 'error';
  await page.getByRole('button', { name: '↻ Obnovit' }).click();
  await page.getByRole('alert').filter({ hasText: /HTTP 503/ }).waitFor();
  assert.equal(await page.getByText('Teď není vyžadován tvůj zásah.', { exact: true }).count(), 0);
  await page.screenshot({ path: path.join(shots, 'boss-error.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Zavřít tabuli' }).click();
  await page.waitForFunction(() => !!document.pointerLockElement);
  await page.keyboard.press('KeyE'); await dialog.waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !!document.pointerLockElement);
  assert.equal(await dialog.count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: physical Boss board/E, exact links, human/system split, desktop/mobile screenshots, empty/error, focus trap, X/Esc return mouse-look. UI states are fixtures.');
} finally { await browser.close(); }

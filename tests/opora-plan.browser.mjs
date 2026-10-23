// Against an isolated production preview: the process wall window's "Lens plánu" tab with no worker
// running. Run a built office with a temporary project, PLAN_PASSWORD and AGENT_OFFICE_OPORA_URL pointing
// nowhere on port 4693, then: node --import tsx tests/opora-plan.browser.mjs
// The project plan is the live one from a local Opora when PLAN_OPORA_PROJECT is set (one read-only GET,
// passed through the office's own planLens), else a small fixture; the cards are fixtures in the page's store.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

const base = process.env.PLAN_OFFICE_URL ?? 'http://127.0.0.1:4693';
const shots = process.env.PLAN_SHOTS ?? path.join(os.tmpdir(), 'opora-plan-shots');
await mkdir(shots, { recursive: true });
const { planLens } = await import('../src/server/opora/lens-reader.ts');

const fixturePlan = {
  kind: 'graph', title: 'Plán projektu', summary: 'Fixture: 2 oblasti, 3 karty.',
  lanes: [{ id: 'plan', label: 'Plán' }],
  nodes: [{ id: 'area:a', label: 'Výstavba knihovny', kind: 'module', lane: 'plan', badges: ['0/2 hotovo'] }, { id: 'area:b', label: 'Základy', kind: 'module', lane: 'plan', badges: ['1/1 hotovo'] }],
  edges: [{ id: 'e', from: 'area:a', to: 'area:b', kind: 'dependency', delta: 'unchanged' }],
};
let live = false, plan;
const project = process.env.PLAN_OPORA_PROJECT;
if (project) {
  const opora = process.env.PLAN_OPORA_URL ?? 'http://127.0.0.1:8740';
  const res = await fetch(`${opora}/api/oporahub/plan-lens?${new URLSearchParams({ project, workspace: process.env.PLAN_OPORA_WORKSPACE ?? 'draft' })}`,
    { headers: { Accept: 'application/json', 'X-Opora-Actor': 'agent; name=office-plan-preview' } }).catch(() => undefined);
  if (res?.ok) { plan = planLens({ status: 200, data: await res.json() }); live = plan.state === 'ok'; }
}
plan ??= planLens({ status: 200, data: { spec: fixturePlan, stats: { areas: 2, cards: 3, withCode: 1, planned: 2 }, digest: 'f'.repeat(64) } });
console.log(live ? 'plan: live from Opora' : 'plan: fixture');

const cards = [
  { id: 'c-lib-1', name: 'Knihovna komponent', sectorId: 's1', sectorName: 'Výstavba knihovny', status: 'frontier', group: 'dev' },
  { id: 'c-lib-2', name: 'Ikony knihovny', sectorId: 's1', sectorName: 'Výstavba knihovny', status: 'claimed', group: 'dev' },
  { id: 'c-nav-1', name: 'Pravý navbar', sectorId: 's2', sectorName: 'Výstavba pravého navbaru', status: 'waiting', group: 'design', profile: 'design', stage: 'Skica' },
  { id: 'c-base-1', name: 'Základy projektu', sectorId: 's3', sectorName: 'Základy, na kterých stavím', status: 'closed', group: 'dev' },
  { id: 'c-free-1', name: 'Karta bez oblasti', status: 'frontier', group: 'dev' },
];

const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  assert.equal((await context.request.post(base + '/api/login', { data: { password: process.env.PLAN_PASSWORD ?? 'plan-preview' } })).status(), 200);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  let planState = 'ok';
  await page.route('**/api/opora-plan-lens?*', (route) => route.fulfill({ contentType: 'application/json',
    body: JSON.stringify(planState === 'ok' ? { linked: true, base: 'http://127.0.0.1:8740', project: 'opora-control-center-canvas', plan } : { linked: true, plan: { state: planState } }) }));
  await page.route('**/api/opora-lens?*', (route) => route.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ linked: true, base: 'http://127.0.0.1:8740', nodeId: new URL(route.request().url()).searchParams.get('card'), card: { state: 'none' }, plan: { state: 'none' } }) }));
  await page.route('**/api/opora-preview?*', (route) => route.fulfill({ status: 404, body: '{}' }));
  await page.goto(base + '/?3d');
  await page.getByRole('button', { name: /Enter the office/ }).click({ timeout: 30000 });
  await page.waitForFunction(() => window.__office?.store.floor);
  await page.waitForTimeout(1000);
  const setOpora = (patch) => page.evaluate((patch) => { const s = window.__office.store; s.opora = { ...s.opora, ...patch }; s.emit('opora'); }, patch);
  await setOpora({ connected: true, project: { id: 'p', name: 'opora-control-center-canvas' }, workspace: 'draft', cards });
  await page.waitForFunction(() => !!document.pointerLockElement);
  const dialog = page.getByRole('dialog', { name: 'Živý proces' });
  const openWall = async () => {
    for (const yaw of [0, Math.PI]) {
      await page.evaluate((yaw) => {
        const o = window.__office, it = o.office.interactables.find((i) => i.kind === 'processwall'), p = o.player;
        p.setView('first'); p.pos.set(it.x, 0, it.z + 1); p.camYaw = yaw; p.lookPitch = 0.55; p.vy = 0;
      }, yaw);
      await page.waitForTimeout(700);
      await page.keyboard.press('KeyE');
      if (await dialog.waitFor({ timeout: 2500 }).then(() => true, () => false)) return;
    }
    await dialog.waitFor();
  };
  const backToMouseLook = async () => {
    await page.waitForFunction(() => !!document.pointerLockElement);
    assert.equal(await dialog.count(), 0);
  };

  // No worker, no lane: the tab still shows the project's plan and every card.
  await openWall();
  await page.getByRole('tab', { name: 'Lens plánu' }).click();
  const tab = page.locator('.op-tab');
  await tab.locator('.op-plan .lx-card').first().waitFor();
  assert.equal(await tab.locator('.op-card').count(), cards.length);
  assert.deepEqual(await tab.locator('.op-group h4 span:first-child').allTextContents(), ['Výstavba knihovny', 'Výstavba pravého navbaru', 'Základy, na kterých stavím', 'Nezařazeno']);
  await page.screenshot({ path: path.join(shots, 'opora-plan-project.png') });

  // Search, pick a card: the Lens section for it, with why it has nothing yet.
  await tab.getByRole('searchbox', { name: 'Hledat kartu' }).fill('knihovn');
  assert.equal(await tab.locator('.op-card').count(), 2);
  await tab.locator('.op-card', { hasText: 'Ikony knihovny' }).click();
  const lens = tab.locator('.pw-sec.lens:not(.op-plan)');
  await lens.getByText('Karta zatím nemá PR Lens.').waitFor();
  assert.match(await tab.locator('.op-detail').innerText(), /Na kartě teď nikdo nepracuje/);
  await page.screenshot({ path: path.join(shots, 'opora-plan-card.png') });

  // A design card also gets "Jak to bude vypadat", calm on an Opora without the endpoint.
  await tab.getByRole('searchbox', { name: 'Hledat kartu' }).fill('');
  await tab.locator('.op-card', { hasText: 'Pravý navbar' }).click();
  await tab.locator('.pw-sec.dp').waitFor();
  await page.screenshot({ path: path.join(shots, 'opora-plan-design-card.png') });

  // Back to the plan; Esc closes the window straight to mouse-look.
  await tab.getByRole('button', { name: '← Plán projektu' }).click();
  await tab.locator('.op-plan .lx-card').first().waitFor();
  await page.keyboard.press('Escape');
  await backToMouseLook();

  // Opora not answering and the floor unlinked: each says why.
  planState = 'unavailable';
  await setOpora({ connected: false, project: null, cards: [], error: 'Opora neodpovídá' });
  await openWall();
  await page.getByRole('tab', { name: 'Lens plánu' }).click();
  await tab.getByText(/Opora nedostupná/).waitFor();
  await tab.getByText(/Patro není propojené s projektem Opory/).waitFor();
  await page.screenshot({ path: path.join(shots, 'opora-plan-empty.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await backToMouseLook();

  // Phone width: list above, plan below, no sideways scroll.
  await setOpora({ connected: true, project: { id: 'p', name: 'opora-control-center-canvas' }, cards, error: undefined });
  planState = 'ok';
  await page.setViewportSize({ width: 480, height: 860 });
  await openWall();
  await page.getByRole('tab', { name: 'Lens plánu' }).dispatchEvent('click');
  await tab.locator('.op-plan .lx-card').first().waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no horizontal page scroll at 480 px');
  await page.screenshot({ path: path.join(shots, 'opora-plan-480.png') });
  await page.keyboard.press('Escape');
  await backToMouseLook();
  assert.deepEqual(errors, []);
  console.log('ok', shots);
} finally {
  await browser.close();
}

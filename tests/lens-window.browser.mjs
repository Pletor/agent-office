// Against an isolated production preview only (no real Opora): the Lens section of the process
// wall's card inspector, with /api/opora-lens answered from a fixture spec. Run a built office with
// a temporary project and LENS_PASSWORD on port 4691, then: node --import tsx tests/lens-window.browser.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

const base = process.env.LENS_OFFICE_URL ?? 'http://127.0.0.1:4691';
const shots = process.env.LENS_SHOTS ?? path.join(os.tmpdir(), 'lens-window-shots');
await mkdir(shots, { recursive: true });
const spec = {
  kind: 'graph', title: 'Lens v okně Živý proces', summary: 'Inspektor karty čte PR Lens z Opory přes kancelář a kreslí ho jako text.',
  lanes: [{ id: 'client', label: 'Prohlížeč', delta: 'added' }, { id: 'server', label: 'Server kanceláře' }, { id: 'opora', label: 'Opora' }],
  nodes: [
    { id: 'section', label: 'LensSection', kind: 'ui', delta: 'added', lane: 'client', files: [{ path: 'src/client/features/lens/ui.ts', startLine: 1, endLine: 120 }], badges: ['30 s'] },
    { id: 'insp', label: 'renderInspector', kind: 'ui', delta: 'modified', lane: 'client', files: [{ path: 'src/client/features/process-wall/inspector.ts', startLine: 8, endLine: 13 }] },
    { id: 'route', label: 'GET /api/opora-lens', kind: 'route', delta: 'added', lane: 'server', files: [{ path: 'src/server/http/routes/opora-lens.ts' }] },
    { id: 'reader', label: 'LensReader', kind: 'service', delta: 'added', lane: 'server', files: [{ path: 'src/server/opora/lens-reader.ts' }], badges: ['cache', 'read-only'] },
    { id: 'review', label: 'GET /review-lens', kind: 'external', delta: 'unchanged', lane: 'opora' },
    { id: 'plan', label: 'GET /plan-lens', kind: 'external', delta: 'unchanged', lane: 'opora' },
  ],
  edges: [
    { id: 'e1', from: 'insp', to: 'section', kind: 'render', delta: 'added' },
    { id: 'e2', from: 'section', to: 'route', kind: 'http', delta: 'added', emphasis: 'hero', label: 'card, area' },
    { id: 'e3', from: 'reader', to: 'review', kind: 'http', delta: 'added' },
    { id: 'e4', from: 'reader', to: 'plan', kind: 'http', delta: 'added', label: '404 = chybí' },
  ],
  flows: [{ id: 'f', title: 'Výběr karty', steps: [{ from: 'insp', to: 'section', label: 'karta' }, { from: 'section', to: 'route', label: 'fetch' }, { from: 'route', to: 'reader', label: 'cache 30 s' }] }],
};
const reply = {
  linked: true, base: 'http://127.0.0.1:8740', nodeId: 'card-lens',
  card: { state: 'ok' },
  plan: { state: 'missing' },
};
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  assert.equal((await context.request.post(base + '/api/login', { data: { password: process.env.LENS_PASSWORD ?? 'lens-preview' } })).status(), 200);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const { lensGraph } = await import('../src/shared/opora-lens.ts').catch(() => ({}));
  const graph = lensGraph ? lensGraph(spec) : null;
  reply.card.pr = { graph, number: 51, prState: 'open', current: true, by: 'office-lens' };
  reply.card.area = { graph: null, note: 'Opora nemá specifikaci diagramu.' };
  let asked = 0;
  await page.route('**/api/opora-lens?*', async (route) => {
    asked++;
    const u = new URL(route.request().url());
    assert.equal(u.searchParams.get('card'), 'card-lens');
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(reply) });
  });
  await page.goto(base + '/?3d');
  await page.getByRole('button', { name: /Enter the office/ }).click({ timeout: 30000 });
  await page.waitForFunction(() => window.__office?.store.floor);
  await page.waitForTimeout(1000);
  // A card lane: one process event on an Opora card (fixture, only in this page's store).
  await page.evaluate(() => {
    const s = window.__office.store;
    s.process.events = [...s.process.events, { schema: 'opora.process-event/1', id: 'fixture:1', seq: 1, at: new Date().toISOString(), source: 'opora', kind: 'pr.lens', phase: 'review', state: 'ok',
      title: 'PR Lens pro #51 odeslán do Opory', actor: { kind: 'agent', name: 'office-lens' }, refs: { cardId: 'card-lens', pr: 51, branch: 'feat/lens-window' } }];
    s.emit('process');
  });
  await page.waitForFunction(() => !!document.pointerLockElement);
  const dialog = page.getByRole('dialog', { name: 'Živý proces' });
  // Stand in front of the wall and look up at it (the wall hangs above the north boards).
  for (const yaw of [0, Math.PI]) {
    await page.evaluate((yaw) => {
      const o = window.__office, it = o.office.interactables.find((i) => i.kind === 'processwall'), p = o.player;
      p.setView('first'); p.pos.set(it.x, 0, it.z + 1); p.camYaw = yaw; p.lookPitch = 0.55; p.vy = 0;
    }, yaw);
    await page.waitForTimeout(700);
    await page.keyboard.press('KeyE');
    if (await dialog.waitFor({ timeout: 2500 }).then(() => true, () => false)) break;
  }
  await dialog.waitFor();
  await page.locator('.pw-row', { hasText: 'card-lens' }).first().click().catch(() => undefined);
  await page.locator('.pw-sec.lens .lens-graph').waitFor();
  assert.ok(asked >= 1);
  const link = page.getByRole('link', { name: /Otevřít v Opoře/ });
  assert.equal(await link.getAttribute('href'), 'http://127.0.0.1:8740/?ohCard=card-lens&ohTab=lens');
  await page.locator('.pw-sec.lens').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, 'lens-window.png') });
  await page.locator('.pw-sec.lens').screenshot({ path: path.join(shots, 'lens-section.png') });
  await page.getByRole('tab', { name: 'Plán oblasti' }).click();
  await page.locator('.pw-sec.lens').screenshot({ path: path.join(shots, 'lens-plan-missing.png') });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !!document.pointerLockElement);
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.setViewportSize({ width: 420, height: 860 });
  await page.keyboard.press('KeyE');
  await dialog.waitFor();
  await page.locator('.pw-sec.lens').scrollIntoViewIfNeeded().catch(() => undefined);
  await page.screenshot({ path: path.join(shots, 'lens-window-narrow.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForFunction(() => !!document.pointerLockElement);
  assert.deepEqual(errors, []);
  console.log('ok', shots);
} finally {
  await browser.close();
}

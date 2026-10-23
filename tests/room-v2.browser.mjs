// The planning room v2 ("Místnost – rozložení") in a real browser, on live Opora data: the 🎚️ switchboard
// over the whole north glass, a page switched on there flying over to the purple board as the
// orchestrator's card (the pick-flow sequence), the purple board's plan by layers (area → sector → node)
// with its window (Pozastavit / Přeplánovat / Přidat stůl) and the design card on it, and the ledge's
// detail. Run a built office with a temporary project and ROOM_PASSWORD on port 4695 whose
// AGENT_OFFICE_OPORA_URL is a read-only (GET) way to an Opora that has ROOM_PROJECT; then:
//   node --import tsx tests/room-v2.browser.mjs
// Opora is only read. The office's own settings (the floor's link, its focus) are what the test changes.
// The design card on the board is the focused page shown as one in this page only, with its preview
// from fixtures, since the project has no page on the design pipeline (those shots are named *-fixture).
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

const base = process.env.ROOM_OFFICE_URL ?? 'http://127.0.0.1:4695';
const shots = process.env.ROOM_SHOTS ?? path.join(os.tmpdir(), 'room-v2-shots');
const project = process.env.ROOM_PROJECT ?? '41a6776519694319a3aaf7ff453c3dfc';
const workspace = process.env.ROOM_WORKSPACE ?? '36fd9bc1d1b4455087b315271f2fb42d';
const walk = (process.env.ROOM_PATH ?? 'Produkce/Aplikace/Oracle/Na míru').split('/');
await mkdir(shots, { recursive: true });

const sketchSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="380" viewBox="0 0 300 380"><rect x="1" y="1" width="298" height="378" rx="14" fill="#fffef9" stroke="#3b3b3b" stroke-width="2"/>
<text x="16" y="40" font-family="Comic Sans MS, cursive" font-size="24" fill="#3b3b3b">Věštba na míru</text><circle cx="150" cy="170" r="80" fill="none" stroke="#3b3b3b" stroke-width="2" stroke-dasharray="6 6"/>
<rect x="16" y="322" width="268" height="42" rx="12" fill="none" stroke="#3b3b3b" stroke-width="2.5"/><text x="70" y="350" font-family="Comic Sans MS, cursive" font-size="20" fill="#3b3b3b">Spustit věštbu · 3 kredity</text></svg>`;
const screen = `<!doctype html><meta charset="utf-8"><body style="margin:0;width:300px;height:380px;font-family:Nunito,system-ui;background:#1f1633;color:#f6efff">
<div style="padding:16px;display:grid;gap:12px;height:380px;box-sizing:border-box;grid-template-rows:auto 1fr auto"><div style="font-size:20px;font-weight:900">Věštba na míru</div>
<div style="display:grid;place-items:center"><div style="width:160px;height:160px;border-radius:50%;border:4px solid #c9a7ff;box-shadow:0 0 30px #9b5de5"></div></div>
<div style="border-radius:12px;padding:12px;text-align:center;font-weight:900;background:#ffd166;color:#1f1633">Spustit věštbu · 3 kredity</div></div></body>`;
const MD = 'c'.repeat(64), fileId = 'preview_' + '1'.repeat(64);
const designReply = (card) => ({ linked: true, base: 'http://127.0.0.1:8740', nodeId: card, state: 'ok', mode: 'brand', sketch: true, drawing: { elements: 9 }, storyboard: { moments: 3, sketches: 3 },
  designSystem: { available: true, revision: 'abc1234def', sha256: MD, brand: { fonts: ['Nunito'], colors: [{ hex: '#1f1633', name: 'noc' }, { hex: '#9b5de5', name: 'fialová' }, { hex: '#ffd166', name: 'zlatá' }, { hex: '#f6efff', name: 'plocha' }] } },
  heads: [{ prNumber: 212, headSha: '5f935f2' + 'a'.repeat(33), prState: 'open', current: true, mode: 'brand', designMdSha256: MD, shots: [{ label: 'mobil světlý', width: 390, height: 844, file: fileId }] }] });

const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
try {
  const maker = await browser.newPage({ viewport: { width: 300, height: 380 } });
  await maker.setContent(screen);
  const png = await maker.screenshot();
  await maker.close();

  const context = await browser.newContext({ viewport: { width: 1600, height: 960 } });
  assert.equal((await context.request.post(base + '/api/login', { data: { password: process.env.ROOM_PASSWORD ?? 'orch-preview' } })).status(), 200);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  let designCard = '';
  await page.route('**/api/opora-preview?*', (route) => {
    const card = new URL(route.request().url()).searchParams.get('card');
    return card === designCard ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(designReply(card)) }) : route.continue();
  });
  await page.route('**/api/opora-preview/file?*', (route) => (designCard
    ? new URL(route.request().url()).searchParams.get('kind') === 'sketch' ? route.fulfill({ contentType: 'image/svg+xml', body: sketchSvg }) : route.fulfill({ contentType: 'image/png', body: png })
    : route.continue()));
  await page.goto(base + '/?3d');
  await page.getByRole('button', { name: /Enter the office/ }).click({ timeout: 30000 });
  await page.waitForFunction(() => window.__office?.store.floor);
  await page.waitForFunction(() => !!document.pointerLockElement);

  // Link the floor to the live project and its workspace, with nothing switched on yet (the office's own settings).
  await page.evaluate(({ project }) => window.__office.net.send({ t: 'opora.link', projectId: project }), { project });
  await page.waitForFunction((p) => window.__office.store.opora.project?.id === p, project, { timeout: 60000 });
  await page.evaluate(({ workspace }) => window.__office.net.send({ t: 'opora.workspace', workspaceId: workspace }), { workspace });
  await page.waitForFunction((w) => window.__office.store.opora.workspace === w && window.__office.store.opora.scope.length > 0, workspace, { timeout: 60000 });
  await page.evaluate(() => window.__office.net.send({ t: 'opora.focus', id: null, on: false }));
  await page.waitForFunction(() => window.__office.store.orchestrator.focus === null || window.__office.store.opora.focus.length === 0);

  const stand = (x, z, yaw, pitch) => page.evaluate(({ x, z, yaw, pitch }) => { const p = window.__office.player; p.setView('first'); p.pos.set(x, 0, z); p.camYaw = yaw; p.lookPitch = pitch; p.vy = 0; }, { x, z, yaw, pitch });
  const useAt = async (name, x, z, yaw, pitches) => {
    const dialog = page.getByRole('dialog', { name, exact: true });
    for (const pitch of pitches) {
      await stand(x, z, yaw, pitch);
      await page.waitForTimeout(600);
      await page.keyboard.press('KeyE');
      if (await dialog.waitFor({ timeout: 2000 }).then(() => true, () => false)) return dialog;
    }
    throw new Error(`could not open ${name}`);
  };
  const backToMouseLook = async (dialog) => { await page.waitForFunction(() => !!document.pointerLockElement); assert.equal(await dialog.count(), 0); };
  const ROOM = [6.9, 7.3, Math.PI / 4, 0.12];
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });

  // Before: nothing switched on, the switchboard over the whole glass with no plate, the board asking for a page.
  await stand(...ROOM);
  await page.waitForTimeout(1500);
  await shot('01-room-no-card');
  await stand(5, 6.0, 0, 0.16);
  await page.waitForTimeout(800);
  await shot('02-switchboard-full-glass');

  // The pick: E at the switchboard, the way down to the page, its switch.
  const scope = await useAt('Zaměření buňky', 5, 4.4, 0, [0.2, 0.45, -0.2, 0.6]);
  for (const name of walk.slice(0, -1)) await scope.locator('.scope-name', { hasText: name }).first().click();
  await shot('03-switchboard-window-walk');
  await scope.locator('.scope-row', { hasText: walk.at(-1) }).first().locator('input[type=checkbox]').check();
  await page.waitForFunction(() => !!window.__office.store.orchestrator.focus);
  await scope.locator('.scope-row.deep').waitFor();
  await shot('04-switchboard-window-picked');
  await page.keyboard.press('Escape');
  await backToMouseLook(scope);

  // The pick flying over: the chip leaves the switchboard and lands on the purple board, which lights up.
  const focus = await page.evaluate(() => window.__office.store.orchestrator.focus);
  console.log('orchestrator card:', focus.name);
  await page.evaluate(() => window.__office.net.send({ t: 'opora.focus', id: null, on: false }));
  await page.waitForFunction(() => window.__office.store.orchestrator.focus === null);
  await stand(...ROOM);
  await page.waitForTimeout(900);
  await page.evaluate((id) => window.__office.net.send({ t: 'opora.focus', id, on: true, only: true }), focus.cardId);
  await page.waitForFunction(() => !!window.__office.store.orchestrator.focus);
  for (const [i, ms] of [[1, 150], [2, 350], [3, 350], [4, 400], [5, 500], [6, 1200]]) { await page.waitForTimeout(ms); await shot(`05-pick-flow-${i}`); }
  await page.waitForFunction(() => !!window.__office.store.orchestrator.brief, null, { timeout: 60000 });
  const brief = await page.evaluate(() => window.__office.store.orchestrator.brief);
  assert.match(brief, /Where \(cell focus at the switchboard\):/);
  assert.match(brief, /Page settings:/);
  console.log(brief);

  // The purple board up close: the card bar, the plan by layers, the feed.
  await stand(5.6, 5.5, Math.PI / 2, 0.02);
  await page.waitForTimeout(1500);
  await shot('06-purple-board');
  await stand(5, 6.2, 0, 0.16);
  await page.waitForTimeout(800);
  await shot('07-switchboard-with-card');

  // E at the board: its window, to act on, with the plan by layers.
  const live = await useAt('Canvas živě', 4.4, 5.5, Math.PI / 2, [0.15, 0.3, 0.05, 0.4]);
  await live.locator('.ol-page').waitFor();
  await page.waitForTimeout(800);
  await shot('08-canvas-zive-window');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await backToMouseLook(live);

  // A design card: the same page shown as one in this page only, its preview from fixtures.
  designCard = focus.cardId;
  await page.evaluate((id) => {
    const s = window.__office.store;
    const patch = () => {
      const known = s.opora.cards.some((c) => c.id === id);
      const card = { id, name: s.opora.scope.find((n) => n.id === id)?.name ?? 'karta', group: 'design', profile: 'design', stage: 'Shoda s návrhem', status: 'claimed' };
      s.opora.cards = known ? s.opora.cards.map((c) => (c.id === id ? { ...c, ...card } : c)) : [...s.opora.cards, card];
    };
    s.on('opora', patch);
    patch();
  }, designCard);
  await page.waitForTimeout(2500);
  await stand(5.6, 5.5, Math.PI / 2, 0.02);
  await page.waitForTimeout(3000);
  await shot('09-purple-board-design-card-fixture');
  const live2 = await useAt('Canvas živě', 4.4, 5.5, Math.PI / 2, [0.15, 0.3, 0.05, 0.4]);
  await live2.locator('.oc-seg.cur').waitFor();
  await page.waitForTimeout(800);
  await shot('10-canvas-zive-window-design-fixture');
  await page.keyboard.press('Escape');
  await backToMouseLook(live2);

  // The ledge: the card's detail, Design karta and Lens.
  const detail = await useAt('Detail karty pro orchestrátora', 4.0, 5.5, Math.PI / 2, [-0.9, 0.9, -0.7, -1.1]);
  await detail.locator('.oc-seg.cur').waitFor();
  await shot('11-ledge-detail-design-fixture');
  await detail.getByRole('tab', { name: 'Lens (návrh 1)' }).click();
  await page.waitForTimeout(2500);
  await shot('12-ledge-detail-lens');
  await page.keyboard.press('Escape');
  await backToMouseLook(detail);

  await stand(...ROOM);
  await page.waitForTimeout(1500);
  await shot('13-room-after');
  assert.deepEqual(errors, []);
  console.log('ok: shots in', shots);
} finally {
  await browser.close();
}

// The orchestrator's boards in the planning room, in a real browser: the right board's card picker, the
// purple board's detail window (Lens / Design karta), and both board faces in 3D. Run a built office with
// a temporary project and ORCH_PASSWORD on port 4695 whose AGENT_OFFICE_OPORA_URL is a read-only (GET)
// way to an Opora that has ORCH_PROJECT; then: node --import tsx tests/orchestrator.browser.mjs
// The cards and their Lens are live; one card is shown as a design card in this page only, with its
// preview from fixtures, since the project may have none on the design pipeline.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

const base = process.env.ORCH_OFFICE_URL ?? 'http://127.0.0.1:4695';
const shots = process.env.ORCH_SHOTS ?? path.join(os.tmpdir(), 'orchestrator-shots');
const project = process.env.ORCH_PROJECT ?? '4b38182c5b04482bb00e0f3d3ae55656';
const workspace = process.env.ORCH_WORKSPACE ?? 'draft';
await mkdir(shots, { recursive: true });

const sketchSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="380" viewBox="0 0 300 380"><rect x="1" y="1" width="298" height="378" rx="14" fill="#fffef9" stroke="#3b3b3b" stroke-width="2"/>
<text x="16" y="38" font-family="Comic Sans MS, cursive" font-size="24" fill="#3b3b3b">Košík (3)</text>
${[0, 1, 2].map((i) => `<rect x="16" y="${66 + i * 56}" width="44" height="44" rx="6" fill="none" stroke="#3b3b3b" stroke-width="2"/><rect x="72" y="${80 + i * 56}" width="120" height="9" rx="4" fill="#cfcfcf"/>`).join('')}
<rect x="16" y="322" width="268" height="42" rx="12" fill="none" stroke="#3b3b3b" stroke-width="2.5"/><text x="60" y="350" font-family="Comic Sans MS, cursive" font-size="20" fill="#3b3b3b">Pokračovat k platbě →</text></svg>`;
const screen = `<!doctype html><meta charset="utf-8"><body style="margin:0;width:300px;height:380px;font-family:Nunito,system-ui;background:#fff;color:#1f2230">
<div style="padding:14px;display:grid;gap:10px;height:380px;box-sizing:border-box;grid-template-rows:auto 1fr auto auto"><div style="font-size:18px;font-weight:900">Košík <small style="font-size:11px;color:#6b6f80">3 položky</small></div>
<div style="display:grid;gap:8px;align-content:start">${['Lněná košile', 'Plátěná taška', 'Ponožky 3 páry'].map((n) => `<div style="display:grid;grid-template-columns:44px 1fr;gap:10px;align-items:center"><span style="width:44px;height:44px;border-radius:10px;background:#efe9df"></span><b style="font-size:13px">${n}</b></div>`).join('')}</div>
<div style="border-top:1px solid #ece7df;padding-top:10px;font-weight:800">Celkem 1 929 Kč</div><div style="border-radius:12px;padding:11px;text-align:center;font-weight:900;background:#1f2230;color:#fff">Pokračovat k platbě</div></div></body>`;
const MD = 'c'.repeat(64), fileId = 'preview_' + '1'.repeat(64);
const designReply = (card) => ({ linked: true, base: 'http://127.0.0.1:8740', nodeId: card, state: 'ok', mode: 'brand', sketch: true, drawing: { elements: 12 }, storyboard: { moments: 4, sketches: 4 },
  designSystem: { available: true, revision: 'abc1234def', sha256: MD, brand: { fonts: ['Nunito'], colors: [{ hex: '#1f2230', name: 'ink' }, { hex: '#ffffff', name: 'plocha' }, { hex: '#ff8a5b', name: 'akcent' }, { hex: '#e3f6ee', name: 'úspěch' }] } },
  heads: [{ prNumber: 128, headSha: '5f935f2' + 'a'.repeat(33), prState: 'open', current: true, mode: 'brand', designMdSha256: MD, shots: [{ label: 'mobil světlý', width: 390, height: 844, file: fileId }] }] });

const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
try {
  const maker = await browser.newPage({ viewport: { width: 300, height: 380 } });
  await maker.setContent(screen);
  const png = await maker.screenshot();
  await maker.close();

  const context = await browser.newContext({ viewport: { width: 1600, height: 960 } });
  assert.equal((await context.request.post(base + '/api/login', { data: { password: process.env.ORCH_PASSWORD ?? 'orch-preview' } })).status(), 200);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  let designCard = '';
  await page.route('**/api/opora-preview?*', (route) => {
    const card = new URL(route.request().url()).searchParams.get('card');
    return card === designCard ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(designReply(card)) }) : route.continue();
  });
  await page.route('**/api/opora-preview/file?*', (route) => new URL(route.request().url()).searchParams.get('kind') === 'sketch'
    ? route.fulfill({ contentType: 'image/svg+xml', body: sketchSvg }) : route.fulfill({ contentType: 'image/png', body: png }));
  await page.goto(base + '/?3d');
  await page.getByRole('button', { name: /Enter the office/ }).click({ timeout: 30000 });
  await page.waitForFunction(() => window.__office?.store.floor);
  await page.waitForFunction(() => !!document.pointerLockElement);

  // Link the floor to the live project and its workspace (the office's own setting; Opora is only read).
  await page.evaluate(({ project }) => window.__office.net.send({ t: 'opora.link', projectId: project }), { project });
  await page.waitForFunction((p) => window.__office.store.opora.project?.id === p, project, { timeout: 60000 });
  await page.evaluate(({ workspace }) => window.__office.net.send({ t: 'opora.workspace', workspaceId: workspace }), { workspace });
  await page.waitForFunction((w) => window.__office.store.opora.workspace === w && window.__office.store.opora.cards.length > 0, workspace, { timeout: 60000 });
  const cards = await page.evaluate(() => window.__office.store.opora.cards.map((c) => ({ id: c.id, name: c.name, sectorId: c.sectorId, sectorName: c.sectorName })));
  const floor = await page.evaluate(() => window.__office.store.floor);
  // A card with a PR Lens if the project has one, else one with an area.
  let lensCard;
  for (const c of cards.filter((c) => c.sectorId).slice(0, 40)) {
    const r = await (await context.request.get(`${base}/api/opora-lens?${new URLSearchParams({ floor, card: c.id, area: c.sectorId })}`)).json();
    if (r.card?.pr?.graph) { lensCard = c; break; }
    lensCard ??= r.plan?.view?.graph ? c : undefined;
  }
  lensCard ??= cards[0];
  designCard = (cards.find((c) => c.id !== lensCard.id && c.sectorName) ?? cards[1]).id;
  console.log(`${cards.length} live cards; Lens card: ${lensCard.name}; shown as design card: ${cards.find((c) => c.id === designCard).name}`);
  // In this page only: one card on the design pipeline, at Review.
  await page.evaluate((id) => {
    const s = window.__office.store;
    const patch = () => { s.opora.cards = s.opora.cards.map((c) => (c.id === id ? { ...c, group: 'design', profile: 'design', stage: 'Shoda s návrhem', status: 'claimed' } : c)); };
    s.on('opora', patch);
    patch();
  }, designCard);

  const stand = (x, z, yaw, pitch) => page.evaluate(({ x, z, yaw, pitch }) => { const p = window.__office.player; p.setView('first'); p.pos.set(x, 0, z); p.camYaw = yaw; p.lookPitch = pitch; p.vy = 0; }, { x, z, yaw, pitch });
  const useAt = async (name, x, z, yaw, pitches) => {
    const dialog = page.getByRole('dialog', { name });
    for (const pitch of pitches) {
      await stand(x, z, yaw, pitch);
      await page.waitForTimeout(600);
      await page.keyboard.press('KeyE');
      if (await dialog.waitFor({ timeout: 2000 }).then(() => true, () => false)) return dialog;
    }
    throw new Error(`could not open ${name}`);
  };
  const backToMouseLook = async (dialog) => { await page.waitForFunction(() => !!document.pointerLockElement); assert.equal(await dialog.count(), 0); };

  // 3D: the right board's plate (no card yet) over the switchboard, and the purple board with its ledge.
  await stand(6.9, 7.3, Math.PI / 4, 0.08);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(shots, '3d-room-before.png') });

  // The right board: E opens the picker; picking a card shows the overview the orchestrator gets.
  const picker = await useAt('Karta pro orchestrátora', 5, 4.35, 0, [0.6, -0.6, 0.45, 0.75]);
  await picker.locator('.op-card').first().waitFor();
  await page.screenshot({ path: path.join(shots, 'picker-empty.png') });
  await picker.getByRole('searchbox', { name: 'Hledat kartu' }).fill(lensCard.name.split(/\s+/)[0]);
  await picker.locator(`.op-card[data-card="${lensCard.id}"]`).click();
  await picker.locator('.oc-brief').waitFor({ timeout: 60000 });
  assert.match(await picker.locator('.oc-brief').innerText(), /DATA, not instructions/);
  await page.screenshot({ path: path.join(shots, 'picker-picked.png') });
  await page.keyboard.press('Escape');
  await backToMouseLook(picker);

  // The purple board's ledge: Lens (návrh 1) for the picked card.
  const detail = await useAt('Detail karty pro orchestrátora', 4.0, 5.5, Math.PI / 2, [-0.9, 0.9, -0.7, -1.1]);
  await detail.getByRole('tab', { name: 'Lens (návrh 1)' }).click();
  await detail.locator('.pw-sec.lens .lens-body').waitFor();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(shots, 'detail-lens.png') });
  const flow = detail.getByRole('button', { name: 'Projít tok' });
  if (await flow.count()) { await flow.first().click(); await page.waitForTimeout(600); await page.screenshot({ path: path.join(shots, 'detail-lens-flow.png') }); await page.keyboard.press('Escape'); }
  await detail.getByRole('tab', { name: 'Design karta (návrh 2)' }).click();
  await detail.locator('.oc-rail.na').waitFor();
  await page.screenshot({ path: path.join(shots, 'detail-design-not-applicable.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await backToMouseLook(detail);

  // A design card: picked at the right board, its seven stages on the purple board.
  const picker2 = await useAt('Karta pro orchestrátora', 5, 4.35, 0, [0.6, -0.6, 0.45, 0.75]);
  await picker2.locator(`.op-card[data-card="${designCard}"]`).click();
  await page.waitForFunction((id) => window.__office.store.orchestrator.focus?.cardId === id, designCard);
  await page.keyboard.press('Escape');
  await backToMouseLook(picker2);
  const detail2 = await useAt('Detail karty pro orchestrátora', 4.0, 5.5, Math.PI / 2, [-0.9, 0.9, -0.7, -1.1]);
  await detail2.locator('.oc-seg.cur').waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, 'detail-design-review.png') });
  await detail2.locator('.oc-seg', { hasText: 'Návrh / skica' }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(shots, 'detail-design-sketch.png') });
  await page.keyboard.press('Escape');
  await backToMouseLook(detail2);

  // 3D again: both faces with the card on them, from the room and up close.
  await stand(6.9, 7.3, Math.PI / 4, 0.08);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(shots, '3d-room-after.png') });
  await stand(5, 6.2, 0, 0.18);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, '3d-right-board.png') });
  await stand(5.3, 5.5, Math.PI / 2, -0.22);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, '3d-purple-board.png') });

  assert.deepEqual(errors, []);
  console.log('ok: shots in', shots);
} finally {
  await browser.close();
}

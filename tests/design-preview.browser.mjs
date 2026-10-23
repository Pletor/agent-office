// Against an isolated production preview only (no real Opora): "Jak to bude vypadat" in the process
// wall's card inspector, with /api/opora-preview and its file route answered from fixtures. Run a built
// office with a temporary project and DP_PASSWORD on port 4692, then:
//   node --import tsx tests/design-preview.browser.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

const base = process.env.DP_OFFICE_URL ?? 'http://127.0.0.1:4692';
const shots = process.env.DP_SHOTS ?? path.join(os.tmpdir(), 'design-preview-shots');
await mkdir(shots, { recursive: true });

// A hand-drawn wireframe as Opora's layout-preview gives it, with a script that must never run.
const sketchSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="380" viewBox="0 0 300 380"><script>parent.__svgRan = 1</script>
<rect x="1" y="1" width="298" height="378" rx="14" fill="#fffef9" stroke="#3b3b3b" stroke-width="2"/>
<text x="16" y="38" font-family="Comic Sans MS, cursive" font-size="24" fill="#3b3b3b">Košík (3)</text><line x1="14" y1="50" x2="286" y2="50" stroke="#3b3b3b" stroke-dasharray="6 4" stroke-width="2"/>
${[0, 1, 2].map((i) => `<rect x="16" y="${66 + i * 56}" width="44" height="44" rx="6" fill="none" stroke="#3b3b3b" stroke-width="2"/><rect x="72" y="${80 + i * 56}" width="120" height="9" rx="4" fill="#cfcfcf"/><text x="230" y="${94 + i * 56}" font-family="Comic Sans MS, cursive" font-size="18" fill="#3b3b3b">${['1290', '390', '249'][i]},-</text>`).join('')}
<line x1="14" y1="280" x2="286" y2="280" stroke="#3b3b3b" stroke-dasharray="6 4" stroke-width="2"/><text x="16" y="306" font-family="Comic Sans MS, cursive" font-size="20" fill="#3b3b3b">Celkem</text><text x="210" y="306" font-family="Comic Sans MS, cursive" font-size="20" fill="#3b3b3b">1929,-</text>
<rect x="16" y="322" width="268" height="42" rx="12" fill="none" stroke="#3b3b3b" stroke-width="2.5"/><text x="60" y="350" font-family="Comic Sans MS, cursive" font-size="20" fill="#3b3b3b">Pokračovat k platbě →</text></svg>`;

const screen = (alt) => `<!doctype html><meta charset="utf-8"><body style="margin:0;width:300px;height:380px;font-family:${alt ? "'Space Grotesk',system-ui" : "'Nunito',system-ui"};background:${alt ? '#f3f0ff' : '#fff'};color:${alt ? '#1d1a3a' : '#1f2230'}">
<div style="padding:14px;display:grid;gap:10px;height:380px;box-sizing:border-box;grid-template-rows:auto 1fr auto auto">
<div style="display:flex;justify-content:space-between;align-items:baseline;font-size:18px;font-weight:900">Košík <small style="font-size:11px;color:#6b6f80">3 položky</small></div>
<div style="display:grid;gap:8px;align-content:start">${[['Lněná košile', '1 290 Kč'], ['Plátěná taška', '390 Kč'], ['Ponožky 3 páry', '249 Kč']].map(([n, p]) => `<div style="display:grid;grid-template-columns:44px 1fr auto;gap:10px;align-items:center"><span style="width:44px;height:44px;border-radius:${alt ? 2 : 10}px;background:${alt ? '#e4ddff' : '#efe9df'}"></span><b style="font-size:13px">${n}</b><b style="font-size:13px">${p}</b></div>`).join('')}</div>
<div style="display:flex;justify-content:space-between;border-top:1px solid #ece7df;padding-top:10px;font-weight:800;color:#6b6f80">Celkem <b style="font-size:20px;color:inherit">1 929 Kč</b></div>
<div style="border-radius:${alt ? 2 : 12}px;padding:11px;text-align:center;font-weight:900;background:${alt ? '#5b3df5' : '#1f2230'};color:#fff">Pokračovat k platbě</div></div></body>`;

const SHA = '5f935f2' + 'a'.repeat(33), OLD = 'a1c09e2' + 'b'.repeat(33), MD = 'c'.repeat(64);
const id = (n) => 'preview_' + String(n).repeat(64).slice(0, 64);
const brandDs = { available: true, revision: 'abc1234def', sha256: MD, brand: { fonts: ['Nunito'], colors: [{ hex: '#1f2230', name: 'ink' }, { hex: '#ffffff', name: 'plocha' }, { hex: '#ff8a5b', name: 'akcent' }, { hex: '#e3f6ee', name: 'úspěch' }, { hex: '#6b6f80', name: 'tlumená' }] } };
const shotsOf = (n) => [
  { label: 'mobil světlý', width: 390, height: 844, stage: 'kontroly', file: id(n) },
  { label: 'mobil tmavý', width: 390, height: 844, stage: 'kontroly', file: id(n + 1) },
  { label: '<img src=x onerror=alert(1)>', width: 1440, height: 900, file: id(n + 2) },
];
const replies = {
  'card-brand': { linked: true, base: 'http://127.0.0.1:8740', nodeId: 'card-brand', state: 'ok', mode: 'brand', designSystem: brandDs, sketch: true,
    drawing: { elements: 12 }, storyboard: { moments: 4, sketches: 4 }, heads: [{ prNumber: 128, headSha: SHA, prState: 'open', current: true, mode: 'brand', designMdSha256: MD, shots: shotsOf(1) }] },
  'card-explore': { linked: true, base: 'http://127.0.0.1:8740', nodeId: 'card-explore', state: 'ok', mode: 'explore', designSystem: brandDs, sketch: true, drawing: { elements: 12 },
    heads: [
      { prNumber: 128, headSha: SHA, current: true, mode: 'explore', proposed: { fonts: ['Space Grotesk'], colors: [{ hex: '#1d1a3a' }, { hex: '#f3f0ff' }, { hex: '#5b3df5' }, { hex: '#d9f99d' }, { hex: '#6c6890' }] }, shots: shotsOf(4).map((s) => ({ ...s })) },
      { prNumber: 128, headSha: OLD, current: false, mode: 'brand', designMdSha256: MD, shots: shotsOf(1) },
    ] },
  'card-missing': { linked: true, base: 'http://127.0.0.1:8740', nodeId: 'card-missing', state: 'missing', mode: 'brand', sketch: false, heads: [] },
};
const altFiles = new Set(shotsOf(4).map((s) => s.file));

const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
try {
  // The screenshots the fixture serves: two small pages, one in the brand and one in the new direction.
  const maker = await browser.newPage({ viewport: { width: 300, height: 380 } });
  const png = {};
  for (const alt of [false, true]) { await maker.setContent(screen(alt)); png[alt] = await maker.screenshot(); }
  await maker.close();

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  assert.equal((await context.request.post(base + '/api/login', { data: { password: process.env.DP_PASSWORD ?? 'dp-preview' } })).status(), 200);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  let dialogs = 0; page.on('dialog', (d) => { dialogs++; void d.dismiss(); });
  const asked = new Set();
  await page.route('**/api/opora-preview?*', async (route) => {
    const card = new URL(route.request().url()).searchParams.get('card');
    asked.add(card);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(replies[card]) });
  });
  await page.route('**/api/opora-preview/file?*', async (route) => {
    const q = new URL(route.request().url()).searchParams;
    if (q.get('kind') === 'sketch') return route.fulfill({ contentType: 'image/svg+xml', body: sketchSvg });
    await route.fulfill({ contentType: 'image/png', body: png[altFiles.has(q.get('file'))] });
  });
  await page.goto(base + '/?3d');
  await page.getByRole('button', { name: /Enter the office/ }).click({ timeout: 30000 });
  await page.waitForFunction(() => window.__office?.store.floor);
  await page.waitForTimeout(1000);
  // Three design cards and one developer card, each with one process event (fixtures, only in this page's store).
  const inject = () => page.evaluate(() => {
    const s = window.__office.store;
    const card = (id, name, group, stage) => ({ id, name, status: 'claimed', group, profile: group === 'design' ? 'design' : 'code', stage });
    s.opora.cards = [card('card-brand', 'Souhrn košíku (brand)', 'design', 'Shoda s návrhem'), card('card-explore', 'Souhrn košíku (nový směr)', 'design', 'Shoda s návrhem'),
      card('card-missing', 'Design bez Opory', 'design', 'Návrh a UI'), card('card-dev', 'Vývojová karta', 'dev', 'Implementace')];
    const ev = (n, cardId, phase) => ({ schema: 'opora.process-event/1', id: `fixture:${n}`, seq: n, at: new Date(Date.now() - n * 1000).toISOString(), source: 'opora', kind: 'pr.opened', phase, state: 'ok',
      title: `PR pro ${cardId}`, actor: { kind: 'agent', name: 'designer' }, refs: { cardId, pr: 128, branch: `opora/${cardId}` } });
    s.process.events = [...s.process.events.filter((e) => !String(e.id).startsWith('fixture:')), ev(1, 'card-brand', 'review'), ev(2, 'card-explore', 'review'), ev(3, 'card-missing', 'work'), ev(4, 'card-dev', 'work')];
    s.emit('process');
  });
  await inject();
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
  const pick = async (card) => { await inject(); await page.locator('.pw-row', { hasText: card }).first().click(); };
  // The section scrolls inside the window; for a picture of all of it, a still copy goes on top of the page for a moment.
  const shoot = async (locator, name, width) => {
    const box = await locator.evaluate((el, width) => {
      const copy = el.cloneNode(true);
      copy.querySelectorAll('input').forEach((i, k) => { i.value = el.querySelectorAll('input')[k].value; });
      const host = document.createElement('div');
      host.id = 'dp-shot';
      host.className = 'pw-modal';
      host.style.cssText = `position:fixed;inset:0 auto auto 0;z-index:2147483647;width:${width ?? el.getBoundingClientRect().width + 28}px;height:auto;max-height:none;overflow:visible;background:#fff;padding:14px;border-radius:0;box-shadow:none`;
      host.append(copy);
      document.body.append(host);
      return host.getBoundingClientRect().height;
    }, width);
    const was = page.viewportSize();
    await page.setViewportSize({ width: was.width, height: Math.max(was.height, Math.ceil(box) + 4) });
    await page.waitForTimeout(250);
    await page.locator('#dp-shot').screenshot({ path: path.join(shots, name) });
    await page.evaluate(() => document.getElementById('dp-shot')?.remove());
    await page.setViewportSize(was);
  };
  const backToMouseLook = async () => {
    await page.waitForFunction(() => !!document.pointerLockElement);
    assert.equal(await dialog.count(), 0);
  };
  const dp = page.locator('.pw-sec.dp');

  await openWall();
  // A developer card gets no section.
  await pick('Vývojová karta');
  await page.locator('.pw-insp h3', { hasText: 'Vývojová karta' }).waitFor();
  assert.equal(await dp.count(), 0, 'nothing for a developer card');
  assert.ok(!asked.has('card-dev'));

  // Brand card at Review: mode, brand panel, seven dots, sketch × screenshot slider, evidence.
  await pick('Souhrn košíku (brand)');
  await dp.locator('.dp-ba').waitFor();
  assert.equal(await dp.getByRole('link', { name: /Otevřít v Opoře/ }).getAttribute('href'), 'http://127.0.0.1:8740/?ohCard=card-brand&ohTab=preview');
  assert.equal(await dp.locator('.dp-m.on').innerText(), 'Podle brandu');
  assert.equal(await dp.locator('.dp-mode button').count(), 0, 'the mode is read-only here');
  assert.equal(await dp.locator('.dp-sq').count(), 5);
  assert.match(await dp.locator('.dp-rev').innerText(), /DESIGN\.md · rev abc1234/);
  assert.equal(await dp.locator('.dp-trk .dp-st').count(), 7);
  assert.equal(await dp.locator('.dp-trk .dp-st[aria-current="step"] .lb').innerText(), 'Review');
  assert.match(await dp.locator('.dp-pv-h .src').innerText(), /skica × screenshot/);
  assert.equal(await dp.locator('svg').count(), 0, 'the sketch is an <img>, never inline SVG');
  await dp.locator('.dp-ba img').first().evaluate((i) => i.decode());
  const ev = (await dp.locator('.dp-ev').innerText()).replace(/\s+/g, ' ');
  assert.match(ev, /Skica 12 prvků[\s\S]*Storyboard 4 momentů[\s\S]*Kód existuje PR #128[\s\S]*Screenshoty 3 · 5f935f2[\s\S]*Soulad s brandem podle DESIGN\.md/);
  // The slider moves the cut.
  const range = dp.locator('.dp-ba input[type=range]');
  await range.fill('20');
  assert.equal(await dp.locator('.dp-ba').evaluate((el) => el.style.getPropertyValue('--cut')), '20%');
  await range.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await range.inputValue(), '21');
  assert.equal(await dialog.count(), 1, 'arrow keys on the slider leave the window open');
  await range.fill('50');
  await shoot(dp, 'review-brand.png', 360);

  // An earlier stage: the screenshots of Kontroly, the untrusted label as text.
  await dp.getByRole('button', { name: /Kontroly/ }).click();
  await dp.locator('.dp-grid .dp-fr').first().waitFor();
  assert.equal(await dp.locator('.dp-grid .dp-fr').count(), 3);
  assert.ok(await dp.getByText('<img src=x onerror=alert(1)> · 1440×900').count());
  await shoot(dp, 'kontroly-brand.png', 360);
  await dp.getByRole('button', { name: /Review/ }).click();
  await dp.locator('.dp-ba').waitFor();

  // Explore card: "Nový směr", now and proposal rows, brand × nový směr.
  await pick('Souhrn košíku (nový směr)');
  await dp.locator('.dp-m.on', { hasText: 'Nový směr' }).waitFor();
  await dp.locator('.dp-ba').waitFor();
  assert.equal(await dp.locator('.dp-pv-h .src').innerText(), 'brand × nový směr');
  assert.deepEqual(await dp.locator('.dp-tg').allInnerTexts(), ['současný brand', 'nový směr']);
  assert.deepEqual(await dp.locator('.dp-br .lab').allInnerTexts(), ['TEĎ', 'NÁVRH']);
  assert.match((await dp.locator('.dp-ev').innerText()).replace(/\s+/g, ' '), /Nový směr návrh DESIGN\.md/);
  await page.waitForTimeout(300);
  await shoot(dp, 'review-novy-smer.png', 360);

  // Opora without the endpoint: a calm note, the stage from the lane.
  await pick('Design bez Opory');
  await dp.locator('.dp-calm').waitFor();
  assert.match(await dp.locator('.dp-calm').innerText(), /Náhled zatím není k dispozici/);
  assert.equal(await dp.locator('.dp-trk .dp-st[aria-current="step"] .lb').innerText(), 'Kód');
  await shoot(dp, 'missing.png', 360);

  // Esc closes the window straight back to mouse-look.
  await page.keyboard.press('Escape');
  await backToMouseLook();

  // Reduced motion: no ring, no pop.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openWall();
  await pick('Souhrn košíku (brand)');
  await dp.locator('.dp-ba').waitFor();
  assert.equal(await dp.locator('.dp-pv-b').evaluate((el) => getComputedStyle(el).animationName), 'none');
  assert.equal(await dp.locator('.dp-trk .dp-st.cur .dot').evaluate((el) => getComputedStyle(el, '::after').animationName), 'none');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await backToMouseLook();
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  for (const width of [390, 300]) {
    await page.setViewportSize({ width, height: 860 });
    await openWall();
    await pick('Souhrn košíku (nový směr)');
    await dp.locator('.dp-ba').waitFor();
    await page.waitForTimeout(300);
    const over = await page.evaluate(() => {
      const sec = document.querySelector('.pw-sec.dp');
      const box = sec.closest('.pw-scroll');
      return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, box: box.scrollWidth - box.clientWidth, sec: sec.scrollWidth - sec.clientWidth, w: sec.clientWidth };
    });
    assert.ok(over.doc <= 0 && over.box <= 0 && over.sec <= 0, `no horizontal scroll at ${width} px: ${JSON.stringify(over)}`);
    console.log(`viewport ${width}: section ${over.w} px`);
    await shoot(dp, `mobil-${width}-novy-smer.png`);
    // ✕ closes it straight back to mouse-look.
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await backToMouseLook();
  }
  assert.equal(await page.evaluate(() => window.__svgRan), undefined, 'the sketch SVG ran no script');
  assert.equal(dialogs, 0);
  assert.deepEqual(errors, []);
  console.log('ok', shots);
} finally {
  await browser.close();
}

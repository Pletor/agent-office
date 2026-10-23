// Against an isolated production preview only (no real Opora): the Lens diagram in the process
// wall's card inspector, with /api/opora-lens answered from fixture specs. Run a built office with a
// temporary project and LENS_PASSWORD on port 4691, then: node --import tsx tests/lens-window.browser.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

const base = process.env.LENS_OFFICE_URL ?? 'http://127.0.0.1:4691';
const shots = process.env.LENS_SHOTS ?? path.join(os.tmpdir(), 'lens-window-shots');
await mkdir(shots, { recursive: true });
const spec = {
  kind: 'graph', title: 'Lens v okně Živý proces', summary: 'Inspektor karty čte PR Lens z Opory přes kancelář a kreslí ho jako diagram toku.',
  lanes: [{ id: 'client', label: 'Prohlížeč', delta: 'added' }, { id: 'server', label: 'Server kanceláře' }, { id: 'opora', label: 'Opora' }],
  nodes: [
    { id: 'insp', label: 'renderInspector', kind: 'ui', delta: 'modified', lane: 'client', summary: 'Inspektor karty; drží sekci Lens.', files: [{ path: 'src/client/features/process-wall/inspector.ts', startLine: 8, endLine: 13 }] },
    { id: 'section', label: 'LensSection', kind: 'ui', delta: 'added', lane: 'client', files: [{ path: 'src/client/features/lens/ui.ts', startLine: 1, endLine: 120 }], badges: ['30 s'] },
    { id: 'diagram', label: '<img src=x onerror=alert(1)>', kind: 'ui', delta: 'added', lane: 'client', summary: 'Spec je text, nikdy markup.', files: [{ path: 'src/client/features/lens/diagram.ts' }] },
    { id: 'route', label: 'GET /api/opora-lens', kind: 'route', delta: 'added', lane: 'server', files: [{ path: 'src/server/http/routes/opora-lens.ts' }] },
    { id: 'floors', label: 'FloorLinks', kind: 'store', delta: 'unchanged', lane: 'server' },
    { id: 'reader', label: 'LensReader', kind: 'service', delta: 'added', lane: 'server', files: [{ path: 'src/server/opora/lens-reader.ts' }], badges: ['cache', 'read-only'] },
    { id: 'clean', label: 'lensGraph()', kind: 'function', delta: 'added', lane: 'server', files: [{ path: 'src/shared/opora-lens.ts', startLine: 70, endLine: 118 }] },
    { id: 'review', label: 'GET /review-lens', kind: 'external', delta: 'unchanged', lane: 'opora' },
    { id: 'plan', label: 'GET /plan-lens', kind: 'external', delta: 'unchanged', lane: 'opora' },
  ],
  edges: [
    { id: 'e1', from: 'insp', to: 'section', kind: 'call', delta: 'added', label: 'otevře sekci' },
    { id: 'e2', from: 'section', to: 'route', kind: 'http', delta: 'added', emphasis: 'hero', label: 'fetch ?floor&card' },
    { id: 'e3', from: 'route', to: 'floors', kind: 'read', delta: 'unchanged', label: 'najde projekt' },
    { id: 'e4', from: 'route', to: 'reader', kind: 'call', delta: 'added', label: 'čte Lens' },
    { id: 'e5', from: 'reader', to: 'review', kind: 'http', delta: 'added', emphasis: 'hero', label: 'PR + mapa' },
    { id: 'e6', from: 'reader', to: 'plan', kind: 'http', delta: 'added', label: 'plán oblasti' },
    { id: 'e7', from: 'reader', to: 'clean', kind: 'call', delta: 'added', label: 'ořízne spec' },
    { id: 'e8', from: 'route', to: 'section', kind: 'http', delta: 'added', emphasis: 'hero', label: 'OporaLensReply' },
    { id: 'e9', from: 'section', to: 'diagram', kind: 'call', delta: 'added', label: 'nakreslí' },
    { id: 'k1', from: 'diagram', to: 'clean', kind: 'dependency', delta: 'unchanged', emphasis: 'muted', label: 'kód' },
  ],
  flows: [
    { id: 'f1', title: 'Otevření karty', steps: [
      { from: 'insp', to: 'section', label: 'člověk klikne na kartu, inspektor otevře sekci Lens' },
      { from: 'section', to: 'route', label: 'sekce se zeptá kanceláře' },
      { from: 'route', to: 'floors', label: 'kancelář najde projekt Opory pro patro' },
      { from: 'route', to: 'reader', label: 'předá čtení Lens' },
      { from: 'reader', to: 'review', label: 'stáhne nejnovější PR Lens' },
      { from: 'route', to: 'section', label: 'vrátí OporaLensReply' },
    ] },
    { id: 'f2', title: 'Plán oblasti', messages: [{ from: 'section', to: 'route', label: 'záložka se zeptá' }, { from: 'reader', to: 'plan', label: 'čte plán oblasti' }] },
  ],
};
// The plan Lens as Opora's plan_lens builds it: lanes by layer, `plán`/`hotovo` badges, Graphify edges muted with label "kód".
const planSpec = {
  kind: 'graph', title: 'Oblast Živý proces', summary: 'Plán z plátna bez modelu: 1 oblastí, 6 karet, 4 s kódem v main, 2 jen v plánu.',
  lanes: [{ id: 'frontend', label: 'Frontend' }, { id: 'backend', label: 'Backend' }, { id: 'okoli', label: 'Sousední oblasti' }],
  nodes: [
    { id: 'card:map', label: 'Mapa toku', kind: 'ui', delta: 'unchanged', lane: 'frontend', files: [{ path: 'src/client/features/process-wall/flow.ts' }], badges: ['hotovo'] },
    { id: 'card:insp', label: 'Inspektor karty', kind: 'ui', delta: 'unchanged', lane: 'frontend', files: [{ path: 'src/client/features/process-wall/inspector.ts' }], badges: ['hotovo'] },
    { id: 'card:lens', label: 'Lens diagram', kind: 'ui', delta: 'added', lane: 'frontend', files: [], badges: ['plán'] },
    { id: 'card:stream', label: 'Proud událostí', kind: 'module', delta: 'unchanged', lane: 'backend', files: [{ path: 'src/server/process/stream.ts' }], badges: [] },
    { id: 'card:api', label: 'GET /api/opora-lens', kind: 'module', delta: 'unchanged', lane: 'backend', files: [{ path: 'src/server/http/routes/opora-lens.ts' }], badges: [] },
    { id: 'card:outbox', label: 'Outbox událostí', kind: 'module', delta: 'added', lane: 'backend', files: [], badges: ['plán'] },
    { id: 'soused:hub', label: 'OporaHub', kind: 'external', delta: 'unchanged', lane: 'okoli', subtitle: 'sousední oblast' },
  ],
  edges: [
    { id: 'edge:1', from: 'card:stream', to: 'card:map', kind: 'call', delta: 'unchanged', label: 'události' },
    { id: 'edge:2', from: 'card:insp', to: 'card:lens', kind: 'call', delta: 'added' },
    { id: 'edge:3', from: 'card:stream', to: 'card:outbox', kind: 'dependency', delta: 'added', label: 'zapíše' },
    { id: 'hranice:1', from: 'card:outbox', to: 'soused:hub', kind: 'data', delta: 'added', label: 'doručí' },
    { id: 'kod:1', from: 'card:insp', to: 'card:api', kind: 'dependency', delta: 'unchanged', label: 'kód', emphasis: 'muted' },
  ],
};
const reply = { linked: true, base: 'http://127.0.0.1:8740', nodeId: 'card-lens', card: { state: 'ok' }, plan: { state: 'ok', area: 'zivy-proces', digest: 'f'.repeat(64) } };
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  assert.equal((await context.request.post(base + '/api/login', { data: { password: process.env.LENS_PASSWORD ?? 'lens-preview' } })).status(), 200);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  let dialogs = 0; page.on('dialog', (d) => { dialogs++; void d.dismiss(); });
  const { lensGraph } = await import('../src/shared/opora-lens.ts');
  const { confirmedCards } = await import('../src/server/opora/lens-reader.ts');
  reply.card.pr = { graph: lensGraph(spec), number: 54, prState: 'open', current: true, by: 'office-lens' };
  reply.card.area = { graph: null, note: 'Opora nemá specifikaci diagramu.' };
  reply.plan.view = { graph: lensGraph(planSpec) };
  reply.plan.stats = { areas: 1, cards: 6, withCode: 4, planned: 2, standalone: 0, unassigned: 0, confirmed: confirmedCards(planSpec) };
  reply.plan.graphify = { available: true, sourceRevision: 'a1b2c3d4e5f6a7b8' };
  let asked = 0;
  await page.route('**/api/opora-lens?*', async (route) => {
    asked++;
    assert.equal(new URL(route.request().url()).searchParams.get('card'), 'card-lens');
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
      title: 'PR Lens pro #54 odeslán do Opory', actor: { kind: 'agent', name: 'office-lens' }, refs: { cardId: 'card-lens', pr: 54, branch: 'feat/lens-window' } }];
    s.emit('process');
  });
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
  // The section scrolls inside the window; for a picture of all of it, a still copy goes on top of the page for a moment.
  const shoot = async (locator, name) => {
    const box = await locator.evaluate((el) => {
      const copy = el.cloneNode(true);
      const w = el.getBoundingClientRect().width;
      const host = document.createElement('div');
      host.id = 'lens-shot';
      host.className = 'pw-insp';
      host.style.cssText = `position:fixed;inset:0 auto auto 0;z-index:2147483647;width:${w + 24}px;max-height:none;overflow:visible;background:#fff;padding:12px`;
      host.append(copy);
      document.body.append(host);
      const r = host.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    const was = page.viewportSize();
    await page.setViewportSize({ width: was.width, height: Math.max(was.height, Math.ceil(box.height) + 4) });
    await page.locator('#lens-shot').screenshot({ path: path.join(shots, name) });
    await page.evaluate(() => document.getElementById('lens-shot')?.remove());
    await page.setViewportSize(was);
    await page.waitForTimeout(200);
  };
  const backToMouseLook = async () => {
    await page.waitForFunction(() => !!document.pointerLockElement);
    assert.equal(await page.getByRole('dialog', { name: 'Živý proces' }).count(), 0);
  };
  await openWall();
  await page.locator('.pw-row', { hasText: 'card-lens' }).first().click().catch(() => undefined);
  const lens = page.locator('.pw-sec.lens');
  await lens.locator('.lx-dg .lx-card').first().waitFor();
  assert.ok(asked >= 1);
  assert.equal(await page.getByRole('link', { name: /Otevřít v Opoře/ }).getAttribute('href'), 'http://127.0.0.1:8740/?ohCard=card-lens&ohTab=lens');
  // The diagram: every card a button, edges in one SVG, the untrusted label as text.
  assert.equal(await lens.locator('.lx-card').count(), 9);
  assert.equal(await lens.locator('.lx-svg .lx-e').count(), 9, 'the code edge is behind its switch');
  assert.equal(await lens.locator('.lx-dg img').count(), 0);
  assert.ok(await lens.getByText('<img src=x onerror=alert(1)>').count());
  await lens.getByRole('switch', { name: 'Vazby z kódu' }).click();
  assert.equal(await lens.locator('.lx-svg .lx-e').count(), 10);
  assert.equal(await lens.getByRole('switch', { name: 'Vazby z kódu' }).getAttribute('aria-checked'), 'true');
  await lens.getByRole('switch', { name: 'Vazby z kódu' }).click();
  await lens.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, 'lens-window.png') });

  // Popover: files with line ranges, in/out edges, ✕ top right; Esc closes only it and gives focus back.
  await lens.locator('.lx-card', { hasText: 'renderInspector' }).click();
  const pop = lens.getByRole('dialog', { name: 'renderInspector' });
  await pop.waitFor();
  assert.match(await pop.innerText(), /inspector\.ts[\s\S]*8–13/);
  assert.match(await pop.innerText(), /Výstupy · 1[\s\S]*LensSection/i);
  await shoot(lens, 'lens-popover.png');
  await page.keyboard.press('Escape');
  assert.equal(await lens.locator('.lx-pop').count(), 0);
  assert.equal(await dialog.count(), 1, 'Esc closed only the popover');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.includes('renderInspector')), true, 'focus back on the card');

  // Playback: n/N, caption, steps, a dot on the active edge, arrows, Esc ends it and not the window.
  await lens.getByRole('button', { name: 'Projít tok' }).click();
  const bar = lens.getByRole('region', { name: 'Procházení toku' });
  await bar.waitFor();
  assert.match(await bar.innerText(), /1 \/ 6/);
  await bar.getByRole('button', { name: /Další/ }).click();
  await page.keyboard.press('ArrowRight');
  assert.match(await bar.innerText(), /3 \/ 6[\s\S]*najde projekt Opory/);
  assert.equal(await lens.locator('.lx-svg .lx-e.cur').count(), 1);
  await page.waitForTimeout(700);
  assert.equal(await lens.locator('.lx-dot').getAttribute('visibility'), 'visible');
  await page.keyboard.press('ArrowLeft');
  assert.match(await bar.innerText(), /2 \/ 6/);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(400);
  await shoot(lens, 'lens-playback.png');
  await page.keyboard.press('Escape');
  assert.equal(await bar.count(), 0);
  assert.equal(await dialog.count(), 1, 'Esc ended only the playback');

  // Plan tab: progress in the evidence Opora has, the claimed level not measured yet.
  await page.getByRole('tab', { name: 'Plán oblasti' }).click();
  const prog = lens.locator('.lx-prog');
  await prog.waitFor();
  const progText = await prog.innerText();
  assert.match(progText, /Kód existuje[\s\S]*4\/6[\s\S]*67 %/);
  assert.match(progText, /Potvrzeno člověkem[\s\S]*2\/6[\s\S]*33 %/);
  assert.match(progText, /Agent tvrdí[\s\S]*zatím neměřeno/);
  assert.equal(await lens.locator('.lx-card.s-plan').count(), 2);
  assert.equal(await lens.locator('.lx-svg .lx-e.m-code').count(), 1, 'code edges shown on the plan by default');
  await shoot(lens, 'lens-plan.png');

  // Esc with nothing open in the Lens: the window closes, straight back to mouse-look.
  await page.keyboard.press('Escape');
  await backToMouseLook();

  for (const width of [480, 300]) {
    await page.setViewportSize({ width, height: 860 });
    await openWall();
    await page.getByRole('tab', { name: 'Změna (PR)' }).dispatchEvent('click');
    await lens.locator('.lx-card').first().waitFor();
    await page.waitForTimeout(300);
    const over = await page.evaluate(() => {
      const box = document.querySelector('.pw-sec.lens').closest('.pw-scroll');
      const lx = document.querySelector('.pw-sec.lens .lx');
      return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, box: box.scrollWidth - box.clientWidth, lx: lx.scrollWidth - lx.clientWidth, w: lx.clientWidth };
    });
    assert.ok(over.doc <= 0 && over.box <= 0 && over.lx <= 0, `no horizontal scroll at ${width} px: ${JSON.stringify(over)}`);
    await shoot(lens, width === 480 ? 'lens-pr-420.png' : 'lens-300.png');
    console.log(`viewport ${width}: diagram ${over.w} px`);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await backToMouseLook();
  }
  assert.equal(dialogs, 0);
  assert.deepEqual(errors, []);
  console.log('ok', shots);
} finally {
  await browser.close();
}

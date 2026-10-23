// The planning room's third screen (🧭 Relace k cíli) in a real browser: its face on the south glass, the
// full window (E), a session's detail, the orchestrator's card coming up top, a sub-session reporting up and
// a checklist item ticking off, and Esc / ✕ putting you straight back into mouse-look. Run a built office
// with a temporary project and SESSIONS_PASSWORD on port 4697; then:
//   node --import tsx tests/sessions.browser.mjs
// The office has no live workers in a test, so this page's store gets the prototype's 20 sessions (the
// design's example data, "Tajemství opory"), in the shapes the server sends: workers, sessions read off
// transcripts, Opora cards and runs, pull requests, limits and the journal. Optionally DESIGN_URL: the
// prototype's rendered page, shot at the same size for a side-by-side.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

const base = process.env.SESSIONS_OFFICE_URL ?? 'http://127.0.0.1:4697';
const shots = process.env.SESSIONS_SHOTS ?? path.join(os.tmpdir(), 'third-screen-shots');
await mkdir(shots, { recursive: true });

/** The prototype's example (relace.js): 20 sessions on the floor of Tajemství opory. */
function fixture(now, desks) {
  const C = [
    ['C1', 'Na míru – formulář věštby', 'Oracle › Na míru', 'claimed'], ['C2', 'Na míru – vzhled obrazovky', 'Oracle › Na míru · design', 'closed'],
    ['C3', 'Prorok – výsledek věštby', 'Oracle › Prorok', 'claimed'], ['C4', 'Prorok 2 – srovnání dvou věšteb', 'Oracle › Prorok 2', 'blocked'],
    ['C5', 'Mé věštby – seznam a filtr', 'Oracle › Mé věštby', 'claimed'], ['C6', 'Dashboard – přehled dne', 'Aplikace › Dashboard', 'claimed'],
    ['C7', 'Chat – streamování odpovědí', 'Aplikace › Chat', 'claimed'], ['C8', 'DNA Profil – export PDF', 'Aplikace › DNA Profil', 'waiting'],
    ['C9', 'Nastavení – předplatné', 'Aplikace › Nastavení', 'claimed'], ['C10', 'Vstup – přihlášení odkazem', 'Aplikace › Vstup', 'closed'],
    ['C11', 'Volný režim – úpravy', 'Oracle › Volný režim', 'frontier'],
  ];
  const cards = C.map(([id, name, sector, status]) => ({ id, name, sectorName: sector, sectorId: `sec-${id}`, status, group: /design/.test(sector) ? 'design' : 'dev', profile: 'code', stage: status === 'closed' ? 'Hotovo' : 'Implementace', ready: status === 'frontier' }));
  const S = [
    { id: 's18', n: 'Adam', c: '#9b5de5', card: 'ctrl', st: 'run', task: 'Rozplánovat Prorok 2', sum: 'Píše kroky karty a závislosti na Proroku', last: '🧭 Navrhuje 4. krok karty Prorok 2', ago: 1, plan: [2, 5], cost: 6.4, tok: 1.9e6, ctx: 61, via: 'planning' },
    { id: 's15', n: 'Uršula', c: '#118ab2', card: 'ctrl', st: 'run', task: 'Hledač: review PR #212', sum: 'Hledá chyby ve formuláři Na míru', last: '📖 Čte diff form.tsx', ago: 1, plan: [1, 3], cost: 0.62, tok: 180e3, ctx: 22, station: 'station-pulls' },
    { id: 's16', n: 'Václav', c: '#073b4c', card: 'ctrl', st: 'done', task: 'Ověřovatel: PR #205', sum: 'Potvrdil vzhled Na míru', last: '✅ Ověřeno, 0 nálezů', ago: 22, plan: [3, 3], cost: 0.41, tok: 96e3, ctx: 14, station: 'station-queue' },
    { id: 's1', n: 'Ema', c: '#ef476f', card: 'C1', st: 'run', task: 'Formulář věštby', sum: 'Validace polí a odeslání na /api/oracle', last: '✏️ Upravuje form.tsx', ago: 0, plan: [4, 7], pr: [212, 'pending', 'draft'], cost: 3.12, tok: 410e3, ctx: 38,
      todo: ['Přečíst kartu a DESIGN.md', 'Schéma formuláře', 'Validace (zod)', 'Napojit /api/oracle', 'Testy formuláře', 'Screenshot na kartě', 'Otevřít PR a předat hledači'],
      kids: [['Průzkum validace (zod vs. vlastní)', 'sub', 'done', 'Hotovo', 'Doporučuje zod, změna ve 3 souborech', 6], ['Testy formuláře', 'sub', 'run', '🧪 vitest form.test.ts', '', 0]] },
    { id: 's13', n: 'Sára', c: '#06a77d', card: 'C1', st: 'run', task: 'Texty formuláře CZ/EN', sum: 'Překlady a chybové hlášky', last: '✏️ Upravuje cs.json', ago: 2, plan: [2, 3], cost: 0.88, tok: 140e3, ctx: 19 },
    { id: 's2', n: 'Filip', c: '#f78c6b', card: 'C2', st: 'done', task: 'Vzhled Na míru', sum: 'Obrazovka podle DESIGN.md', last: '🎉 PR #205 sloučen', ago: 31, plan: [6, 6], pr: [205, 'pass', 'merged'], cost: 2.4, tok: 520e3, ctx: 0, follow: ['Přenést tokeny vzhledu na Prorok', 'Doplnit tmavý motiv Na míru'] },
    { id: 's3', n: 'Hana', c: '#ffbe0b', card: 'C3', st: 'run', task: 'Výsledek věštby', sum: 'Stránka výsledku + API', last: '🧪 npm test (2 padá)', ago: 0, plan: [3, 5], pr: [214, 'pending', 'open'], cost: 4.75, tok: 1.2e6, ctx: 72,
      kids: [['Výklad karet – texty', 'sub', 'done', 'Hotovo', 'Hotovo: 22 výkladů', 4], ['API /prophecy/:id', 'sub', 'run', '✏️ route.ts', '', 1], ['Snapshot testy', 'sub', 'run', '🧪 vitest -u', '', 0]] },
    { id: 's14', n: 'Tomáš', c: '#8338ec', card: 'C3', st: 'sleep', task: 'Animace odhalení karty', sum: 'Proces skončil s chybou', last: '💥 Skončila (kód 1)', ago: 34, plan: [1, 4], cost: 1.2, tok: 260e3, ctx: 0 },
    { id: 's4', n: 'Ivo', c: '#3a86ff', card: 'C4', st: 'run', task: 'Srovnání dvou věšteb', sum: 'Čeká na API z karty Prorok', last: '⏸ Čeká na závislost', ago: 9, plan: [1, 4], cost: 0.7, tok: 120e3, ctx: 17 },
    { id: 's5', n: 'Jana', c: '#fb5607', card: 'C5', st: 'human', task: 'Seznam a filtr', sum: 'Tagy u věšteb + filtr', need: 'Smí spustit migraci DB „add_reading_tags“? · Chce: Bash: npm run db:migrate', last: '❓ Ptá se na povolení', ago: 6, plan: [5, 8], cost: 2.05, tok: 390e3, ctx: 44,
      kids: [['Proč se tagy ukládají jako JSON?', 'btw', 'done', 'Odpovězeno', 'Odpověď v boční záložce', 3]] },
    { id: 's20', n: 'Cyril', c: '#2a9d8f', card: 'C5', st: 'run', task: 'Stránkování seznamu', sum: 'Kurzor místo offsetu', last: '📖 Čte list.tsx', ago: 1, plan: [1, 4], cost: 0.95, tok: 170e3, ctx: 21, kids: [['Najít všechna volání /readings', 'sub', 'done', 'Hotovo', '7 míst ve 4 souborech', 2]] },
    { id: 's6', n: 'Karel', c: '#e76f51', card: 'C6', st: 'run', task: 'Přehled dne – rozvržení', sum: 'Dvě varianty podle DESIGN.md', last: '🎨 Kreslí variantu B', ago: 1, plan: [2, 6], cost: 1.9, tok: 330e3, ctx: 35,
      kids: [['Varianta A – karty', 'sub', 'done', 'Hotovo', 'Náhled A uložen', 5], ['Varianta B – časová osa', 'sub', 'run', '🎨 timeline.html', '', 0]] },
    { id: 's17', n: 'Zdeněk', c: '#6c757d', card: 'C6', st: 'done', task: 'Ikony přehledu', sum: 'Sada 12 ikon', last: '✅ Dokončil tah', ago: 41, plan: [4, 4], cost: 0.8, tok: 150e3, ctx: 0, worktree: true },
    { id: 's7', n: 'Lucie', c: '#d62828', card: 'C7', st: 'run', task: 'Streamování odpovědí', sum: 'SSE z /api/chat', last: '🔁 Testy padají znovu (5×)', ago: 23, failing: true, plan: [2, 6], pr: [218, 'fail', 'open'], cost: 7.9, tok: 2.4e6, ctx: 88,
      kids: [['SSE, nebo WebSocket?', 'btw', 'done', 'Odpovězeno', 'SSE stačí', 30], ['Oprava stream.test.ts', 'sub', 'run', '🔁 stejný test znovu', '', 19]] },
    { id: 's12', n: 'Radek', c: '#264653', card: 'C7', st: 'run', task: 'Měření výkonu streamu', sum: 'Latence prvního tokenu', last: '🌐 Čte dokumentaci SSE', ago: 3, plan: [1, 3], cost: 0.55, tok: 90e3, ctx: 12 },
    { id: 's8', n: 'Marek', c: '#f4a261', card: 'C8', st: 'human', task: 'Export PDF', sum: 'Generování profilu do PDF', need: 'Schválit: export obsahuje osobní data (DNA)', last: '❓ Žádá o schválení', ago: 14, plan: [3, 5], cost: 1.7, tok: 300e3, ctx: 33 },
    { id: 's10', n: 'Oto', c: '#43aa8b', card: 'C10', st: 'done', task: 'Přihlášení odkazem', sum: 'Magic link + e-mail', last: '🎉 PR #209 sloučen', ago: 48, plan: [4, 4], pr: [209, 'pass', 'merged'], cost: 1.95, tok: 410e3, ctx: 0, follow: ['Uklidit worktree office/oto-7f2', 'E2E test přihlášení odkazem'] },
    { id: 's11', n: 'Petra', c: '#ff006e', card: 'off', st: 'run', task: 'Refaktor routeru aplikace', sum: 'Zadáno rovnou do terminálu', last: '✏️ router.ts (14 souborů)', ago: 0, plan: [3, 9], cost: 5.1, tok: 1.1e6, ctx: 57 },
    { id: 's19', n: 'Bedřich', c: '#90be6d', card: 'off', st: 'idle', task: 'Aktualizace závislostí', sum: 'Úkol z fronty bez karty', last: '💤 Čeká na první zadání', ago: 128, plan: [0, 3], cost: 0.02, tok: 3e3, ctx: 1 },
  ];
  const GEN = ['Přečíst kartu', 'Najít dotčené soubory', 'Implementace', 'Testy', 'Typecheck a build', 'Screenshot', 'PR', 'Předat ke kontrole', 'Uklidit worktree'];
  const STATUS = { run: 'working', human: 'needs_input', done: 'done', sleep: 'exited', idle: 'idle' };
  const min = (m) => now - m * 60_000;
  const workers = [], sessions = [], runs = [], pulls = [], events = [];
  let d = 0;
  for (const s of S) {
    const deskId = s.station ?? desks[d++ % desks.length];
    const branch = `office/${s.n.toLowerCase()}-${s.id}`;
    const w = {
      id: s.id, kind: 'agent', provider: 'claude', deskId, name: s.n, color: s.c, status: STATUS[s.st], acked: s.st !== 'human', waitingSince: min(s.ago), createdBy: 'Martin', createdAt: min(s.ago + 60),
      cols: 120, rows: 40, viewers: [], viewerIds: [], activity: s.last, action: s.failing ? 'failing' : undefined, task: { name: s.task, summary: s.sum },
      usage: { input: s.tok, output: 0, cacheWrite: 0, cacheRead: 0, cost: s.cost, calls: 10, model: s.id === 's18' ? 'claude-opus-5-5' : 'claude-sonnet-5' },
      ...(s.card !== 'ctrl' && s.card !== 'off' || s.worktree ? { worktree: { path: `.agent-office/worktrees/${s.n.toLowerCase()}-${s.id}`, branch, base: 'abc' } } : {}),
      ...(s.pr ? { pr: { number: s.pr[0], url: `https://github.com/x/y/pull/${s.pr[0]}` } } : {}), ...(s.via ? { via: s.via } : {}),
    };
    workers.push(w);
    const items = s.todo ?? GEN.slice(0, s.plan[1]);
    sessions.push({
      workerId: s.id, follow: s.follow ?? [], lastAt: min(s.ago), ...(s.need ? { need: s.need } : {}), recap: `${s.sum}.`,
      ...(s.ctx ? { context: { used: s.ctx * 2000, max: 200_000 } } : {}),
      todos: items.map((t, i) => ({ text: t, status: i < s.plan[0] ? 'completed' : i === s.plan[0] && s.st === 'run' ? 'in_progress' : 'pending' })),
      kids: (s.kids ?? []).map(([n, k, st, last, rep, ago], i) => ({ id: `${s.id}-k${i}`, kind: k, name: n, state: st, last, ...(rep ? { report: rep } : {}), startedAt: min(ago + 5), at: min(ago) })),
    });
    if (s.card.startsWith('C')) runs.push({ cardId: s.card, cardName: cards.find((c) => c.id === s.card).name, group: 'dev', workerId: s.id, workerName: s.n, deskId, by: 'Martin', startedAt: min(s.ago + 60), state: s.st === 'done' ? 'done' : 'working' });
    if (s.pr) pulls.push({ number: s.pr[0], url: w.pr.url, checks: s.pr[1], state: s.pr[2] === 'merged' ? 'MERGED' : 'OPEN', isDraft: s.pr[2] === 'draft', headRefName: branch, title: s.task });
    events.push({ schema: 'opora.process-event/1', id: `office:x:${s.id}`, seq: events.length + 1, at: new Date(min(s.ago)).toISOString(), source: 'office', kind: 'tool.use', phase: 'work', state: 'progress', title: `${s.n}: ${s.last}`, refs: { workerId: s.id } });
  }
  // Nela went home while her card's lease still holds.
  runs.push({ cardId: 'C9', cardName: cards.find((c) => c.id === 'C9').name, group: 'dev', workerId: 'gone-nela', workerName: 'Nela', by: 'Martin', startedAt: min(52), state: 'gone', leaseUntil: new Date(now + 15 * 60_000).toISOString() });
  return { workers, sessions, cards, runs, pulls, events };
}

const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
try {
  if (process.env.DESIGN_URL) {
    const d = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await d.goto(process.env.DESIGN_URL, { waitUntil: 'networkidle' });
    await d.locator('#play').click().catch(() => {});
    await d.waitForTimeout(800);
    await d.locator('#screen').screenshot({ path: path.join(shots, 'design-screen.png') });
    await d.locator('.rowwrap[data-id="s1"] .row').click();
    await d.waitForTimeout(400);
    await d.screenshot({ path: path.join(shots, 'design-detail.png') });
    await d.close();
  }

  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  assert.equal((await context.request.post(base + '/api/login', { data: { password: process.env.SESSIONS_PASSWORD ?? 'shots' } })).status(), 200);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/?3d');
  await page.getByRole('button', { name: /Enter the office/ }).click({ timeout: 30000 });
  await page.waitForFunction(() => window.__office?.store.floor);
  await page.waitForFunction(() => !!document.pointerLockElement);

  await page.evaluate(`(${(src) => {
    const s = window.__office.store;
    const desks = [...s.plan().byId.values()].filter((d) => !d.room && !d.station && !d.planner && !d.beanbag).map((d) => d.id);
    const f = (0, eval)(`(${src})`)(Date.now(), desks);
    const apply = () => {
      for (const w of f.workers) s.workers.set(w.id, w);
      s.sessions = { sessions: f.sessions, at: Date.now() };
      s.opora = { ...s.opora, connected: true, project: { id: 'p', name: 'Tajemství opory' }, cards: f.cards, runs: f.runs, workspace: 'draft',
        scope: [{ id: 'env:prod', name: 'Produkce', level: 'env', parentId: null }, { id: 'sec-app', name: 'Aplikace', level: 'domain', parentId: 'env:prod', host: 'app.tajemstviopory' }], focus: ['env:prod', 'sec-app'] };
      s.pulls = { ...s.pulls, items: f.pulls };
      s.process = { ...s.process, events: f.events };
      s.limits = { windows: [{ label: '5h session', pct: 25 }, { label: 'Week', pct: 57 }, { label: 'Fable week', pct: 49 }], at: Date.now() };
      s.usage = { ...s.usage, today: { ...s.usage.today, cost: 41.8 }, budget: 80 };
    };
    window.__fixture = f;
    window.__applyFixture = apply;
    apply();
    // What the server sends in the meantime doesn't take the example away.
    for (const t of ['workers', 'sessions', 'opora', 'pulls', 'process', 'limits', 'usage']) s.on(t, apply);
    for (const t of ['workers', 'sessions', 'opora', 'pulls', 'process', 'limits', 'usage']) s.emit(t);
  }})(${JSON.stringify(fixture.toString())})`);

  const stand = (x, z, yaw, pitch) => page.evaluate(({ x, z, yaw, pitch }) => { const p = window.__office.player; p.setView('first'); p.pos.set(x, 0, z); p.camYaw = yaw; p.lookPitch = pitch; p.vy = 0; }, { x, z, yaw, pitch });
  const backToMouseLook = async (dialog) => { await page.waitForFunction(() => !!document.pointerLockElement); assert.equal(await dialog.count(), 0); };
  const openScreen = async () => {
    const dialog = page.getByRole('dialog', { name: 'Relace k cíli' });
    for (const pitch of [0.15, 0.3, 0, 0.45, -0.1]) {
      await stand(5, 6.7, Math.PI, pitch);
      await page.waitForTimeout(600);
      await page.keyboard.press('KeyE');
      if (await dialog.waitFor({ timeout: 2000 }).then(() => true, () => false)) return dialog;
    }
    throw new Error('could not open the third screen');
  };

  // 3D: the screen on the south glass, from the planner's chair side and up close.
  await stand(6.6, 4.4, Math.PI * 0.82, 0.05);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shots, '3d-room.png') });
  await stand(5, 4.3, Math.PI, 0.1);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(shots, '3d-screen-face.png') });

  // E: the whole screen.
  const screen = await openScreen();
  await screen.locator('.rowwrap').first().waitFor();
  assert.equal(await screen.locator('.rowwrap').count(), 20);
  assert.equal(await screen.locator('.kid').count(), 11);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(shots, 'screen-full.png') });
  await screen.screenshot({ path: path.join(shots, 'screen-window.png') });
  for (const box of ['Slepé uličky', 'Sirotci a práce mimo plán', 'Čeká na člověka / blokováno', 'Navazující práce']) assert.ok(await screen.locator('.box-h', { hasText: box }).count());
  assert.ok(await screen.getByRole('button', { name: '▶ Spustit' }).count() >= 4);

  // The data sources switch, and a filter.
  await screen.getByRole('switch', { name: 'Zvýraznit zdroje dat' }).click();
  await page.waitForTimeout(300);
  await screen.screenshot({ path: path.join(shots, 'screen-sources.png') });
  await screen.getByRole('switch', { name: 'Zvýraznit zdroje dat' }).click();
  await screen.getByRole('button', { name: '⚠ Pozornost' }).click();
  await page.waitForTimeout(300);
  await screen.screenshot({ path: path.join(shots, 'screen-filter-attention.png') });
  await screen.getByRole('button', { name: 'Vše', exact: true }).click();

  // Live: a sub-session reports up, a checklist item ticks off, and the orchestrator picks a card (its sessions come up top).
  await page.evaluate(() => {
    const s = window.__office.store, f = window.__fixture;
    const hana = f.sessions.find((x) => x.workerId === 's3');
    hana.kids[2] = { ...hana.kids[2], state: 'done', report: '3 snapshoty obnoveny', at: Date.now() };
    const ema = f.sessions.find((x) => x.workerId === 's1');
    ema.todos = ema.todos.map((t, i) => (i === 4 ? { ...t, status: 'completed' } : i === 5 ? { ...t, status: 'in_progress' } : t));
    s.orchestrator = { ...s.orchestrator, focus: { cardId: 'C1', name: 'Na míru – formulář věštby', by: 'Martin', at: Date.now() } };
    window.__applyFixture();
    s.emit('sessions'); s.emit('orchestrator');
  });
  await page.waitForTimeout(450);
  await screen.screenshot({ path: path.join(shots, 'screen-report-flies-up.png') });
  await page.waitForTimeout(1600);
  assert.equal(await screen.locator('.grp').first().getAttribute('data-group'), 'C1');
  await screen.screenshot({ path: path.join(shots, 'screen-orchestrator-card-first.png') });

  // A session's detail: needs you, checklist, sub-sessions, where it runs, context, PR Lens, the orchestrator's actions.
  await screen.locator('.rowwrap[data-id="s5"] .row').click();
  const detail = page.getByRole('dialog', { name: 'Detail relace Jana' });
  await detail.waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, 'detail-needs-you.png') });
  await page.keyboard.press('Escape');
  assert.equal(await detail.count(), 0);
  assert.equal(await screen.count(), 1, 'Esc in the detail goes back to the screen');
  await screen.locator('.rowwrap[data-id="s1"] .row').click();
  const detail2 = page.getByRole('dialog', { name: 'Detail relace Ema' });
  await detail2.waitFor();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shots, 'detail-checklist.png') });
  await detail2.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await detail2.count(), 0);

  // Esc: straight back to mouse-look; then ✕ the same.
  await page.keyboard.press('Escape');
  await backToMouseLook(screen);
  const again = await openScreen();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await backToMouseLook(again);

  // 3D again, with the orchestrator's card lit on the face.
  await stand(5, 4.3, Math.PI, 0.1);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(shots, '3d-screen-face-focus.png') });

  assert.deepEqual(errors, []);
  console.log('ok: shots in', shots);
} finally {
  await browser.close();
}

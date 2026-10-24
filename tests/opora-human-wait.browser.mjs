// Against an isolated production preview: the 🛰️ Opora window while Opora waits on a person (an
// unaccepted baseline). Run a built office with a temporary project, a password and
// AGENT_OFFICE_OPORA_URL pointing nowhere on port 4694 (never 4600), then:
//   HW_PASSWORD=<pw> node tests/opora-human-wait.browser.mjs
// The floor's Opora state is a labeled fixture set in the page's store (the shape the bridge digests
// from the live `ample` floor's agent-state).
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

const base = process.env.HW_OFFICE_URL ?? 'http://127.0.0.1:4694';
const shots = process.env.HW_SHOTS ?? path.join(os.tmpdir(), 'opora-human-wait-shots');
await mkdir(shots, { recursive: true });

const fixture = {
  connected: true, error: undefined, project: { id: 'cc5f34ec07cd455ca5ad1a69af19022b', name: 'ample (fixture)' }, linkedBy: 'choice', workspace: 'draft',
  projects: [{ id: 'cc5f34ec07cd455ca5ad1a69af19022b', name: 'ample (fixture)' }], workspaces: [{ id: 'draft', label: 'Draft' }], workspaceBy: 'choice',
  checkedAt: Date.now(), autopilot: true,
  cards: [
    { id: 'c1', name: 'Přihlášení', sectorName: 'Účet', status: 'frontier', group: 'dev', profile: 'code' },
    { id: 'c2', name: 'Úvodní stránka', sectorName: 'Web', status: 'frontier', group: 'design', profile: 'design' },
  ],
  humanWait: {
    decisions: [{ kind: 'accept_baseline', title: 'Přijmout výchozí zadání' }],
    stages: [{ id: 'plan', health: 'blocking', reason: 'no_accepted_baseline', count: 184 }, { id: 'acceptance', health: 'waiting', reason: 'baseline_awaiting_human', count: 1 }],
    cards: 57, more: true, claimsBlocked: true,
  },
};

const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  assert.equal((await context.request.post(base + '/api/login', { data: { password: process.env.HW_PASSWORD ?? 'blockers-preview' } })).status(), 200);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/?3d');
  await page.getByRole('button', { name: /Enter the office/ }).click({ timeout: 30000 });
  await page.waitForFunction(() => window.__office?.store.floor);
  await page.waitForTimeout(1000);
  const setOpora = () => page.evaluate((patch) => { const s = window.__office.store; s.opora = { ...s.opora, ...patch }; s.emit('opora'); }, fixture);
  await setOpora();
  // The 🛰️ window, as E at the planning room's glass opens it.
  const dialog = page.getByRole('dialog', { name: 'Opora' });
  for (const yaw of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) {
    await page.evaluate((yaw) => {
      const o = window.__office, it = o.office.interactables.find((i) => i.kind === 'opora'), p = o.player;
      p.setView('first'); p.pos.set(it.x, 0, it.z + 1); p.camYaw = yaw; p.lookPitch = 0.3; p.vy = 0;
    }, yaw);
    await page.waitForTimeout(700);
    await page.keyboard.press('KeyE');
    if (await dialog.waitFor({ timeout: 2500 }).then(() => true, () => false)) break;
  }
  await dialog.waitFor();
  // The window asks the server to read again; the preview's Opora points nowhere, so the fixture goes back on after.
  await page.waitForTimeout(1500);
  await setOpora();
  const notice = dialog.locator('.opora-human-wait');
  await notice.waitFor();
  const text = await notice.innerText();
  assert.match(text, /Opora waits on a person: Přijmout výchozí zadání — until then nobody can take any card \(57\+ cards held back\)/);
  assert.equal(await dialog.getByRole('link', { name: '↗ Decide in Opora' }).count(), 1);
  assert.ok(await dialog.getByRole('button', { name: '▶ Take' }).first().isDisabled(), '▶ Take is off while claims wait on a person');
  await dialog.locator('.opora-sector').first().evaluate((d) => (d.open = true));
  await page.screenshot({ path: path.join(shots, 'opora-human-wait.png') });
  // ✕ closes it back into mouse-look.
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await page.waitForFunction(() => !!document.pointerLockElement);
  assert.deepEqual(errors, []);
  console.log('ok', path.join(shots, 'opora-human-wait.png'));
} finally {
  await browser.close();
}

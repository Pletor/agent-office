// Vite on HARNESS_LAB_URL; real catalog + reader, isolated profile/optional capability fixtures.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { HarnessLibrary, harnessSources } from '../dist/server/server/harness/catalog.js';
import { emptyLayers, resolveHarness } from '../dist/server/shared/harness-cascade.js';
const library = new HarnessLibrary(harnessSources(process.cwd(), true));
const catalog = await library.list();
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
const shots = process.env.HARNESS_SHOTS ?? os.tmpdir();
const url = process.env.HARNESS_LAB_URL ?? 'http://localhost:5187/lab/harness.html';
try {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    console.log('Checking viewport', width);
    const page = await browser.newPage({ viewport: { width, height }, acceptDownloads: true });
    const errors = [], writes = [];
    let writable = true, hierarchyStatus = 404;
    // Unbound floor: only Globál and Projekt / repozitář are selectable, as before an Opora binding exists.
    const layers = emptyLayers(); layers.global = { 'rules.quality': { resource: 'guide:testing' } };
    let revision = 7;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/harness**', async route => {
      const request = route.request(), endpoint = new URL(request.url());
      const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      if (endpoint.pathname.endsWith('/hierarchy')) {
        if (hierarchyStatus !== 200) return send({ error: 'Unavailable' }, hierarchyStatus);
        const level = endpoint.searchParams.get('scope') || 'repository';
        if (request.method() === 'POST') {
          assert.ok(writable, 'read-only session must never write');
          const body = request.postDataJSON(); writes.push(body);
          assert.equal(body.op, 'save');
          assert.equal(body.revision, revision, 'save retains current revision');
          assert.equal(body.scope, level, 'save targets the selected level');
          layers[body.scope] = body.layer; revision++;
        }
        return send({ schema: 'harness.hierarchy/1', floor: 'lab', target: '', level, revision, path: [], layers,
          effective: resolveHarness(level === 'global' ? { global: layers.global } : layers, []), bound: null, linked: null, bindingRevision: 0,
          pathDigest: '', choices: [], notice: '', writable, globalWrite: writable, canBind: false, preview: 'Saved snapshot', warning: '' });
      }
      if (endpoint.pathname.endsWith('/file')) return send(await library.read(endpoint.searchParams.get('id')));
      return send(catalog);
    });
    await page.goto(url);
    await page.waitForFunction(() => window.__ready);
    const open = async () => { await page.getByRole('button', { name: 'Open Harness', exact: true }).click(); await page.locator('.harness-entry').first().waitFor({ state: 'attached' }); };
    const nav = name => page.getByRole('navigation', { name: 'Harness library pages' }).getByRole('button', { name });
    const testing = catalog.entries.find(entry => entry.id === 'guide:testing').title;
    const row = title => page.locator('.harness-resource-check').filter({ has: page.getByRole('checkbox', { name: title, exact: true }) });
    await open();
    await nav('Overview').click();
    await page.getByText(/This server exposes Global/).waitFor();
    await page.screenshot({ path: path.join(shots, `harness-workspace-overview-${width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const box = await page.getByRole('dialog').boundingBox();
    assert.deepEqual([Math.round(box.width), Math.round(box.height)], [width, height]);
    await page.locator('.harness-category').filter({ hasText: 'memory' }).click();
    assert.equal(await page.getByLabel('Resource category').inputValue(), 'memory');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    hierarchyStatus = 200;
    await open();
    await nav('Overview').click();
    await page.getByText(/Seven-level hierarchy API available · write authority confirmed\. Seven-level editor loaded\./).waitFor();
    await nav('Equipment').click();
    await page.getByText(/Projekt \/ repozitář · revize 7/).waitFor();
    let checkbox = page.getByRole('checkbox', { name: testing, exact: true });
    assert.equal(await checkbox.isChecked(), true);
    assert.match(await row(testing).innerText(), /Globál/, 'inherited resource shows its origin');
    await checkbox.uncheck();
    await page.getByLabel('Globál', { exact: true }).selectOption('global');
    await page.getByText('Nejprve uložte výbavu nebo zahoďte změny.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Projekt / repozitář', { exact: true }).inputValue(), 'repository', 'level change preserves unsaved draft');
    assert.equal(await checkbox.isChecked(), false);
    await page.getByRole('button', { name: 'Uložit výbavu', exact: true }).click();
    await page.getByText(/revize 8/).waitFor();
    assert.equal(writes[0].scope, 'repository');
    assert.equal(writes[0].layer['rules.quality'], null, 'disable is an explicit null override');
    assert.equal(await checkbox.isChecked(), false);
    assert.match(await row(testing).innerText(), /Zděděný prostředek vypnutý zde/);
    await row(testing).getByRole('button', { name: 'Dědit', exact: true }).click();
    assert.equal(await checkbox.isChecked(), true);
    await page.getByRole('button', { name: 'Uložit výbavu', exact: true }).click();
    await page.getByText(/revize 9/).waitFor();
    assert.equal(Object.hasOwn(writes[1].layer, 'rules.quality'), false, 'inherit deletes only the local override');
    assert.equal(await checkbox.isChecked(), true);
    await page.screenshot({ path: path.join(shots, `harness-workspace-equipment-${width}.png`) });
    await nav('Resources').click();
    await page.getByLabel('Resource category').selectOption('');
    await page.getByRole('button', { name: /Start here/ }).click();
    await page.getByRole('button', { name: 'Assign resource', exact: true }).click();
    const assigned = page.getByRole('checkbox', { name: 'Start here', exact: true });
    assert.equal(await assigned.isChecked(), true);
    await assigned.uncheck();
    await assigned.check();
    const draft = JSON.parse(await page.getByLabel('Harness layer JSON').inputValue());
    assert.ok(Object.values(draft).some(binding => binding?.resource === 'guide:instructions'), 'new unsaved assignment survives off/on');
    await page.getByRole('button', { name: 'Zahodit změny a načíst', exact: true }).click();
    await page.getByText(/revize 9/).waitFor();
    assert.equal(await assigned.isChecked(), false, 'discard drops the unsaved assignment');
    assert.equal(writes.length, 2);
    // Esc with an unsaved draft keeps it in memory: reopening restores it with a notice, and Save sends it (audit F07).
    checkbox = page.getByRole('checkbox', { name: testing, exact: true });
    await checkbox.uncheck();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await open(); await nav('Equipment').click();
    const kept = page.getByText('Neuložené změny z minula – uložte nebo zahoďte.', { exact: true });
    await kept.waitFor();
    assert.equal(await checkbox.isChecked(), false, 'reopening restores the unsaved draft');
    await kept.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, `harness-workspace-kept-draft-${width}.png`) });
    await page.getByRole('button', { name: 'Uložit výbavu', exact: true }).click();
    await page.getByText(/revize 10/).waitFor();
    assert.equal(writes[2].layer['rules.quality'], null, 'save sends the restored draft');
    assert.equal(await kept.isVisible(), false, 'a save clears the notice');
    // ✕ keeps it too, and Zahodit drops it for good.
    await row(testing).getByRole('button', { name: 'Dědit', exact: true }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await open(); await nav('Equipment').click();
    await kept.waitFor();
    assert.equal(await checkbox.isChecked(), true);
    await page.getByRole('button', { name: 'Zahodit změny a načíst', exact: true }).click();
    await page.getByText(/revize 10/).waitFor();
    assert.equal(await checkbox.isChecked(), false, 'discard drops the restored draft');
    await page.keyboard.press('Escape');
    await open(); await nav('Equipment').click();
    await page.getByText(/revize 10/).waitFor();
    assert.equal(await kept.isVisible(), false, 'a discarded draft never comes back');
    assert.equal(writes.length, 3);
    await nav('Runtime & evidence').click();
    await page.getByText('Accepted runtime', { exact: true }).click();
    await page.getByText('office-harness --accepted-kit', { exact: true }).first().waitFor();
    assert.equal(await page.locator('.harness-runtime input[type=checkbox]').count(), 0, 'worker-only capabilities have no fake switches');
    await page.screenshot({ path: path.join(shots, `harness-workspace-runtime-${width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    writable = false;
    await open();
    await nav('Overview').click();
    await page.getByText(/Seven-level hierarchy API available · read-only/).waitFor();
    await nav('Equipment').click();
    await page.getByText(/revize 10 · Pouze ke čtení/).waitFor();
    checkbox = page.getByRole('checkbox', { name: testing, exact: true });
    assert.equal(await checkbox.isDisabled(), true);
    assert.equal(await row(testing).getByRole('button', { name: 'Dědit', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Uložit výbavu', exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('Harness layer JSON').isDisabled(), true);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.deepEqual(errors, []);
    // PR55 supplies this selector; exercise the actual shell relocation without copying its editor.
    await page.evaluate(async () => {
      const { h, openModal } = await import('/ui/dom.ts');
      const { libraryWorkspace } = await import('/features/harness/library/workspace.ts');
      const project = h('select', { 'aria-label': 'Projekt knihovny' }, h('option', { value: 'project-a' }, 'Project Alpha / repository'));
      project.addEventListener('change', () => { window.__projectChanges = (window.__projectChanges ?? 0) + 1; });
      project.append(h('option', { value: 'project-b' }, 'Project Beta / repository'));
      const dialog = h('div.modal.harness-window', { role: 'dialog', 'aria-label': 'Project selector fixture' }, h('header', {}, h('h2', {}, 'Harness')),
        h('div.harness-toolbar', {}, project), h('div.harness-body'));
      libraryWorkspace(dialog, () => project.value, new AbortController().signal);
      openModal(dialog);
    });
    const project = page.getByLabel('Projekt knihovny', { exact: true });
    const projectBox = await project.boundingBox();
    assert.ok(projectBox.width >= 120, `project selector is readable at ${width}px (was ${projectBox.width}px)`);
    await project.selectOption('project-b');
    assert.equal(await page.evaluate(() => window.__projectChanges), 1, 'selector retains its original change handler');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)));
    await page.screenshot({ path: path.join(shots, `harness-workspace-project-${width}.png`) });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.close();
  }
  console.log('PASS: desktop/mobile workspace, real catalog/category navigation, seven-level on/off/inherit/revision payloads, draft preservation and discard, drafts kept across Esc/✕ and restored with a notice, legacy and seven-level API detection, read-only controls, worker-only states, screenshots, Esc/close');
} finally { await browser.close(); }

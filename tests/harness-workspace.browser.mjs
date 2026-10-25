// Vite on HARNESS_LAB_URL; real catalog + reader, isolated profile/optional capability fixtures.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { HarnessLibrary, harnessSources } from '../dist/server/server/harness/catalog.js';
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
    const profile = { revision: 7, layers: { global: { 'rules.quality': { resource: 'guide:testing' } }, repository: {}, task: {} }, tasks: [], writable: true, globalWrite: true, preview: 'Saved snapshot', warning: '' };
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/harness**', async route => {
      const request = route.request(), endpoint = new URL(request.url());
      const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      if (endpoint.pathname.endsWith('/hierarchy')) return send(hierarchyStatus === 200 ? { schema: 'harness.hierarchy/1', writable, bound: null, notice: '' } : { error: 'Unavailable' }, hierarchyStatus);
      if (endpoint.pathname.endsWith('/profile')) {
        if (request.method() === 'POST') {
          assert.ok(writable, 'read-only session must never write');
          const body = request.postDataJSON(); writes.push(body);
          assert.equal(body.revision, profile.revision, 'save retains current revision');
          profile.layers[body.scope] = body.layer; profile.revision++;
        }
        const effective = {};
        for (const scope of ['global', 'repository', 'task']) for (const [slot, binding] of Object.entries(profile.layers[scope])) effective[slot] = { binding, scope };
        return send({ ...profile, effective, writable, globalWrite: writable });
      }
      if (endpoint.pathname.endsWith('/file')) return send(await library.read(endpoint.searchParams.get('id')));
      return send(catalog);
    });
    await page.goto(url);
    await page.waitForFunction(() => window.__ready);
    const open = async () => { await page.getByRole('button', { name: 'Open Harness', exact: true }).click(); await page.locator('.harness-entry').first().waitFor({ state: 'attached' }); };
    const nav = name => page.getByRole('navigation', { name: 'Harness library pages' }).getByRole('button', { name });
    await open();
    await nav('Overview').click();
    await page.getByText(/This server exposes Global/).waitFor();
    await page.screenshot({ path: path.join(shots, `harness-workspace-overview-${width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const box = await page.getByRole('dialog').boundingBox();
    assert.deepEqual([Math.round(box.width), Math.round(box.height)], [width, height]);
    await page.locator('.harness-category').filter({ hasText: 'memory' }).click();
    assert.equal(await page.getByLabel('Resource category').inputValue(), 'memory');
    await nav('Equipment').click();
    let checkbox = page.getByRole('checkbox', { name: 'Enable rules.quality' });
    await checkbox.waitFor();
    assert.equal(await checkbox.isChecked(), true);
    await page.getByText('Inherited · global', { exact: true }).waitFor();
    await checkbox.uncheck();
    await page.getByLabel('Harness scope').selectOption('global');
    assert.equal(await page.getByLabel('Harness scope').inputValue(), 'repository', 'scope change preserves unsaved draft');
    await page.getByRole('button', { name: 'Save layer', exact: true }).click();
    await page.getByText(/Revision 8\./).waitFor();
    assert.equal(writes[0].scope, 'repository');
    assert.equal(writes[0].layer['rules.quality'], null, 'disable is an explicit null override');
    assert.equal(await checkbox.isChecked(), false);
    await page.getByRole('button', { name: 'Inherit', exact: true }).click();
    assert.equal(await checkbox.isChecked(), true);
    await page.getByRole('button', { name: 'Save layer', exact: true }).click();
    await page.getByText(/Revision 9\./).waitFor();
    assert.equal(Object.hasOwn(writes[1].layer, 'rules.quality'), false, 'inherit deletes only the local override');
    await page.screenshot({ path: path.join(shots, `harness-workspace-equipment-${width}.png`) });
    await page.getByLabel('Harness slot', { exact: true }).fill('tools.new');
    await nav('Resources').click();
    await page.getByLabel('Resource category').selectOption('');
    await page.getByRole('button', { name: /Start here/ }).click();
    await page.getByRole('button', { name: 'Assign resource', exact: true }).click();
    const assigned = page.getByRole('checkbox', { name: 'Enable tools.new' });
    await assigned.uncheck();
    await assigned.check();
    assert.equal(JSON.parse(await page.getByLabel('Harness layer JSON').inputValue())['tools.new'].resource, 'guide:instructions', 'new unsaved assignment survives off/on');
    await page.getByRole('button', { name: 'Load task / reload', exact: true }).click();
    await page.getByText(/Revision 9\./).waitFor();
    await nav('Runtime & evidence').click();
    await page.getByText('Accepted runtime', { exact: true }).click();
    await page.getByText('office-harness --accepted-kit', { exact: true }).first().waitFor();
    assert.equal(await page.locator('.harness-runtime input[type=checkbox]').count(), 0, 'worker-only capabilities have no fake switches');
    await page.screenshot({ path: path.join(shots, `harness-workspace-runtime-${width}.png`) });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    writable = false; hierarchyStatus = 200;
    await open();
    await nav('Overview').click();
    await page.getByText(/Seven-level hierarchy API available · read-only/).waitFor();
    await nav('Equipment').click();
    checkbox = page.getByRole('checkbox', { name: 'Enable rules.quality' });
    await checkbox.waitFor();
    assert.equal(await checkbox.isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Save layer', exact: true }).isDisabled(), true);
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
  console.log('PASS: desktop/mobile workspace, real catalog/category navigation, on/off/inherit/revision payloads, draft preservation, API hierarchy detection, read-only controls, worker-only states, screenshots, Esc/close');
} finally { await browser.close(); }

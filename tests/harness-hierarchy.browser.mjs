// Vite lab, real catalog, deterministic hierarchy API fixture. No paid agents or live writes.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { HarnessLibrary, harnessSources } from '../dist/server/server/harness/catalog.js';
import { emptyLayers, resolveHarness } from '../dist/server/shared/harness-cascade.js';
const library = new HarnessLibrary(harnessSources(process.cwd(), true)), catalog = await library.list();
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
try {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const levels = ['page', 'layer', 'area', 'sector', 'task'];
    const names = ['Stránka', 'Vrstva', 'Oblast', 'Sektor', 'Karta'];
    const keys = levels.map(level => 'opora:p:w:' + level);
    const layers = emptyLayers(); layers.global = { quality: { resource: 'guide:testing' } };
    let revision = 0, rejectSave = false, experienceAvailable = true;
    let experienceGate, experienceSeen, experienceDone;
    await page.route('**/api/harness**', async route => {
      const request = route.request(), url = new URL(request.url());
      let data;
      if (url.pathname.endsWith('/recommend')) {
        experienceSeen?.();
        if (experienceGate) await experienceGate;
        if (!experienceAvailable) return route.fulfill({ status: 404, json: { error: 'not installed' } });
        try { return await route.fulfill({ json: { schema: 'harness.recommendation/1', history: { status: 'available', limited: false }, candidates: [{
          id: 'guide:testing', digest: 'a'.repeat(64), tasks: 3, missing: [],
          verified: { pass: 5, fail: 0, unknown: 1, interval95: [56.55, 100] },
          reported: { pass: 7, fail: 1, unknown: 0, interval95: [52.9, 97.8] },
          guardrails: { source: 'native-review-eval-cases', affectedExecutions: 1, incidentReportExecutions: 1, revertedExecutions: 1, productionExposure: 'unknown', causalAttribution: false }
        }] } }); } catch { /* A scope change can abort this deliberately delayed fixture. */ }
        finally { experienceDone?.(); }
      }
      if (url.pathname.endsWith('/projects')) data = { projects: [{ floor: 'lab', name: 'Vývoj', projectName: 'Harness', connected: true }] };
      else if (url.pathname.endsWith('/file')) data = await library.read(url.searchParams.get('id'));
      else if (!url.pathname.endsWith('/hierarchy')) data = catalog;
      else {
        const target = url.searchParams.get('node') ?? '', index = keys.indexOf(target), level = url.searchParams.get('scope') || levels[index] || 'repository';
        const chain = levels.slice(0, index + 1).map((level, i) => ({ level, node: keys[i], name: names[i] }));
        if (request.method() === 'POST') {
          const body = request.postDataJSON();
          if (rejectSave || body.revision !== revision || body.scope !== level || body.pathDigest !== 'fixture') return route.fulfill({ status: 409, json: { error: 'Konflikt revize; načtěte znovu.' } });
          layers[level] = body.layer; revision++;
        }
        data = { schema: 'harness.hierarchy/1', floor: 'lab', target, level, revision, path: chain, layers,
          effective: resolveHarness(layers, chain), bound: { project: 'p', workspace: 'w' }, linked: { project: 'p', workspace: 'w', name: 'Harness' }, bindingRevision: 1,
          pathDigest: 'fixture', choices: levels.map((level, i) => ({ level, key: keys[i], name: names[i], ancestry: Object.fromEntries(levels.slice(0, i + 1).map((parent, j) => [parent, keys[j]])) })),
          notice: '', writable: true, globalWrite: true, canBind: true, preview: 'Saved context', warning: '' };
      }
      await route.fulfill({ status: data ? 200 : 404, json: data ?? { error: 'Not found' } });
    });
    await page.goto(process.env.HARNESS_LAB_URL ?? 'http://127.0.0.1:5192/lab/harness.html');
    await page.waitForFunction(() => window.__ready);
    await page.getByRole('button', { name: 'Open Harness', exact: true }).click();
    await page.locator('.harness-cascade summary').first().click();
    await page.getByLabel('Karta', { exact: true }).selectOption(keys[4]);
    // Derive the exact published title rather than hard-coding translations.
    const title = catalog.entries.find(entry => entry.id === 'guide:testing').title;
    const checkbox = page.getByRole('checkbox', { name: title, exact: true });
    await checkbox.waitFor(); assert.equal(await checkbox.isChecked(), true);
    await checkbox.uncheck(); await page.getByRole('button', { name: 'Uložit výbavu', exact: true }).click();
    await page.getByText(/revize 1/).waitFor(); assert.equal(layers.task.quality, null);
    await checkbox.check(); rejectSave = true;
    await page.getByRole('button', { name: 'Uložit výbavu', exact: true }).click();
    await page.getByText('Konflikt revize; načtěte znovu.', { exact: true }).waitFor();
    assert.equal(await checkbox.isChecked(), true, 'failed save retains draft');
    await page.getByRole('button', { name: 'Znovu načíst', exact: true }).click();
    await page.getByText(/revize 1/).waitFor(); assert.equal(await checkbox.isChecked(), false);
    await page.locator('.harness-resource-check').filter({ has: page.getByRole('checkbox', { name: title, exact: true }) }).getByRole('button', { name: 'Dědit', exact: true }).click();
    assert.equal(await checkbox.isChecked(), true);
    await page.locator('.harness-experience summary').click();
    await page.getByLabel('Typ úkolu pro zkušenosti').fill('ts.references');
    await page.getByRole('button', { name: 'Načíst zkušenosti', exact: true }).click();
    await page.getByText('Načteno pro ts.references.', { exact: true }).waitFor();
    const row = page.locator('.harness-resource-check').filter({ has: page.getByRole('checkbox', { name: title, exact: true }) });
    assert.match(await row.innerText(), /Lidské potvrzení: 100 % · 5\/5/);
    assert.match(await row.innerText(), /Hlášení agenta: 87,5 %/);
    assert.match(await row.innerText(), /Regrese k prověření · dotčené běhy: 1/);
    assert.equal(await checkbox.isChecked(), true, 'read-only measurements preserve the unsaved checkbox draft');
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(process.env.HARNESS_SHOTS ?? os.tmpdir(), 'harness-experience-' + width + '.png') });
    let release, seen, finished;
    experienceGate = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { seen = resolve; }); experienceSeen = seen;
    const completed = new Promise(resolve => { finished = resolve; }); experienceDone = finished;
    await page.getByRole('button', { name: 'Načíst zkušenosti', exact: true }).click(); await requested;
    await page.getByLabel('Projekt / repozitář', { exact: true }).selectOption('repository');
    await page.getByText(/Projekt \/ repozitář · revize 1/).waitFor();
    release(); await completed;
    assert.equal(await page.locator('.harness-experience-badge').count(), 0, 'late measurements cannot repaint another scope');
    experienceGate = experienceSeen = experienceDone = undefined;
    experienceAvailable = false;
    await page.getByRole('button', { name: 'Načíst zkušenosti', exact: true }).click();
    await page.getByText('Tato instalace zatím neposkytuje měření zkušeností.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('.harness-body').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(process.env.HARNESS_SHOTS ?? os.tmpdir(), 'harness-hierarchy-' + width + '.png'), fullPage: true });
    await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByRole('button', { name: 'Open Harness', exact: true }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click(); assert.equal(await page.getByRole('dialog').count(), 0);
    assert.deepEqual(errors, []); await page.close();
  }
  console.log('PASS: seven levels, inheritance, save/conflict/reload, versioned rates, late-response fences, optional endpoint, desktop/mobile, Esc and close');
} finally { await browser.close(); }

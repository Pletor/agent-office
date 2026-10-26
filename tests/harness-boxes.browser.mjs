// Vite on HARNESS_LAB_URL; real catalog, reader and kit build, a fixture profile and recommendation.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { HarnessLibrary, harnessSources } from '../dist/server/server/harness/catalog.js';
import { buildHarnessKit } from '../dist/server/server/harness/kit.js';
import { emptyLayers, resolveHarness } from '../dist/server/shared/harness-cascade.js';
import { isItemPath, itemView } from '../dist/server/server/harness/items.js';
const library = new HarnessLibrary(harnessSources(process.cwd(), true));
const catalog = await library.list();
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
const shots = process.env.HARNESS_SHOTS ?? os.tmpdir();
const url = process.env.HARNESS_LAB_URL ?? 'http://localhost:5187/lab/harness.html';
const testing = catalog.entries.find(entry => entry.id === 'guide:testing');
const start = catalog.entries.find(entry => entry.id === 'guide:instructions');
try {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [], kits = [], proposals = [];
    page.on('pageerror', error => errors.push(error.message));
    const layers = emptyLayers(); layers.global = { 'rules.quality': { resource: 'guide:testing' } };
    await page.route('**/api/harness**', async route => {
      const endpoint = new URL(route.request().url());
      const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      if (endpoint.pathname.endsWith('/hierarchy')) return send({ schema: 'harness.hierarchy/1', floor: 'lab', target: '', level: 'repository', revision: 3, path: [], layers,
        effective: resolveHarness(layers, []), bound: { project: 'p1', workspace: 'w1' }, linked: null, bindingRevision: 1, pathDigest: '', choices: [{ key: 'opora:p1:w1:k1', name: 'H07 Editor výbavy', level: 'task', ancestry: {} }], notice: '', writable: true, globalWrite: true, canBind: false, preview: '', warning: '' });
      if (endpoint.pathname.endsWith('/file')) {
        const entry = await library.read(endpoint.searchParams.get('id'));
        return send(isItemPath(entry.path) ? { ...entry, item: itemView(entry, catalog.entries) } : entry);
      }
      if (endpoint.pathname.endsWith('/propose')) {
        proposals.push(route.request().postDataJSON());
        return send({ id: 'c1', card: 'k1', resources: 4, opora: 'http://127.0.0.1:8740' });
      }
      if (endpoint.pathname.endsWith('/kit')) {
        kits.push(endpoint.searchParams.getAll('resource'));
        try { return send(await buildHarnessKit(library, endpoint.searchParams.get('problem'), endpoint.searchParams.getAll('resource'))); }
        catch (error) { return send({ error: error.message }, 400); }
      }
      if (endpoint.pathname.endsWith('/recommend')) return send({ schema: 'harness.recommendation/1', proposalStatus: 'reference-only',
        selection: [{ resource: 'guide:instructions', reason: 'baseline-policy' }, { resource: 'guide:testing', reason: 'explicit-assignment' }] });
      return send(catalog);
    });
    await page.goto(url);
    await page.waitForFunction(() => window.__ready);
    await page.getByRole('button', { name: 'Open Harness', exact: true }).click();
    const boxes = page.getByRole('region', { name: 'Schránky výbavy' });
    await boxes.waitFor();
    assert.equal(await page.locator('.harness-box').count(), 12, 'twelve boxes');
    assert.equal(await page.getByRole('navigation', { name: 'Stránky knihovny' }).getByRole('button', { name: /Schránky/ }).getAttribute('aria-current'), 'page', 'Schránky open first');
    // Evaluace: what the floor uses is apart from what only waits in the library.
    const evaluation = page.locator('.harness-box[data-box="9"]');
    await evaluation.getByText('1 používá').waitFor();
    await evaluation.click();
    const used = page.locator('.harness-box-item[data-used=true]').filter({ hasText: testing.title });
    await used.waitFor();
    assert.match(await used.innerText(), /používá se/);
    await page.locator('.harness-box[data-box="7"]').click();
    await page.getByText('office-harness --invoke-node RESOURCE -- ARG', { exact: true }).waitFor();
    // Inspect before packing: the preview shows the real text and when it is used.
    await page.locator('.harness-box[data-box="1"]').click();
    const row = page.locator('.harness-box-detail .harness-box-item').filter({ hasText: start.title }).first();
    await row.getByRole('button', { name: 'Prohlédnout' }).click();
    const preview = page.getByRole('region', { name: 'Náhled' });
    await preview.getByText('Start relace: agent si to přečte jako první').waitFor();
    assert.ok((await preview.locator('pre').innerText()).length > 40, 'preview shows the resource text');
    await preview.getByRole('button', { name: 'Přidat do balíčku' }).click();
    await page.getByText('Vybráno 1 / 24').waitFor({ state: 'attached' });
    await preview.getByRole('button', { name: 'Zavřít náhled' }).click();
    assert.equal(await preview.isVisible(), false);
    // Compose and verify through the server's kit build; a later change makes it stale.
    const pack = page.getByRole('region', { name: 'Balíček' });
    await pack.getByRole('button', { name: 'Složit a ověřit' }).click();
    await pack.getByText('Ověřeno serverem').waitFor();
    assert.deepEqual(kits.at(-1), ['guide:instructions']);
    await pack.getByText('Bez kontroly', { exact: true }).waitFor();
    await pack.getByText('Jak to udělá orchestrátor Opory').click();
    await pack.getByText('office-harness --kit bugfix guide:instructions', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(shots, `harness-boxes-verified-${width}.png`), fullPage: false });
    await page.locator('.harness-box[data-box="9"]').click();
    await page.locator('.harness-box-detail .harness-box-item').filter({ hasText: testing.title }).getByRole('checkbox').check();
    await pack.getByText('Balíček se od ověření změnil. Složte a ověřte ho znovu.').waitFor();
    // Recommendation fills the same package with its reasons.
    await pack.getByRole('button', { name: 'Doporučit balíček' }).click();
    await pack.getByText(/ve výbavě patra/).waitFor();
    assert.equal(await page.locator('.harness-pack .harness-box-item').count(), 2);
    await pack.getByRole('button', { name: 'Složit a ověřit' }).click();
    await pack.getByText('Ověřeno serverem').waitFor();
    assert.equal(await pack.getByText('Bez kontroly', { exact: true }).count(), 0, 'testing in the package clears the warning');
    await boxes.evaluate(node => node.scrollTo(0, 0));
    await page.screenshot({ path: path.join(shots, `harness-boxes-${width}.png`) });
    // Přiřadit do výbavy switches the whole package on at the level open in Výbava; saving stays explicit.
    await pack.getByRole('button', { name: 'Přiřadit do výbavy' }).click();
    await page.getByRole('checkbox', { name: start.title, exact: true }).waitFor();
    assert.equal(await page.getByRole('checkbox', { name: start.title, exact: true }).isChecked(), true, 'package resource switched on in the draft');
    await page.getByText(/Neuložené úpravy pro Projekt/).waitFor();
    await page.getByRole('button', { name: 'Zahodit změny a načíst', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal scroll');
    // A defined skill: what it is, what it is made of; its parts travel with it into the kit, and the kit goes into a card.
    await page.getByRole('navigation', { name: 'Stránky knihovny' }).getByRole('button', { name: /Schránky/ }).click();
    await page.locator('.harness-box[data-box="3"]').click();
    const skillRow = page.locator('.harness-box-detail .harness-box-item').filter({ has: page.getByText('Definice', { exact: true }) }).filter({ hasText: 'ts-references' });
    await skillRow.waitFor();
    await skillRow.getByRole('button', { name: 'Prohlédnout' }).click();
    const definition = page.getByRole('region', { name: 'Definice' });
    await definition.getByText(/Z čeho se skládá · 3 částí/).waitFor();
    await definition.getByText('node scripts/ts-refs.mjs refs SYMBOL', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(shots, `harness-boxes-definition-${width}.png`) });
    await page.getByRole('region', { name: 'Náhled' }).getByRole('button', { name: 'Přidat do balíčku' }).click();
    await pack.getByRole('button', { name: 'Složit a ověřit' }).click();
    await pack.getByText(/Včetně 3 částí definic/).waitFor();
    await pack.getByLabel('Karta v Opoře').selectOption('opora:p1:w1:k1');
    await pack.getByRole('button', { name: 'Poslat do karty v Opoře' }).click();
    await pack.getByText('Návrh je v Opoře').waitFor();
    assert.equal(proposals.at(-1).card, 'opora:p1:w1:k1');
    assert.ok(proposals.at(-1).resources.length >= 3, 'the package is sent, the server adds the parts');
    await page.screenshot({ path: path.join(shots, `harness-boxes-sent-${width}.png`) });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS: twelve boxes open first, used vs library per box, office functions with commands, inspect with text and phase, one package with the footer, server kit verification, stale after change, recommendation with reasons, package assigned to the open level, orchestrator commands, a definition with its parts, the kit sent into an Opora card, 1440/390 without horizontal scroll, Esc');
} finally { await browser.close(); }

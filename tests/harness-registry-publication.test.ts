import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { HarnessRegistry } from '../src/server/harness/registry.js';
import { revisionFile } from '../src/server/harness/commit.js';
import { HarnessLibrary, harnessSources } from '../src/server/harness/catalog.js';
import { assertBindable } from '../src/server/harness/handoff.js';

const observed = (id: string, digest = 'a'.repeat(64)) => ({ id, digest, ns: 'project', key: id, root: 'root', title: id, path: id, source: 'project', category: 'rules' as const });
function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-publication-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = new HarnessRegistry(dir);
  return { dir, registry, file: registry.file };
}
test('legacy migration preserves bytes and versions and writes a distinct schema', async t => {
  const { dir, registry, file } = fixture(t);
  await registry.observe([observed('one')], new Set());
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  legacy.schema = 1; delete legacy.revision;
  const original = JSON.stringify(legacy, null, 3) + '\n';
  fs.writeFileSync(file, original);
  const result = await new HarnessRegistry(dir).observe([observed('one'), observed('two')], new Set());
  assert.equal(result.get('one'), 1);
  assert.equal(result.get('two'), 1);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.schema, 2);
  assert.equal(saved.revision, 1);
  const backups = fs.readdirSync(dir).filter(n => n.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original);
});

test('explicit shared publication is visible to ordinary workers and can supply global policy', async t => {
  const { dir, registry } = fixture(t);
  const shared = path.join(dir, 'shared');
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, 'rules.md'), 'Public reviewed policy');
  const sources = harnessSources(path.join(dir, 'project'), false, { AGENT_OFFICE_SHARED_HARNESS_DIR: shared, AGENT_OFFICE_HARNESS_DIR: path.join(dir, 'private') });
  assert.equal(sources.some(source => source.ns === 'published'), false);
  const library = new HarnessLibrary(sources, registry);
  const entry = (await library.list()).entries.find(entry => entry.source === 'Shared harness')!;
  assert.ok(entry);
  assert.doesNotThrow(() => assertBindable(library, 'global', entry.id));
  assert.equal((await library.read(entry.id))?.text, 'Public reviewed policy');
});
test('writer displaced after the lease check cannot overwrite a published competing update', async t => {
  const { registry, file, dir } = fixture(t);
  await registry.observe([observed('base')], new Set());
  const base = fs.readFileSync(file, 'utf8');
  const rival = JSON.parse(base);
  rival.revision++;
  rival.elements.rival = structuredClone(rival.elements.base);
  const winner = JSON.stringify(rival);
  const original = fs.linkSync;
  let injected = false;
  fs.linkSync = ((from: any, to: any) => {
    if (String(to) === revisionFile(file, rival.revision, base) && !injected) {
      injected = true;
      fs.writeFileSync(String(to), winner, { flag: 'wx' });
      fs.writeFileSync(file, winner);
    }
    return original(from, to);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();
  let result;
  try { result = await registry.observe([observed('loser')], new Set()); }
  finally { fs.linkSync = original; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(result.get('loser'), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), winner);
  assert.ok(new HarnessRegistry(dir).lookup('rival'));
  assert.equal(new HarnessRegistry(dir).lookup('loser'), undefined);
});
test('published successor remains readable when main file replacement did not happen', async t => {
  const { registry, file, dir } = fixture(t);
  await registry.observe([observed('first')], new Set());
  const base = fs.readFileSync(file, 'utf8');
  const next = JSON.parse(base);
  next.revision++;
  next.elements.recovered = structuredClone(next.elements.first);
  fs.writeFileSync(revisionFile(file, next.revision, base), JSON.stringify(next));
  const fresh = new HarnessRegistry(dir);
  assert.ok(fresh.lookup('recovered'));
  await fresh.observe([observed('third')], new Set());
  const final = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(final.revision, 3);
  assert.ok(final.elements.recovered);
  assert.ok(final.elements.third);
});

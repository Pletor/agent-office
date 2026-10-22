import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildHarnessKit, kitBytes } from '../src/server/harness/kit.js';
import { HarnessLibrary, sourceCategory } from '../src/server/harness/catalog.js';

test('built kits hash exact content, preserve versions and match the ASCII-escaped transport bound', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'harness-kit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'scripts'));
  const file = path.join(dir, 'scripts', 'check.py'), content = '# é 🧪\nprint("ok")\n';
  await writeFile(file, content);
  const library = new HarnessLibrary([{ name: 'Published', dir }]);
  const id = (await library.list()).entries.find(e => e.path === 'scripts/check.py')!.id;
  const kit = await buildHarnessKit(library, 'ts.references', [id]);
  assert.equal(kit.schema, 'harness.kit/1');
  assert.equal(kit.resources[0].digest, createHash('sha256').update(content).digest('hex'));
  assert.equal(kit.resources[0].content, content);
  assert.equal(kit.resources[0].category, 'scripts');
  assert.ok(kit.resources[0].slot.length <= 80);
  assert.deepEqual(kit.resources[0].requires, []);
  assert.equal(kitBytes(kit) - Buffer.byteLength(JSON.stringify(kit)), 12);
  await writeFile(file, '# changed');
  const next = await buildHarnessKit(library, 'ts.references', [id]);
  assert.notEqual(next.resources[0].digest, kit.resources[0].digest);
  assert.equal(kit.resources[0].content, content);
});

test('kit builder rejects duplicate, missing and out-of-bound selections without partial output', async () => {
  const library = new HarnessLibrary([]);
  for (const problem of ['', 'bad\n', 'x'.repeat(201)]) await assert.rejects(buildHarnessKit(library, problem, []));
  await assert.rejects(buildHarnessKit(library, 'typescript', ['guide:rules', 'guide:rules']), /distinct/);
  await assert.rejects(buildHarnessKit(library, 'typescript', Array.from({ length: 25 }, (_, i) => String(i))), /24/);
  await assert.rejects(buildHarnessKit(library, 'typescript', ['../../private']), /resource IDs/);
  await assert.rejects(buildHarnessKit(library, 'typescript', ['missing']), /unavailable/);
  assert.deepEqual((await buildHarnessKit(library, 'typescript', [])).resources, []);
});

test('Unicode resource limits are checked after JSON escaping, not just raw UTF-8 size', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'harness-kit-size-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'large.md'), 'é'.repeat(20000));
  const library = new HarnessLibrary([{ name: 'Published', dir }]);
  const id = (await library.list()).entries.find(e => e.path === 'large.md')!.id;
  await assert.rejects(buildHarnessKit(library, 'typescript', [id]), /96 KiB/);
});

test('plugins and permissions have their own discoverable categories and portable guides', async () => {
  assert.equal(sourceCategory('plugins/connector.json'), 'plugins');
  assert.equal(sourceCategory('permissions/review.md'), 'permissions');
  const kit = await buildHarnessKit(new HarnessLibrary([]), 'runner.setup', ['guide:plugins', 'guide:permissions']);
  assert.deepEqual(kit.resources.map(e => e.category), ['plugins', 'permissions']);
});

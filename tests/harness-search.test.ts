import test from 'node:test';
import assert from 'node:assert/strict';
// The CLI helper is also shipped in the npm package.
// @ts-expect-error JavaScript CLI module has no declaration file.
import { searchCatalog } from '../bin/harness-search.js';

test('catalog search matches all words in metadata and preserves availability diagnostics', () => {
  const rules = { title: 'Quality.md', path: 'rules/Quality.md', source: 'Shared harness', category: 'rules' };
  const catalog = { entries: [rules, { ...rules, category: 'testing' }], sources: [{ name: 'Shared harness', available: true }], limited: true };
  const found = searchCatalog(catalog, ['SHARED quality', '--category', 'rules']);
  assert.deepEqual(found.entries, [rules]); assert.deepEqual(found.sources, catalog.sources); assert.equal(found.limited, true);
  assert.equal(searchCatalog(catalog, ['absent']).entries.length, 0);
  for (const args of [[], [' '], ['x'.repeat(201)], ['quality', '--category'], ['quality', '--bad', 'rules']]) {
    assert.throws(() => searchCatalog(catalog, args), /Usage/);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLayers } from '../src/shared/harness-cascade.js';
import type { HarnessHierarchyView } from '../src/shared/harness-navigation.js';
import { resourceModel, resourceSlot, setResource } from '../src/client/features/harness/hierarchy/model.js';

test('checkboxes disable every active slot, restore upstream and preserve unrelated settings', () => {
  const view = { layers: emptyLayers(), path: [], level: 'task' } as unknown as HarnessHierarchyView;
  view.layers.global = { first: { resource: 'guide:testing' }, second: { resource: 'guide:testing' }, language: { value: 'cs' } };
  let draft = setResource(view, {}, 'guide:testing', false);
  assert.deepEqual(draft, { first: null, second: null });
  assert.equal(resourceModel(view, draft).effective.language.binding?.value, 'cs');
  draft = setResource(view, draft, 'guide:testing', 'inherit');
  assert.deepEqual(draft, {});
  draft = setResource(view, draft, 'new', true);
  assert.deepEqual(draft[resourceSlot('new')], { resource: 'new' });
  const occupied = { [resourceSlot('new')]: { resource: 'other' } };
  assert.deepEqual(setResource(view, occupied, 'new', true)[resourceSlot('new')], { resource: 'other' });
});

test('canonical rows preserve alias bindings and disable or restore every matching slot', () => {
  const view = { layers: emptyLayers(), path: [], level: 'task' } as unknown as HarnessHierarchyView;
  view.layers.global = { old: { resource: 'legacy-id' }, current: { resource: 'el:project:one' } };
  const disabled = setResource(view, {}, 'el:project:one', false, ['legacy-id']);
  assert.deepEqual(disabled, { old: null, current: null });
  assert.deepEqual(setResource(view, disabled, 'el:project:one', 'inherit', ['legacy-id']), {});
  const orphanedDisable = { [resourceSlot('legacy-id')]: null };
  assert.deepEqual(setResource({ ...view, layers: emptyLayers() }, orphanedDisable, 'el:project:one', 'inherit', ['legacy-id']), {});
});

test('a draft kept on close comes back once, for its own floor, level and target', async () => {
  const { keepDraft, latestDraft, takeDraft } = await import('../src/client/features/harness/hierarchy/drafts.js');
  const layer = { quality: null };
  keepDraft({ floor: 'a', level: 'task', target: 'card', revision: 3, pathDigest: 'p', layer });
  keepDraft({ floor: 'a', level: 'repository', target: '', revision: 3, pathDigest: '', layer: {} });
  layer.quality = { resource: 'later' } as never;
  assert.deepEqual(latestDraft('a'), { level: 'repository', target: '' });
  assert.equal(latestDraft('b'), undefined);
  assert.equal(takeDraft('b', 'task', 'card'), undefined, 'another floor never sees it');
  assert.deepEqual(takeDraft('a', 'task', 'card'), { floor: 'a', level: 'task', target: 'card', revision: 3, pathDigest: 'p', layer: { quality: null } });
  assert.equal(takeDraft('a', 'task', 'card'), undefined, 'taken once');
  assert.ok(takeDraft('a', 'repository', ''));
  assert.equal(latestDraft('a'), undefined);
});

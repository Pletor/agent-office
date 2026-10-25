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

import test from 'node:test';
import assert from 'node:assert/strict';
import { preparationApiWorker, withPreparationAccess } from '../src/server/workers/preparation-access.js';
import type { Worker } from '../src/server/workers/types.js';
import type { Floor } from '../src/server/floor.js';

test('preparation credentials only read equipment/docs during the live claimed checker', async () => {
  const worker = { info: { id: 'reserved' }, preparing: true, hookToken: 'secret' } as Worker;
  let current = true, allowed = true;
  const floor = { workers: { get: () => worker.info }, opora: { executions: { controller: { allowed: () => allowed } } } } as unknown as Floor;
  const read = (query = 'accepted-kit=1', method = 'GET', token = 'secret', target = floor) =>
    preparationApiWorker(target, 'reserved', token, { method }, new URL('http://local/office/harness?worker=reserved&' + query));
  assert.equal(read(), undefined);
  await withPreparationAccess(worker, () => current, async () => {
    assert.equal(read(), worker.info); assert.equal(read('docs=1', 'POST'), worker.info);
    for (const query of ['catalog=1', 'kit=1', 'invocations=1', 'docs=1&catalog=1', 'accepted-kit=1&task=x',
      'accepted-kit=1&worker=other', 'accepted-kit=1&accepted-kit=1']) assert.equal(read(query), undefined);
    assert.equal(read('accepted-kit=1', 'POST'), undefined);
    assert.equal(read('accepted-kit=1', 'GET', 'wrong'), undefined);
    assert.equal(read('accepted-kit=1', 'GET', 'secret', { ...floor, workers: { get: () => ({ ...worker.info }) } } as Floor), undefined);
    allowed = false; assert.equal(read(), undefined); allowed = true;
    current = false; assert.equal(read(), undefined); current = true;
    worker.preparing = undefined; assert.equal(read(), undefined); worker.preparing = true;
    await assert.rejects(withPreparationAccess(worker, () => true, async () => {}), /already active/);
  });
  assert.equal(read(), undefined);
  await assert.rejects(withPreparationAccess(worker, () => true, async () => { throw new Error('checker failed'); }), /checker failed/);
  assert.equal(read(), undefined);
});

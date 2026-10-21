import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionClient, ExecutionError } from '../src/server/opora/execution-client.js';
import { ExecutionController } from '../src/server/opora/execution-controller.js';
import { ExecutionBudgetClock } from '../src/server/opora/execution-budget-clock.js';
import { budgetLease, flushBudget } from './support/opora-budget.js';

for (const outcome of ['success', 'rollback', 'transient', 'hung'] as const) {
  test(`fixed budget cap survives ${outcome} heartbeat and client wall-clock changes`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 0;
    const stopped: string[] = [];
    const client = new ExecutionClient('http://localhost', 'office');
    client.heartbeat = async () => {
      if (outcome === 'hung') return new Promise(() => {});
      if (outcome === 'transient') throw new ExecutionError(0, false);
      return { ...budgetLease(), serverNow: outcome === 'rollback' ? 90 : 130 };
    };
    const controller = new ExecutionController(client, () => {}, (_id, reason) => stopped.push(reason), () => now);
    controller.watch('worker', budgetLease(), 900000);
    now = 30000; t.mock.timers.tick(30000); await flushBudget();
    assert.equal(controller.allowed('worker'), true);
    t.mock.method(Date, 'now', () => -999999);
    now = 59999; t.mock.timers.tick(29999); await flushBudget();
    assert.equal(controller.allowed('worker'), true);
    now = 60000; t.mock.timers.tick(1); await flushBudget();
    assert.equal(controller.allowed('worker'), false);
    assert.equal(stopped.length, 1);
    controller.shutdown();
  });
}

test('first observed cap persists across forget/revalidation and immutable pin changes fail', async () => {
  const client = new ExecutionClient('http://localhost', 'office');
  let now = 0;
  client.heartbeat = async () => ({ ...budgetLease(), serverNow: 90 });
  const controller = new ExecutionController(client, () => {}, () => {}, () => now);
  controller.watch('worker', budgetLease(), 900000);
  controller.forget('worker');
  now = 1000;
  assert.equal((await controller.revalidate(budgetLease())).deadline, 60000);
  const caps = new ExecutionBudgetClock();
  assert.equal(caps.observe(budgetLease(), 0), 60000);
  assert.throws(() => caps.observe({ ...budgetLease(), budget: { ...budgetLease().budget!, policyHead: 'f'.repeat(40) } }, 0), /budget changed/);
  controller.shutdown();
});

test('budgeted shutdown requests stop while v1 shutdown keeps its legacy behavior', () => {
  const stopped: string[] = [];
  const controller = new ExecutionController(new ExecutionClient('http://localhost', 'office'), () => {}, id => stopped.push(id), () => 0);
  controller.watch('budgeted', budgetLease(), 60000);
  controller.watch('v1', { ...budgetLease(), executionProtocolVersion: undefined, budget: undefined }, 60000);
  controller.shutdown();
  assert.deepEqual(stopped, ['budgeted']);
  assert.equal(controller.allowed('budgeted'), false);
  assert.throws(() => controller.watch('late', budgetLease(), 60000), /shutting down/);
});

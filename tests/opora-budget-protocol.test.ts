import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionClient, ExecutionError, validateExecution } from '../src/server/opora/execution-client.js';
import { ExecutionController } from '../src/server/opora/execution-controller.js';
import { validateBudget, validateContext } from '../src/server/opora/execution-budget.js';
import { authorityBudget, budgetContext, budgetLease, budgetScope } from './support/opora-budget.js';

const claim = { ...budgetScope, expectedAcceptedHead: 'a'.repeat(40), expectedContextVersion: 'context',
  requestId: 'stable', ttlSeconds: 900, expectedBudgetPolicyHead: 'c'.repeat(40), previousExecutionId: null };

test('advertised v2 sends exact CAS fields and preserves latency-charged fixed runtime', async () => {
  const requests: { path: string; body?: Record<string, unknown> }[] = [];
  let now = 0;
  const client = new ExecutionClient('http://localhost', 'office', async (url, options) => {
    const path = new URL(String(url)).pathname;
    requests.push({ path, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (path.endsWith('/context')) return Response.json(budgetContext());
    now += 1000;
    return Response.json({ ...budgetLease(), serverNow: path.endsWith('/heartbeat') ? 101 : 100 });
  });
  const controller = new ExecutionController(client, () => {}, () => {}, () => now);
  const grant = await controller.claim(budgetScope);
  assert.equal(grant.deadline, 60000);
  assert.deepEqual(Object.keys(requests[1].body!).sort(), Object.keys(claim).sort());
  assert.equal(requests[1].body!.expectedBudgetPolicyHead, 'c'.repeat(40));
  assert.equal(requests[1].body!.previousExecutionId, null);
  assert.equal('expectedBudgetPolicyHead' in requests[2].body!, false);
  controller.shutdown();
});

test('v2 rejection never retries v1 and unsupported advertisement cannot claim', async () => {
  for (const version of [2, 3]) {
    const requests: string[] = [];
    const client = new ExecutionClient('http://localhost', 'office', async (url) => {
      const endpoint = String(url); requests.push(endpoint);
      return endpoint.includes('/context?') ? Response.json({ ...budgetContext(), executionProtocolVersion: version })
        : Response.json({ error: 'PRIVATE-token' }, { status: 409 });
    });
    const controller = new ExecutionController(client, () => {}, () => {});
    await assert.rejects(controller.claim(budgetScope), error => error instanceof ExecutionError && error.terminal && !error.message.includes('PRIVATE'));
    assert.equal(requests.filter(value => new URL(value).pathname.endsWith('/claim')).length, version === 2 ? 1 : 0);
  }
});

test('uncertain v2 claim preserves version, previous execution and request without refetching v1', async () => {
  const client = new ExecutionClient('http://localhost', 'office');
  let previews = 0;
  client.context = async () => { previews++; return { ...budgetContext(), budget: { ...budgetContext().budget!, latestExecutionId: 'f'.repeat(32) } }; };
  const requests: unknown[] = [];
  client.claim = async payload => { requests.push(structuredClone(payload)); if (requests.length === 1) throw new ExecutionError(0, false); return budgetLease(); };
  client.heartbeat = async () => budgetLease();
  const controller = new ExecutionController(client, () => {}, () => {}, () => 0);
  await assert.rejects(controller.claim(budgetScope));
  await controller.claim(budgetScope);
  assert.equal(previews, 1);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal((requests[1] as typeof claim).previousExecutionId, 'f'.repeat(32));
  controller.shutdown();
});

test('v2 client rejects immutable budget mutation, assignment replacement and silent version downgrade', async () => {
  const original = budgetLease();
  const patches = [{ executionProtocolVersion: 1, budget: undefined },
    { budget: { ...authorityBudget(), policyHead: 'f'.repeat(40) } },
    { budget: { ...authorityBudget(), allocationId: 'f'.repeat(40) } },
    { budget: { ...authorityBudget(), familyId: 'f'.repeat(40) } },
    { budget: { ...authorityBudget(), attempt: 2, kind: 'retry' } },
    { budget: { ...authorityBudget(), admittedAt: 99, runDeadlineAt: 159 }, expiresAt: 159 },
    { budget: { ...authorityBudget(), maxRunSeconds: 61, runDeadlineAt: 161 } },
    { assignment: { contextVersion: 'context', documents: { card: 'live brief replacement' } } }];
  for (const patch of patches) {
    const client = new ExecutionClient('http://localhost', 'office', async () => Response.json({ ...original, ...patch }));
    await assert.rejects(client.heartbeat(original, 900), error => error instanceof ExecutionError && error.terminal);
  }
  const v1 = { ...budgetLease(), executionProtocolVersion: undefined, budget: undefined, expiresAt: 1000 };
  assert.equal(validateExecution(v1, budgetScope).executionProtocolVersion, undefined);
  const client = new ExecutionClient('http://localhost', 'office', async () => Response.json(v1));
  await assert.rejects(client.claim(claim), /different budget protocol/);
});

test('budget DTOs reject missing, private, malformed and inconsistent fields', () => {
  for (const budget of [{ ...authorityBudget(), token: 'PRIVATE' }, { ...authorityBudget(), attempt: 0 },
    { ...authorityBudget(), maxRunSeconds: 29 }, { ...authorityBudget(), runDeadlineAt: 161 },
    { ...authorityBudget(), repairRound: 1 }, { ...authorityBudget(), allocationId: 'bad' }])
    assert.throws(() => validateBudget(budget));
  for (const context of [{ ...budgetContext(), executionProtocolVersion: 3 },
    { ...budgetContext(), executionProtocolVersion: undefined },
    { ...budgetContext(), budget: { ...budgetContext().budget, policyHead: null } },
    { ...budgetContext(), budget: { ...budgetContext().budget, latestExecutionId: 'bad' } },
    { ...budgetContext(), budget: { ...budgetContext().budget, enrolled: false } }])
    assert.throws(() => validateContext(context));
  assert.throws(() => validateExecution({ ...budgetLease(), expiresAt: 161 }, budgetScope));
  assert.throws(() => validateExecution({ ...budgetLease(), serverNow: 160, expiresAt: 161 }, budgetScope));
});

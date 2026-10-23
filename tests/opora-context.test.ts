import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecutionClient, ExecutionError, validateExecution, type ExecutionLease } from '../src/server/opora/execution-client.js';
import { ExecutionController } from '../src/server/opora/execution-controller.js';
import { ExecutionDispatch } from '../src/server/opora/execution-dispatch.js';
import { executionPrompt } from '../src/server/opora/execution-prompt.js';
import { reportExecution } from '../src/server/opora/execution-worker.js';
import { validateBudgetFiles } from '../src/server/opora/execution-budget-files.js';
import { contextVersionFromEnvironment, validateContextProof } from '../src/server/opora/execution-context.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { budgetLease, budgetScope } from './support/opora-budget.js';

const proof = () => ({ contextProtocolVersion: 2 as const, originAcceptedRevision: 'a'.repeat(40),
  checkedAcceptedRevision: 'a'.repeat(40), acceptedRevisionsChecked: 1, liveTransitionsChecked: 0,
  acceptedScopeUnchanged: true as const, liveScopeUnchanged: true as const });
function lease(budgeted = false): ExecutionLease {
  return { ...budgetLease(), ...(!budgeted ? { executionProtocolVersion: 1, budget: undefined } : {}),
    contextProtocolVersion: 2, contextValidation: proof(),
    assignment: { contextProtocolVersion: 2, contextVersion: 'c'.repeat(64), documents: { card: 'accepted' } } };
}
const info = (id: string) => ({ id, via: 'opora', status: 'working' }) as WorkerInfo;
function directory(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}

test('context v2 POST negotiation is explicit and independent of budget protocol', async () => {
  const requests: { method?: string; body?: unknown }[] = [];
  const client = new ExecutionClient('http://localhost', 'office', async (_url, options) => {
    requests.push({ method: options?.method, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    return Response.json({ available: true, unavailableReason: null, acceptedHead: 'a'.repeat(40), contextVersion: 'c'.repeat(64),
      executionProtocolVersion: 1, contextProtocolVersion: requests.length === 1 ? 2 : 1 });
  });
  assert.equal((await client.context(budgetScope, 2)).executionProtocolVersion, 1);
  await client.context(budgetScope);
  assert.deepEqual(requests, [{ method: 'POST', body: { ...budgetScope, contextProtocolVersion: 2 } }, { method: 'GET', body: undefined }]);
});

test('sparse claim replay preserves opt-in and request while unavailable servers never fall back', async () => {
  const requests: Record<string, unknown>[] = [];
  let previews = 0;
  const client = new ExecutionClient('http://localhost', 'office', async (url, options) => {
    if (String(url).endsWith('/context')) {
      previews++; return Response.json({ available: true, unavailableReason: null, acceptedHead: 'a'.repeat(40),
        contextVersion: 'c'.repeat(64), executionProtocolVersion: 1, contextProtocolVersion: 2 });
    }
    if (new URL(String(url)).pathname.endsWith('/claim')) {
      requests.push(JSON.parse(String(options?.body)));
      if (requests.length === 1) throw new Error('uncertain delivery');
    }
    return Response.json(lease());
  });
  const controller = new ExecutionController(client, () => {}, () => {}, () => 0);
  await assert.rejects(controller.claim(budgetScope, 2));
  await assert.rejects(controller.claim(budgetScope, 1), /another context protocol/);
  await controller.claim(budgetScope, 2);
  assert.equal(previews, 1);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].contextProtocolVersion, 2);
  assert.equal('expectedBudgetPolicyHead' in requests[0], false);
  controller.shutdown();
  let calls = 0;
  const older = new ExecutionClient('http://localhost', 'office', async () => { calls++; return Response.json({
    available: true, acceptedHead: 'a'.repeat(40), contextVersion: 'old' }); });
  await assert.rejects(older.context(budgetScope, 2), ExecutionError);
  assert.equal(calls, 1);
});

test('sparse proofs permit checked-head advances but reject malformed proofs and immutable changes', async () => {
  const original = lease(true);
  const advanced = { ...original, contextValidation: { ...proof(), checkedAcceptedRevision: 'd'.repeat(40), acceptedRevisionsChecked: 2, liveTransitionsChecked: 1 } };
  const client = new ExecutionClient('http://localhost', 'office', async () => Response.json(advanced));
  assert.deepEqual((await client.heartbeat(original, 900)).budget, original.budget);
  for (const patch of [{ contextProtocolVersion: 1 }, { contextProtocolVersion: 3 }, { contextValidation: undefined },
    { contextValidation: { ...proof(), originAcceptedRevision: 'd'.repeat(40) } },
    { contextValidation: { ...proof(), acceptedRevisionsChecked: 257 } },
    { contextValidation: { ...proof(), liveTransitionsChecked: -1 } },
    { contextValidation: { ...proof(), privatePin: 'secret' } }, { privatePin: { secret: 'hidden' } },
    { assignment: { ...original.assignment, contextVersion: 'e'.repeat(64) } },
    { budget: { ...original.budget, allocationId: 'f'.repeat(40) } }]) {
    const broken = new ExecutionClient('http://localhost', 'office', async () => Response.json({ ...original, ...patch }));
    await assert.rejects(broken.heartbeat(original, 900), ExecutionError);
  }
  assert.throws(() => validateContextProof({ ...proof(), acceptedScopeUnchanged: false }, original.acceptedRevision));
  assert.throws(() => validateExecution({ ...lease(), contextProtocolVersion: undefined, contextValidation: undefined }, budgetScope));
});

test('sparse dispatch skips mutable preparation and decoration; v1 keeps both callbacks', async t => {
  const previous = process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION;
  t.after(() => { if (previous === undefined) delete process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION; else process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION = previous; });
  for (const version of [1, 2]) {
    if (version === 2) process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION = '2'; else delete process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION;
    const dispatch = new ExecutionDispatch('http://localhost', 'office', directory(t), () => [], () => {}, () => {});
    const grant = version === 2 ? lease() : { ...budgetLease(), executionProtocolVersion: 1 as const, budget: undefined };
    let prepared = 0, decorated = 0;
    dispatch.controller.claim = async (_scope, selected) => { assert.equal(selected, version); return { lease: grant, deadline: performance.now() + 50000 }; };
    const result = await dispatch.dispatch(budgetScope, async () => { prepared++; return 'MUTABLE_HARNESS'; }, prompt => {
      if (version === 2) { assert.doesNotMatch(prompt, /MUTABLE/); assert.match(prompt, /opora-office-execution\/2/); }
      return info('worker');
    }, prompt => { decorated++; return prompt + 'MUTABLE_REA'; });
    assert.equal(prepared, version === 2 ? 0 : 1);
    assert.equal(decorated, version === 2 ? 0 : 1);
    assert.equal(result.execution.contextProtocolVersion ?? 1, version);
    dispatch.controller.shutdown();
  }
  assert.equal(contextVersionFromEnvironment('2'), 2);
  for (const version of ['', '1', '3', ' 2 ']) assert.throws(() => contextVersionFromEnvironment(version));
});

test('sparse restart validates immutable files even with budget v1 and stops on shutdown', async t => {
  const dir = directory(t), original = lease();
  const prompt = executionPrompt(dir, 'http://localhost', 'office', original, 'MUTABLE_LIVE_CONTEXT');
  assert.doesNotMatch(prompt, /PRIVATE-token|MUTABLE_LIVE_CONTEXT/);
  const runs = [{ workerId: 'saved', execution: original }], stops: string[] = [];
  const dispatch = new ExecutionDispatch('http://localhost', 'office', dir, () => runs, () => {}, id => stops.push(id));
  dispatch.client.heartbeat = async value => value;
  assert.equal(dispatch.guard.keepOnRestart!(info('saved')), false);
  assert.equal(await dispatch.guard.restore(info('saved')), undefined);
  const stem = path.join(dir, 'opora-executions', original.executionId);
  const bundle = JSON.parse(readFileSync(stem + '.json', 'utf8'));
  writeFileSync(stem + '.json', JSON.stringify({ ...bundle, contextProtocolVersion: 1 }));
  assert.throws(() => validateBudgetFiles(dir, 'http://localhost', 'office', original));
  writeFileSync(stem + '.json', JSON.stringify(bundle));
  unlinkSync(stem + '-assignment.json');
  assert.match((await dispatch.guard.restore(info('saved')))!, /could not be revalidated/);
  assert.deepEqual(stops, ['saved']);
  dispatch.controller.shutdown();
  const stopped: string[] = [];
  const controller = new ExecutionController(dispatch.client, () => {}, id => stopped.push(id), () => 0);
  controller.watch('shutdown', original, 50000);
  controller.shutdown();
  assert.deepEqual(stopped, ['shutdown']);
});

test('sparse result receipt requires version and original proof while output excludes capabilities', async t => {
  const dir = directory(t), original = lease();
  executionPrompt(dir, 'http://localhost', 'office', original);
  const stem = path.join(dir, 'opora-executions', original.executionId);
  const result = path.join(dir, 'result.json');
  writeFileSync(result, JSON.stringify({ summary: 'Reported' }));
  let changed = false;
  const transport: typeof fetch = async () => Response.json({ receiptId: 'receipt', executionId: original.executionId, state: 'reported',
    contextProtocolVersion: 2, contextValidation: { ...proof(), ...(changed ? { originAcceptedRevision: 'f'.repeat(40) } : {}) }, token: 'PRIVATE-token' });
  const receipt = await reportExecution(stem + '.json', result, transport);
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|contextValidation|token/);
  changed = true;
  await assert.rejects(reportExecution(stem + '.json', result, transport));
});

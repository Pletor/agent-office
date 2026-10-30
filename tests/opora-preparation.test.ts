import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecutionDispatch } from '../src/server/opora/execution-dispatch.js';
import type { ExecutionLease } from '../src/server/opora/execution-client.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const scope = { project: 'project', workspace: 'draft', nodeId: 'card' };
const lease = (): ExecutionLease => ({ ...scope, executionId: 'execution', token: 'fixture', epoch: 1,
  acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64),
  assignment: { contextVersion: 'context', documents: { card: 'accepted task' } }, state: 'running', serverNow: 100, expiresAt: 1000 });

test('both context versions prepare before claim and retain guarded start; sparse context skips live task text', async t => {
  const previous = process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION;
  t.after(() => { if (previous === undefined) delete process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION; else process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION = previous; });
  for (const version of ['1', '2']) {
    if (version === '2') process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION = '2'; else delete process.env.AGENT_OFFICE_OPORA_CONTEXT_VERSION;
    const dir = mkdtempSync(path.join(tmpdir(), 'office-preclaim-'));
    const order: string[] = [];
    const dispatch = new ExecutionDispatch('http://localhost:1', 'office', dir, () => [], () => {}, () => {});
    try {
      dispatch.controller.claim = async (_scope, requested) => {
        assert.equal(requested, Number(version)); assert.equal(order.at(-1), 'prepared');
        const granted = lease();
        if (version === '2') {
          granted.contextProtocolVersion = 2;
          granted.assignment = { ...granted.assignment, contextProtocolVersion: 2 };
          granted.contextValidation = { contextProtocolVersion: 2, originAcceptedRevision: granted.acceptedRevision,
            checkedAcceptedRevision: granted.acceptedRevision, acceptedRevisionsChecked: 1, liveTransitionsChecked: 0,
            acceptedScopeUnchanged: true, liveScopeUnchanged: true };
        }
        order.push('claim'); return { lease: granted, deadline: performance.now() + 10_000 };
      };
      const result = await dispatch.dispatch(scope, async () => { order.push('live-context'); return 'live'; },
        () => { throw new Error('legacy seating must not run'); }, undefined, undefined, async () => {
          order.push('prepared');
          return { start(prompt) {
            order.push('start'); const info = { id: 'worker', via: 'opora', prompt, status: 'working' } as WorkerInfo;
            assert.equal(dispatch.guard.check(info), undefined); return info;
          }, cancel: async () => { throw new Error('successful worker must not be cancelled'); } };
        });
      assert.equal(result.worker.id, 'worker'); assert.equal(dispatch.controller.allowed('worker'), true);
      assert.deepEqual(order, [...(version === '1' ? ['live-context'] : []), 'prepared', 'claim', 'start']);
    } finally { dispatch.controller.shutdown(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('claim refusal cancels the prepared reservation without attempting a worker start', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-preclaim-refusal-'));
  const dispatch = new ExecutionDispatch('http://localhost:1', 'office', dir, () => [], () => {}, () => {});
  let cancelled = 0;
  try {
    dispatch.controller.claim = async () => { throw new Error('accepted revision changed'); };
    await assert.rejects(dispatch.dispatch(scope, async () => '', () => { throw new Error('must not seat'); }, undefined, undefined,
      async () => ({ start: () => { throw new Error('must not start'); }, cancel: async () => { cancelled++; return {}; } })), /revision changed/);
    assert.equal(cancelled, 1);
    dispatch.controller.claim = async () => { throw new Error('must not claim'); };
    await assert.rejects(dispatch.dispatch(scope, async () => '', () => { throw new Error('must not seat'); }, undefined, undefined,
      async () => { throw new Error('installer failed'); }), /installer failed/);
  } finally { dispatch.controller.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test('an XL assignment (run.handout: false) is released after the claim and no worker starts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-xl-'));
  const dispatch = new ExecutionDispatch('http://localhost:1', 'office', dir, () => [], () => {}, () => {});
  let cancelled = 0;
  try {
    dispatch.controller.claim = async () => {
      const granted = lease();
      granted.assignment = { ...granted.assignment, run: { label: 'XL', effort: 'xhigh', model: 'sonnet', advisor: 'opus', handout: false, humanReview: false } };
      return { lease: granted, deadline: performance.now() + 10_000 };
    };
    await assert.rejects(dispatch.dispatch(scope, async () => '', () => { throw new Error('must not seat'); }, undefined, undefined,
      async () => ({ start: () => { throw new Error('must not start'); }, cancel: async () => { cancelled++; return {}; } })), /XL – srdce ji rozdělí/);
    assert.equal(cancelled, 1);
  } finally { dispatch.controller.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test('the claimed assignment run is what the worker is seated with', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-run-'));
  const dispatch = new ExecutionDispatch('http://localhost:1', 'office', dir, () => [], () => {}, () => {});
  try {
    dispatch.controller.claim = async () => {
      const granted = lease();
      granted.assignment = { ...granted.assignment, run: { label: 'XS', effort: 'low', model: 'sonnet', advisor: null, handout: true, humanReview: false } };
      return { lease: granted, deadline: performance.now() + 10_000 };
    };
    let seen: unknown;
    const result = await dispatch.dispatch(scope, async () => '', (prompt, cardModel) => {
      seen = cardModel; const info = { id: 'worker', via: 'opora', prompt, status: 'working' } as WorkerInfo;
      assert.equal(dispatch.guard.check(info), undefined); return info;
    });
    assert.equal(result.worker.id, 'worker');
    assert.deepEqual(seen, { model: 'sonnet', effort: 'low', fromRun: true });
  } finally { dispatch.controller.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

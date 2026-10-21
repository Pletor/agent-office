import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkerInfo, GhPull, QueueTask } from '../src/shared/protocol.js';
import { projectWall, processRow, visibleRows, connectionLabel, WallHistory, type WallInput } from '../src/client/features/process-wall/model.js';

const worker = (changes: Partial<WorkerInfo> = {}): WorkerInfo => ({ id: 'w1', kind: 'agent', deskId: 'desk-1', name: 'Developer', color: '#06d6a0', status: 'working', acked: false, createdBy: 'test', createdAt: 1, cols: 80, rows: 24, viewers: [], viewerIds: [], worktree: { path: 'work/w1', branch: 'office/w1', base: 'main' }, ...changes });
const pull = (changes: Partial<GhPull> = {}): GhPull => ({ number: 12, title: 'Change', state: 'OPEN', isDraft: false, url: 'https://github.com/team/repo/pull/12', author: 'test', labels: [], reviewDecision: '', headRefName: 'office/w1', headRefOid: 'abc', baseRefName: 'main', createdAt: '', updatedAt: '', additions: 2, deletions: 1, checks: 'none', body: '', closes: [], ...changes });
const task = (changes: Partial<QueueTask> = {}): QueueTask => ({ id: 't1', title: 'Task', prompt: '', addedBy: 'test', addedAt: 1, status: 'running', workerId: 'w1', ...changes });
const input = (changes: Partial<WallInput> = {}): WallInput => ({ floor: 'Project', workers: [worker()], tasks: [task()], pulls: { items: [pull()], fetchedAt: 123, loading: false }, connected: true, ready: true, at: 200, ...changes });

test('queue, worker and branch-matched PR form one traceable process row', () => {
  const state = projectWall(input());
  assert.equal(state.rows.length, 1); assert.equal(state.rows[0].pr?.number, 12);
  assert.equal(state.rows[0].branch, 'office/w1'); assert.equal(state.rows[0].phase, 3);
  assert.match(state.rows[0].detail, /nejsou doložené/);
});
test('finished agent, pending checks and approval never imply merge', () => {
  assert.equal(processRow(undefined, worker({ status: 'done' })).phase, 4);
  assert.equal(processRow(undefined, worker(), pull({ checks: 'pending' })).phase, 2);
  assert.equal(processRow(undefined, worker(), pull({ checks: 'pass', reviewDecision: 'APPROVED' })).phase, 3);
  const merged = processRow(undefined, worker({ status: 'needs_input' }), pull({ state: 'MERGED' }));
  assert.equal(merged.phase, 5); assert.equal(merged.blocked, false); assert.equal(merged.moving, false);
  assert.match(merged.detail, /nasazení nesledujeme/);
});
test('blocking inputs, failed checks, lost worktrees and failed queue outcomes remain visible', () => {
  for (const row of [processRow(undefined, worker({ status: 'needs_input' })), processRow(undefined, worker(), pull({ checks: 'fail' })), processRow(undefined, worker(), pull({ reviewDecision: 'CHANGES_REQUESTED' })), processRow(task({ outcome: 'failed', error: 'failed' })), processRow(undefined, worker({ lost: { branch: 'here' } }))]) assert.equal(row.blocked, true);
  const s = projectWall(input({ workers: [worker({ status: 'needs_input' }), worker({ id: 'w2', name: 'Second', worktree: undefined })] }));
  assert.equal(visibleRows(s, 'blockers').length, 1); assert.equal(visibleRows(s, 'workers').length, 2);
});
test('disconnect and reconnect show stale state until a fresh floor snapshot', () => {
  assert.match(connectionLabel(projectWall(input({ connected: false }))), /ODPOJENO/);
  assert.match(connectionLabel(projectWall(input({ connected: true, ready: false }))), /SYNCHRONIZACE/);
  assert.match(connectionLabel(projectWall(input())), /ŽIVĚ/);
  const empty = projectWall(input({ workers: [], tasks: [], pulls: { items: [], fetchedAt: 0, loading: true } }));
  assert.equal(empty.rows.length, 0); assert.equal(empty.running, 0);
});
test('history deduplicates snapshots, caps memory and clears between floors', () => {
  const history = new WallHistory(); const s = projectWall(input());
  history.observe(s); history.observe({ ...s, at: 300 }); assert.equal(history.entries.length, 1);
  for (let i = 0; i < 100; i++) history.observe({ ...s, at: i, rows: s.rows.map(r => ({ ...r, detail: 'change ' + i })) });
  assert.equal(history.entries.length, 80); history.clear(); assert.equal(history.entries.length, 0);
  history.observe(s); assert.equal(history.entries.length, 1);
});

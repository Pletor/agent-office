import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduceEvent, canMerge, parseRepository, type StudioState, type EventType, type StudioEvent } from '../src/client/process-studio/model.js';
import { eventFor, scenario } from '../src/client/process-studio/scenario.js';
import { processStudioRoute } from '../src/server/http/routes/process-studio.js';
import { PIPELINE } from '../src/client/process-studio/pipeline-model.js';

function apply(s: StudioState, type: EventType, extras: Partial<StudioEvent> = {}): StudioState {
  const result = reduceEvent(s, { ...eventFor({ type, message: type }, s.run, s.sequence + 1), ...extras });
  assert.equal(result.error, undefined, `${type}: ${result.error}`); return result.state;
}
function until(type: EventType, repos: ReturnType<typeof parseRepository>[] = []): StudioState {
  let state = initialState(repos);
  for (const scene of scenario(repos)) {
    if (state.waiting) state = apply(state, 'human.approve');
    state = apply(state, scene.type, scene);
    if (scene.type === type) return state;
  }
  throw new Error(`Missing ${type}`);
}
test('complete scenario repairs a regression, waits for a person and reuses evidenced memory', () => {
  let state = initialState(); let invalidated = false;
  for (const scene of scenario([])) {
    if (state.waiting) {
      assert.equal(canMerge(state), false);
      assert.ok(reduceEvent(state, eventFor({ type: 'merge.confirm', message: '' }, state.run, state.sequence + 1)).error);
      state = apply(state, 'human.approve');
    }
    state = apply(state, scene.type, scene);
    if (scene.type === 'repair.plan') { invalidated = true; assert.equal(state.checksRevision, 0); assert.equal(state.accepted, false); }
  }
  assert.ok(invalidated); assert.equal(state.revision, 3); assert.equal(state.finished, true);
  assert.equal(state.memory, 'reused'); assert.equal(state.merged, true);
});
test('a plan gap blocks acceptance and work dispatch without changing state', () => {
  const state = until('plan.gap');
  for (const type of ['plan.accept', 'work.assign', 'checks.pass'] as const) {
    const result = reduceEvent(state, eventFor({ type, message: '' }, state.run, state.sequence + 1));
    assert.ok(result.error); assert.equal(result.state, state);
  }
});
test('merge refuses stale checks or review and memory refuses premature writes', () => {
  const approved = apply(until('human.wait'), 'human.approve');
  assert.ok(canMerge(approved));
  for (const field of ['checksRevision', 'reviewRevision', 'prRevision', 'approvalRevision'] as const) {
    const stale = { ...approved, [field]: approved.revision - 1 };
    assert.equal(canMerge(stale), false);
    assert.ok(reduceEvent(stale, eventFor({ type: 'merge.confirm', message: '' }, stale.run, stale.sequence + 1)).error);
  }
  for (const type of ['memory.propose', 'memory.persist', 'memory.reuse'] as const) {
    assert.ok(reduceEvent(approved, eventFor({ type, message: '' }, approved.run, approved.sequence + 1)).error);
  }
});
test('duplicate, out-of-order and foreign-run events never alter the current snapshot', () => {
  const state = initialState(); const event = eventFor({ type: 'plan.draft', message: '' }, state.run, 1);
  const next = reduceEvent(state, event).state;
  for (const bad of [event, { ...event, id: 'other', sequence: 3 }, { ...event, id: 'foreign', run: 'other', sequence: 2 }]) {
    const result = reduceEvent(next, bad); assert.ok(result.error); assert.equal(result.state, next);
  }
  assert.equal(state.nodes.plan.status, 'queued');
});
test('a repository extension creates a plan node and cannot be omitted from checks', () => {
  const repo = parseRepository('https://github.com/example/quality-kit.git', 'check', []);
  const all = scenario([repo]); let state = initialState([repo]);
  for (const scene of all) {
    if (scene.type === 'checks.pass') {
      const omitted = reduceEvent(state, eventFor({ ...scene, repositoryIds: [] }, state.run, state.sequence + 1));
      assert.ok(omitted.error); assert.equal(omitted.state, state); break;
    }
    state = apply(state, scene.type, scene);
  }
  const finished = until('run.finish', [repo]); assert.equal(finished.nodes[repo.id].status, 'done');
  assert.ok(finished.evidence.some(e => e.node === repo.id));
});
test('repository identity rejects unsafe, duplicate and unsupported inputs', () => {
  const repo = parseRepository('https://github.com/team/module/', 'module', []);
  assert.equal(repo.url, 'https://github.com/team/module');
  for (const bad of ['javascript:alert(1)', 'https://github.com.evil.test/team/repo', 'https://user:secret@github.com/team/repo', 'https://github.com/team/repo/tree/main', 'https://github.com/team/repo?token=x', 'https://github.com/team/<img>']) assert.throws(() => parseRepository(bad, 'module', []));
  assert.throws(() => parseRepository(repo.url.toUpperCase(), 'context', [repo]));
  assert.throws(() => parseRepository(repo.url, 'unknown', []));
  assert.throws(() => parseRepository('https://github.com/team/next', 'module', [repo, repo, repo, repo]));
});
test('the standalone studio uses the session-authenticated route registry', () => {
  assert.equal(processStudioRoute.auth, 'session'); assert.equal(processStudioRoute.method, 'GET');
});

test('delivery handoffs cannot skip predecessors, repeat or complete without their inputs', () => {
  let state = initialState();
  for (const scene of scenario([])) {
    if (state.waiting) state = apply(state, 'human.approve');
    if (scene.type === 'pipeline.observe') {
      const next = PIPELINE[state.pipeline.length + 1];
      if (next) assert.ok(reduceEvent(state, eventFor({ ...scene, stage: next.id }, state.run, state.sequence + 1)).error);
      if (scene.stage === 'queue') {
        const stale = { ...state, approvalRevision: 0 };
        assert.ok(reduceEvent(stale, eventFor(scene, stale.run, stale.sequence + 1)).error);
      }
      if (scene.stage === 'release') {
        const unmerged = { ...state, merged: false };
        assert.ok(reduceEvent(unmerged, eventFor(scene, unmerged.run, unmerged.sequence + 1)).error);
      }
      state = apply(state, scene.type, scene);
      assert.ok(reduceEvent(state, eventFor(scene, state.run, state.sequence + 1)).error);
    } else state = apply(state, scene.type, scene);
  }
  assert.deepEqual(state.pipeline, PIPELINE.map(step => step.id));
});

test('review, human handoff, merge and memory require delivery evidence as well as old gates', () => {
  for (const [target, missing] of [['review.pass', 'independent'], ['human.wait', 'ci'], ['merge.confirm', 'queue'], ['memory.propose', 'close'], ['run.finish', 'evaluate']] as const) {
    let state = initialState();
    for (const scene of scenario([])) {
      if (state.waiting) state = apply(state, 'human.approve');
      if (scene.type === target) {
        const incomplete = { ...state, pipeline: state.pipeline.filter(id => id !== missing) };
        const result = reduceEvent(incomplete, eventFor(scene, incomplete.run, incomplete.sequence + 1));
        assert.ok(result.error, target); assert.equal(result.state, incomplete); break;
      }
      state = apply(state, scene.type, scene);
    }
  }
});

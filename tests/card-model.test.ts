import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignmentModel, cardEffortOf, cardModel, fillCardModel, readRun, runOf } from '../src/server/opora/card-model.js';

test('the table maps card effort to model, effort and advisor', () => {
  assert.deepEqual(cardModel('low'), { model: 'sonnet', effort: 'low' });
  assert.deepEqual(cardModel('medium'), { model: 'sonnet', effort: 'medium', advisor: 'opus' });
  assert.deepEqual(cardModel(undefined), { model: 'sonnet', effort: 'medium', advisor: 'opus' });
  assert.deepEqual(cardModel('high'), { model: 'sonnet', effort: 'high', advisor: 'opus' });
  assert.deepEqual(cardModel('xhigh'), { model: 'sonnet', effort: 'xhigh', advisor: 'opus' });
  assert.deepEqual(cardModel('max'), { model: 'opus', effort: 'high' });
});

test('the effort is read from the assignment, unknown values are ignored', () => {
  assert.equal(cardEffortOf({ specification: { node: { card: { effort: 'xhigh' } } } }), 'xhigh');
  assert.equal(cardEffortOf({ specification: { node: { card: { effort: 'huge' } } } }), undefined);
  assert.equal(cardEffortOf({ specification: {} }), undefined);
  assert.equal(cardEffortOf(undefined), undefined);
});

test('only a Claude worker is filled, and only what nobody chose', () => {
  const free = { provider: 'claude' } as { provider: string; model?: string; effort?: 'low'; advisor?: string };
  fillCardModel(free, cardModel('high'));
  assert.deepEqual(free, { provider: 'claude', model: 'sonnet', effort: 'high', advisor: 'opus' });
  const chosen = { provider: 'claude', model: 'haiku' } as { provider: string; model?: string; effort?: 'low'; advisor?: string };
  fillCardModel(chosen, cardModel('high'));
  assert.deepEqual(chosen, { provider: 'claude', model: 'haiku', effort: 'high' });
  const other = { provider: 'codex' };
  fillCardModel(other, cardModel('max'));
  assert.deepEqual(other, { provider: 'codex' });
});

type Target = { provider: string; model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; advisor?: string };
const run = (extra: Record<string, unknown> = {}) => ({ label: 'M', effort: 'high', model: 'opus', advisor: 'opus', handout: true, humanReview: false, ...extra });

test('the assignment run is read as Opora pins it, an unknown model falls back to the table and an unknown effort means no run', () => {
  assert.deepEqual(runOf({ run: run() }), { label: 'M', effort: 'high', model: 'opus', advisor: 'opus', handout: true, humanReview: false });
  assert.deepEqual(readRun(run({ label: 'XL', advisor: null, handout: false, humanReview: true })), { label: 'XL', effort: 'high', model: 'opus', handout: false, humanReview: true });
  assert.equal(readRun(run({ model: 'gpt-9' }))?.model, 'sonnet');
  assert.equal(readRun(run({ effort: 'huge' })), undefined);
  assert.equal(runOf({ specification: {} }), undefined);
  assert.equal(runOf(undefined), undefined);
});

test('run beats the floor default and the card effort: model, effort and advisor are the run ones', () => {
  const assignment = { run: run({ effort: 'xhigh', model: 'sonnet', advisor: 'opus' }), specification: { node: { card: { effort: 'low' } } } };
  const pick = assignmentModel(assignment);
  assert.deepEqual(pick, { model: 'sonnet', effort: 'xhigh', advisor: 'opus', fromRun: true });
  const floorDefault: Target = { provider: 'claude', model: 'fable', effort: 'max' };
  fillCardModel(floorDefault, pick);
  assert.deepEqual(floorDefault, { provider: 'claude', model: 'sonnet', effort: 'xhigh', advisor: 'opus' });
  const noAdvisor: Target = { provider: 'claude', advisor: 'opus' };
  fillCardModel(noAdvisor, assignmentModel({ run: run({ effort: 'low', model: 'sonnet', advisor: null }) }));
  assert.deepEqual(noAdvisor, { provider: 'claude', model: 'sonnet', effort: 'low' });
  const codex: Target = { provider: 'codex', model: 'gpt-5.5' };
  fillCardModel(codex, pick);
  assert.deepEqual(codex, { provider: 'codex', model: 'gpt-5.5' });
});

test('without a run (an older claim) the card effort fills only what the floor default left open', () => {
  const pick = assignmentModel({ specification: { node: { card: { effort: 'high' } } } });
  assert.deepEqual(pick, { model: 'sonnet', effort: 'high', advisor: 'opus' });
  const floorDefault: Target = { provider: 'claude', model: 'fable', effort: 'medium' };
  fillCardModel(floorDefault, pick);
  assert.deepEqual(floorDefault, { provider: 'claude', model: 'fable', effort: 'medium' });
  const open: Target = { provider: 'claude' };
  fillCardModel(open, assignmentModel({}));
  assert.deepEqual(open, { provider: 'claude', model: 'sonnet', effort: 'medium', advisor: 'opus' });
});

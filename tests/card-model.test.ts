import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardEffortOf, cardModel, fillCardModel } from '../src/server/opora/card-model.js';

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

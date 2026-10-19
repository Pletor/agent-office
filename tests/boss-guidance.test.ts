import test from 'node:test';
import assert from 'node:assert/strict';
import { completionBlockers } from '../src/server/boss-attention/completion.js';
import { approvalGuidance, questionGuidance, systemGuidance } from '../src/server/boss-attention/guidance.js';
import { EMPTY_OPORA } from '../src/shared/opora.js';

const valid = () => ({
  readOnly: false, node: { name: '[task] Test', checks: [{ id: 'unit', command: 'npm test' }] },
  pipeline: { current: null, stuck: [], stages: [{ id: 'work', title: 'Práce', status: 'passed' }] },
  loop: { openBlocks: 0, waitingOnHuman: [] }, blocks: [],
  evidence: { tests: { status: 'passed', url: '', note: '' },
    review: { status: 'passed', url: 'https://example.test/review', note: '' },
    merge: { status: 'passed', url: 'https://example.test/merge', note: '' },
    checksRun: [{ checkId: 'unit', command: 'npm test', exitCode: 0, logUrl: '', at: '2026-10-19T12:00:00Z' }] },
});

test('complete pipeline is not enough: missing evidence blocks boss approval', () => {
  const good = valid(); assert.deepEqual(completionBlockers(good), []);
  assert.match(completionBlockers({ ...good, evidence: undefined }).join(' '), /Testy.*Review.*Merge/);
  for (const key of ['review', 'merge'] as const) {
    const b = valid(); b.evidence[key].status = 'pending';
    assert.ok(completionBlockers(b).length);
    b.evidence[key].status = 'passed'; b.evidence[key].url = '';
    assert.match(completionBlockers(b).join(' '), /odkaz/);
  }
});

test('prescribed check ID and command, exits and timestamps must match', () => {
  const duplicate = valid();
  duplicate.evidence.checksRun.push({ ...duplicate.evidence.checksRun[0] });
  assert.ok(completionBlockers(duplicate).length);
  for (const change of [{ command: 'echo ok' }, { checkId: 'other' }, { exitCode: 1 }, { at: 'invented' }, { at: '2026-10-19T12:00:00' }]) {
    const b = valid(); Object.assign(b.evidence.checksRun[0], change);
    assert.ok(completionBlockers(b).length);
  }
});

test('read-only, unresolved blocks, input security, missing pipeline and gate scenario cannot approve', () => {
  const b = valid();
  for (const patch of [{ readOnly: true }, { readOnly: undefined }, { node: undefined }, { pipeline: null },
    { loop: { openBlocks: 1, waitingOnHuman: [] } }, { loop: { openBlocks: 0, waitingOnHuman: [{ ask: 'Need answer' }] } },
    { blocks: [{ tags: ['input-security'], state: { status: 'open' } }] },
    { node: { ...b.node, scenario: { command: 'npm run smoke' } }, scenarioRun: { command: 'old command', failed: 0 } },
    { node: { ...b.node, scenario: { command: 'npm run smoke' } }, scenarioRun: { command: 'npm run smoke', failed: 1 } }]) {
    assert.ok(completionBlockers({ ...b, ...patch }).length, JSON.stringify(patch));
  }
  assert.deepEqual(completionBlockers({ ...b, node: { ...b.node, scenario: { command: 'npm run smoke' } }, scenarioRun: { command: 'npm run smoke', failed: 0 } }), []);
});

test('task cannot waive tests or merge; justified review N/A still requires a human review', () => {
  for (const key of ['tests', 'merge'] as const) {
    const b = valid(); b.evidence[key] = { status: 'not_applicable', note: 'Reason', url: '' };
    assert.ok(completionBlockers(b).length);
  }
  const b = valid(); b.evidence.review = { status: 'not_applicable', note: 'Research rationale', url: '' };
  assert.deepEqual(completionBlockers(b), []);
  b.evidence.review.note = '';
  assert.ok(completionBlockers(b).length);
});

test('guides explain saved outcome and never treat opening a card as resolving it', () => {
  const q = questionGuidance('block-a');
  assert.match(q.steps.join(' '), /block-a.*Text bloku.*otevřeno/s);
  assert.match(q.expected, /neznamená dokončení/);
  assert.match(questionGuidance('stage-a', true).steps.join(' '), /pipeline.*stage-a.*nepřeskakuj/s);
  const approval = approvalGuidance();
  assert.match(approval.steps.join(' '), /Potvrdit.*Uzavřeno/s);
  assert.match(approval.expected, /uložené potvrzení/);
});

test('system status distinguishes observed active run from no verified assignment', () => {
  const state = { ...EMPTY_OPORA, workspace: 'w', runs: [{ cardId: 'c', cardName: 'Card', group: 'dev' as const, by: 'test', startedAt: 1, state: 'working' as const, workerId: 'worker', workerName: 'Byte', workspace: 'w' }] };
  assert.match(systemGuidance(state, 'c').activity, /Byte.*Neověřuje/);
  for (const s of [{ ...state, workspace: 'other' }, { ...state, runs: [] }, { ...state, runs: [{ ...state.runs[0], error: 'Failed' }] }, { ...state, runs: [{ ...state.runs[0], state: 'done' as const }] }]) {
    const g = systemGuidance(s, 'c');
    assert.match(g.activity, /Není doložen aktivní běh/);
    assert.deepEqual(g.steps, []);
  }
});

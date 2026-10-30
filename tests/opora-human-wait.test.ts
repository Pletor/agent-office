import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_WAIT_LIMITS, HumanWaitNotice, claimsBlockedReason, digestAgentState } from '../src/server/opora/agent-state.js';
import { cardsCs, humanWaitItems } from '../src/server/boss-attention/human-wait.js';
import { readBossAttention } from '../src/server/boss-attention/index.js';
import { EMPTY_OPORA } from '../src/shared/opora.js';
import type { OporaState } from '../src/shared/protocol.js';

/** Trimmed from the live `ample` floor's agent-state: no accepted baseline, one human-only decision. */
const LIVE = {
  schemaVersion: 1,
  heads: { acceptedHead: null },
  stages: [
    { id: 'plan', count: 184, health: 'blocking', reason: 'no_accepted_baseline' },
    { id: 'proposal', count: 0, health: 'ok', reason: 'no_pending_proposals' },
    { id: 'acceptance', count: 1, health: 'waiting', reason: 'baseline_awaiting_human' },
    { id: 'claim', count: 0, health: 'ok', reason: 'nothing_ready' },
  ],
  decisions: [{ id: 'dec_1', kind: 'accept_baseline', targetId: null, title: 'Přijmout výchozí zadání', actionId: 'act_1' }],
  actions: [{ id: 'act_1', verb: 'accept_baseline', method: 'POST', targetId: null, status: 'blocked', blockReason: 'human_only' }],
  cards: [
    ...Array.from({ length: 57 }, (_, i) => ({ nodeId: `n${i}`, health: 'blocking', reason: 'no_accepted_baseline' })),
    ...Array.from({ length: 43 }, (_, i) => ({ nodeId: `c${i}`, health: 'ok', reason: 'card_closed' })),
  ],
  truncated: true,
};

test('the live baseline wait digests into one decision, its stages, the cards it holds and blocked claims', () => {
  const d = digestAgentState(LIVE);
  assert.equal(d.ready.size, 0);
  assert.deepEqual(d.humanWait, {
    decisions: [{ kind: 'accept_baseline', title: 'Přijmout výchozí zadání' }],
    stages: [{ id: 'plan', health: 'blocking', reason: 'no_accepted_baseline', count: 184 }, { id: 'acceptance', health: 'waiting', reason: 'baseline_awaiting_human', count: 1 }],
    cards: 57,
    more: true,
    claimsBlocked: true,
  });
  assert.match(claimsBlockedReason(d.humanWait)!, /Opora waits on a person: “Přijmout výchozí zadání”/);
});

test('an older Canvas, an empty or malformed agent-state has no human wait, and is not an error', () => {
  for (const doc of [undefined, null, 'nope', [], {}, { actions: 'x' }, { decisions: [{ kind: 'accept_baseline', actionId: 'a' }] }, { decisions: 'x', stages: {}, cards: 5 }]) {
    const d = digestAgentState(doc);
    assert.equal(d.humanWait, undefined, JSON.stringify(doc));
    assert.equal(d.ready.size, 0);
  }
  // Ready claims are read as before.
  assert.deepEqual([...digestAgentState({ actions: [{ verb: 'claim', status: 'ready', targetId: 'c1' }, { verb: 'claim', status: 'blocked', targetId: 'c2' }] }).ready], ['c1']);
  // A card with a pinned Harness kit is claimable only through the sparse context: a v1 office leaves it alone.
  const kit = { actions: [{ verb: 'claim', status: 'ready', targetId: 'c1' }, { verb: 'claim', status: 'ready', targetId: 'kit', preconditions: { contextProtocolVersion: 2 } }] };
  assert.deepEqual([...digestAgentState(kit, 1).ready], ['c1']);
  assert.deepEqual([...digestAgentState(kit, 2).ready], ['c1', 'kit']);
});

test('a decision whose action an agent may take is not a human wait; a changeset wait leaves claims open', () => {
  assert.equal(digestAgentState({ decisions: [{ kind: 'accept_baseline', title: 'X', actionId: 'a' }], actions: [{ id: 'a', status: 'ready' }] }).humanWait, undefined);
  const d = digestAgentState({
    decisions: [{ kind: 'accept_changeset', title: 'Přijmout kroky plánu', actionId: 'a' }],
    actions: [{ id: 'a', status: 'blocked', blockReason: 'human_only' }, { verb: 'claim', status: 'ready', targetId: 'c9' }],
    stages: [{ id: 'proposal', health: 'waiting', reason: 'changeset_awaiting_human' }],
  });
  assert.equal(d.humanWait!.claimsBlocked, false);
  assert.equal(d.humanWait!.stages[0].count, 0, 'a missing count is 0');
  assert.equal(d.humanWait!.cards, 0);
  assert.equal(claimsBlockedReason(d.humanWait), undefined);
});

test('the digest stays small whatever Canvas sends', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, status: 'blocked', blockReason: 'human_only' }));
  const d = digestAgentState({
    actions: many,
    decisions: many.map((a) => ({ kind: 'k', title: 'T'.repeat(500), actionId: a.id })),
    stages: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, health: 'blocking', reason: 'r' })),
  });
  assert.equal(d.humanWait!.decisions.length, HUMAN_WAIT_LIMITS.decisions);
  assert.equal(d.humanWait!.stages.length, HUMAN_WAIT_LIMITS.stages);
  assert.equal(d.humanWait!.decisions[0].title.length, HUMAN_WAIT_LIMITS.text);
});

test('the hold-off notice speaks once per wait, and again only after it clears', () => {
  const said: string[] = [];
  const n = new HumanWaitNotice((x) => said.push(x));
  const w = digestAgentState(LIVE).humanWait;
  assert.equal(n.holds(w, 'Autopilot'), true);
  assert.equal(n.holds(w, 'Autopilot'), true);
  assert.equal(said.length, 1);
  assert.equal(n.holds(undefined, 'Autopilot'), false);
  n.holds(w, 'Autopilot');
  assert.equal(said.length, 2);
});

const linked = (humanWait?: OporaState['humanWait']): OporaState => ({
  ...EMPTY_OPORA, url: 'http://127.0.0.1:8740', connected: true, checkedAt: 1,
  project: { id: 'p1', name: 'Ample' }, workspace: 'draft', workspaces: [{ id: 'draft', label: 'Draft' }], humanWait,
});

test('the boss board lists the human-only decision as a request for the boss, linked to the project in Opora', async () => {
  const state = linked(digestAgentState(LIVE).humanWait);
  const [item] = humanWaitItems(state, ['Ample', 'Draft']);
  assert.equal(item.kind, 'question');
  assert.equal(item.title, 'Přijmout výchozí zadání');
  assert.equal(item.reason, 'Opora čeká na člověka: Přijmout výchozí zadání — 57+ karet do té doby nikdo nepřevezme.');
  assert.equal(item.url, 'http://127.0.0.1:8740/?project=p1&workspace=draft&screen=canvas');
  assert.ok(item.guidance!.blockers.includes('plan: chybí přijaté výchozí zadání (184)'));
  const source = { overview: async () => ({ rows: [] }), nodes: async () => [], brief: async () => ({}) };
  const board = await readBossAttention(state, source);
  assert.ok(board.items.some((i) => i.id === 'human-wait:accept_baseline'));
  assert.deepEqual(humanWaitItems(linked(), []), []);
  assert.equal(cardsCs(1), '1 karta');
  assert.equal(cardsCs(3), '3 karty');
});

test('agent-state carries each card run profile (gauge.run) by its id; a card without one has none', () => {
  const d = digestAgentState({ cards: [
    { nodeId: 'big', gauge: { run: { label: 'XL', effort: 'xhigh', model: 'sonnet', advisor: null, handout: false, humanReview: false } } },
    { nodeId: 'risky', gauge: { run: { label: 'S', effort: 'medium', model: 'sonnet', advisor: 'opus', handout: true, humanReview: true } } },
    { nodeId: 'old', gauge: {} },
  ] });
  assert.equal(d.runs.get('big')?.handout, false);
  assert.equal(d.runs.get('risky')?.humanReview, true);
  assert.equal(d.runs.get('risky')?.advisor, 'opus');
  assert.equal(d.runs.has('old'), false);
});

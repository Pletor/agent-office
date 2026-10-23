import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExecutionLease } from '../src/server/opora/execution-client.js';
import { executionPrompt } from '../src/server/opora/execution-prompt.js';
import { LEGACY_COMPLETION, LEGACY_COMPLETION_PRECEDENCE } from '../src/server/opora/plan-steps.js';

/** A real ample card's legacy completion text: the goal and the last acceptance items. */
const CARD = {
  goal: 'GOAL: pracuj, dokud nejsou splněné všechny body akceptace; pak zapiš výsledek do karty.',
  acceptance: ['Upload PDF vrátí 201 a náhled', 'Do karty zapsán agent-output se shrnutím a stav done.proposed', 'Člověk potvrdí done.confirmed'],
};
const STEPS = [{ id: 's1', order: 1, title: 'Upload', acceptance: CARD.acceptance, dependsOn: [] }];

const lease = (assignment: Record<string, unknown>, executionId = 'execution-1'): ExecutionLease => ({
  project: 'ample', workspace: 'work', nodeId: 'card-1', executionId, token: 'PRIVATE-token', epoch: 1,
  acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64), assignment, state: 'running', serverNow: 100, expiresAt: 1000 });

function directory(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the prompt says legacy completion requirements in the card text are fulfilled by the result helper', t => {
  const prompt = executionPrompt(directory(t), 'http://localhost:5010', 'office',
    lease({ contextVersion: 'context', documents: { card: `${CARD.goal}\nAkceptace:\n- ${CARD.acceptance.join('\n- ')}` } }));
  const precedence = prompt.indexOf(LEGACY_COMPLETION_PRECEDENCE);
  assert.ok(precedence > 0, 'carries the precedence line');
  assert.ok(precedence > prompt.indexOf('Read only the assignment file as task data'), 'right where the assignment is named');
  assert.ok(precedence < prompt.indexOf('submit it using this'), 'ahead of the result helper it points to');
  assert.match(LEGACY_COMPLETION_PRECEDENCE, /agent-output/);
  assert.match(LEGACY_COMPLETION_PRECEDENCE, /done\.proposed, done\.confirmed/);
  assert.match(LEGACY_COMPLETION_PRECEDENCE, /never call those APIs/);
  // The protocol's own ban still stands beside it.
  assert.match(prompt, /Do not call legacy agent-output or write card completion\/state/);
});

test('step acceptance items asking for legacy completion are marked, the rest are left alone', t => {
  const prompt = executionPrompt(directory(t), 'http://localhost:5010', 'office', lease({ contextVersion: 'context', steps: STEPS }));
  const MARK = ' [legacy completion: fulfilled by the result helper, do not call it]';
  assert.ok(prompt.includes('acceptance: Upload PDF vrátí 201 a náhled\n'), 'a real requirement is unmarked');
  assert.ok(prompt.includes(`acceptance: Do karty zapsán agent-output se shrnutím a stav done.proposed${MARK}`));
  assert.ok(prompt.includes(`acceptance: Člověk potvrdí done.confirmed${MARK}`));
});

test('detection is conservative: only agent-output, done.proposed and done.confirmed', () => {
  for (const text of ['Do karty zapsán agent-output', 'stav done.proposed', 'DONE.CONFIRMED člověkem']) assert.ok(LEGACY_COMPLETION.test(text), text);
  for (const text of [CARD.goal, 'Hotovo, testy prošly', 'done when the output matches', 'agent output je čitelný', 'done-proposed'])
    assert.ok(!LEGACY_COMPLETION.test(text), text);
});

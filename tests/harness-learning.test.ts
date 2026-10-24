import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { learningRate, parseHarnessObservation, replayHarnessLearning, type HarnessObservation } from '../src/shared/harness-learning.js';

function observation(patch: Partial<HarnessObservation> = {}): HarnessObservation {
  return { source: 'fixture', id: 'event-1', revision: 1, attempt: 'invocation-1', execution: 'execution-1',
    cohort: { resource: 'script:check', digest: 'a'.repeat(64), runner: 'codex@1', problem: 'ts.references', scope: ['global', 'project-1'] },
    signal: 'acceptance', tier: 'reported', outcome: 'pass', durationMs: null, ...patch };
}
test('empty/unknown evidence remains unknown; zero duration is observed, not missing', () => {
  assert.equal(learningRate([]).percent, null);
  const rate = replayHarnessLearning([observation({ outcome: 'unknown', durationMs: 0 })])[0].rate;
  assert.equal(rate.percent, null); assert.equal(rate.interval95, null);
  assert.equal(rate.coverage, 0); assert.equal(rate.meanDurationMs, 0); assert.equal(rate.durationSamples, 1);
});
test('100 percent with one pass retains a wide confidence interval', () => {
  const rate = replayHarnessLearning([observation()])[0].rate;
  assert.equal(rate.percent, 100);
  assert.ok(rate.interval95![0] > 20 && rate.interval95![0] < 21);
  assert.ok(rate.interval95![1] > 99.99);
});
test('duplicate delivery, out of order corrections and replay are deterministic', () => {
  const first = observation(), regression = observation({ revision: 2, outcome: 'fail' });
  const replay = replayHarnessLearning([regression, first, first, regression]);
  assert.deepEqual(replay, replayHarnessLearning([first, regression]));
  assert.equal(replay[0].rate.fail, 1); assert.equal(replay[0].rate.pass, 0);
});
test('retractions remove success without silently treating missing evidence as failure', () => {
  const result = replayHarnessLearning([observation(), observation({ revision: 2, outcome: 'unknown' })]);
  assert.equal(result[0].rate.percent, null); assert.equal(result[0].rate.unknown, 1);
});
test('self reports, checks and verified acceptance never share a denominator', () => {
  const rows = ['reported', 'check', 'verified'].map((tier, i) => observation({ id: String(i), tier: tier as HarnessObservation['tier'] }));
  const result = replayHarnessLearning(rows);
  assert.equal(result.length, 3); assert.ok(result.every(row => row.rate.pass === 1));
});
test('versions, runner versions, problems and full ancestry form isolated cohorts', () => {
  const base = observation();
  const variants = [{ digest: 'b'.repeat(64) }, { runner: 'codex@2' }, { problem: 'other' }, { scope: ['global', 'project-2'] }];
  const rows = [base, ...variants.map((v, i) => observation({ id: String(i), cohort: { ...base.cohort, ...v } }))];
  assert.equal(replayHarnessLearning(rows).length, 5);
});
test('signals cannot equate tool invocation with accepted work', () => {
  const rows = [observation(), observation({ id: 'event-2', signal: 'invocation' })];
  assert.equal(replayHarnessLearning(rows).length, 2);
});
test('conflicting duplicates fail even when a later correction was delivered first', () => {
  assert.throws(() => replayHarnessLearning([observation({ revision: 2 }), observation(), observation({ outcome: 'fail' })]), /Conflicting/);
  assert.throws(() => replayHarnessLearning([observation(), observation({ revision: 2, tier: 'verified' })]), /identity changed/);
});
test('relabeling one attempt cannot inflate successful votes', () => {
  assert.throws(() => replayHarnessLearning([observation(), observation({ id: 'different-event' })]), /one attempt/);
  assert.throws(() => replayHarnessLearning([observation(), observation({ source: 'different-source' })]), /one attempt/);
});
test('distinct attempts retain execution diversity and missing duration coverage', () => {
  const rows = [observation({ durationMs: 10 }), observation({ id: 'e2', attempt: 'a2', outcome: 'fail' }),
    observation({ id: 'e3', attempt: 'a3', execution: 'x2', outcome: 'unknown', durationMs: 30 })];
  const rate = replayHarnessLearning(rows.map(row => ({ ...row, signal: 'invocation' })))[0].rate;
  assert.equal(rate.percent, 50); assert.equal(rate.coverage, 2 / 3); assert.equal(rate.executions, 2);
  assert.equal(rate.durationSamples, 2); assert.equal(rate.meanDurationMs, 20);
});
test('task retries do not inflate acceptance or production evidence', () => {
  for (const signal of ['acceptance', 'production'] as const) {
    assert.throws(() => replayHarnessLearning([observation({ signal }), observation({ signal, id: 'retry', attempt: 'retry' })]), /one attempt/);
  }
});
test('reject malformed, unbounded and extra evidence fields without truncating identity', () => {
  for (const patch of [{ revision: 0 }, { revision: 1.2 }, { durationMs: Infinity }, { durationMs: -1 },
    { id: 'x'.repeat(201) }, { id: 'bad\n' }, { outcome: 'success' }, { verified: true }]) {
    assert.throws(() => parseHarnessObservation({ ...observation(), ...patch }));
  }
  assert.throws(() => parseHarnessObservation({ ...observation(), cohort: { ...observation().cohort, scope: [] } }));
  assert.throws(() => parseHarnessObservation({ ...observation(), cohort: { ...observation().cohort, digest: 'latest' } }));
});
test('JSON object key order is irrelevant and returned scopes do not alias input', () => {
  const row = observation(), reversed = Object.fromEntries(Object.entries(row).reverse());
  assert.equal(replayHarnessLearning([row, reversed])[0].rate.pass, 1);
  const parsed = parseHarnessObservation(row); parsed.cohort.scope.push('card');
  assert.equal(row.cohort.scope.length, 2);
});
test('offline replay CLI labels untrusted output, rejects conflicts and never writes input', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-replay-'));
  const file = path.join(dir, 'observations.json');
  const cli = path.resolve(import.meta.dirname, '../src/server/harness-learning/replay-cli.ts');
  try {
    writeFileSync(file, JSON.stringify([observation()]));
    const result = spawnSync(process.execPath, ['--import', 'tsx', cli, file], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.authority, 'offline-untrusted'); assert.equal(output.promotionAllowed, false);
    assert.equal(output.summaries[0].rate.pass, 1);
    writeFileSync(file, JSON.stringify([observation(), observation({ outcome: 'fail' })]));
    const invalid = spawnSync(process.execPath, ['--import', 'tsx', cli, file], { encoding: 'utf8', timeout: 15000 });
    assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.match(invalid.stderr, /Conflicting/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

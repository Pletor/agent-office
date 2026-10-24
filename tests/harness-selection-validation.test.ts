import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateAcceptedKit } from '../src/server/harness/accepted-kit.js';
import { v2Kit } from './support/harness-v2.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const fixture = () => v2Kit({ schema: 'harness.kit/1', problems: ['tool.run'], resources: [{
  slot: 'scripts.run', resource: 'script:run', category: 'scripts', content: 'console.log(1)',
  digest: hash('console.log(1)'), requires: ['command:node'] }] });

test('accepted v2 preserves exact provenance while v1 remains strict', () => {
  const kit = fixture(), before = structuredClone(kit);
  assert.deepEqual(validateAcceptedKit(kit), before);
  assert.deepEqual(kit, before);
  assert.throws(() => validateAcceptedKit({ ...kit, schema: 'harness.kit/1' }));
  for (const scope of ['global', 'repository', 'page', 'layer', 'area', 'sector', 'task']) {
    const value = fixture(), origin = value.selection.entries[0].assignments[0];
    Object.assign(origin, { scope, node: ['global', 'repository'].includes(scope) ? null : 'opora:p:w:n' });
    assert.deepEqual(validateAcceptedKit(value), value);
  }
});

test('v2 rejects mismatched versions, unsupported claims and malformed origins', () => {
  const mutations: ((v: any) => void)[] = [
    v => v.selection.evidence = 'independently-verified', v => v.selection.policy = 'unknown',
    v => v.selection.profileRevision = true, v => v.selection.profileRevision = 2 ** 53,
    v => v.selection.profileRevision = null, v => v.selection.declaredCapabilities = [{ bad: true }],
    v => v.selection.declaredCapabilities = ['duplicate', 'duplicate'], v => v.selection.entries = [],
    v => v.selection.entries[0].resource = 'foreign', v => v.selection.entries[0].digest = '0'.repeat(64),
    v => v.selection.entries[0].versionDigest = '0'.repeat(64), v => v.selection.entries[0].order = false,
    v => v.selection.entries[0].reason = 'observed-outcomes', v => v.selection.entries[0].verified = true,
    v => v.selection.entries[0].assignments = [], v => v.selection.entries[0].assignments[0].scope = [],
    v => v.selection.entries[0].assignments[0].node = 'bad\n', v => v.selection.entries[0].assignments[0].scope = 'global',
    v => v.selection.entries[0].assignments.push(v.selection.entries[0].assignments[0]),
    v => v.resources[0].requires = ['command:other'], v => v.selection.problem = 'foreign.problem',
  ];
  for (const mutate of mutations) { const value = fixture(); mutate(value); assert.throws(() => validateAcceptedKit(value)); }
  const oversized = fixture();
  oversized.resources[0].content = 'x'.repeat(96 * 1024 - 400);
  oversized.resources[0].digest = hash(oversized.resources[0].content);
  assert.throws(() => validateAcceptedKit(v2Kit(oversized)), /invalid/);
});

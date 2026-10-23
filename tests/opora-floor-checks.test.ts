import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FLOOR_CHECKS_FILE, floorCheckEnv } from '../src/server/opora/floor-checks.js';
import { createSelfCheckReporter, selfCheckCommands } from '../src/server/opora/self-checks.js';
import { upkeepConfig } from '../src/server/opora/upkeep-config.js';

const ENV = { AGENT_OFFICE_OPORA_SELF_CHECKS: '{"tests":"npm test && uv run pytest backend -q -k opora","build":"npm run build"}', AGENT_OFFICE_OPORA_CHECK_COMMAND: 'npm run build', OTHER: 'kept' };

function withFloor(content: string | undefined, run: (dir: string, logs: [string, string][]) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'floor-checks-'));
  try {
    if (content !== undefined) writeFileSync(path.join(dir, FLOOR_CHECKS_FILE), content);
    const logs: [string, string][] = [];
    run(dir, logs);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const log = (logs: [string, string][]) => (m: string, l: string) => logs.push([l, m]);

test('no floor file: the env vars apply, silently', () => withFloor(undefined, (dir, logs) => {
  assert.equal(floorCheckEnv(dir, log(logs), ENV), ENV);
  assert.deepEqual(logs, []);
}));

test("the floor's file wins over the env vars, once, with a log line", () => withFloor(
  '﻿{"selfChecks":{"tests":"npm test","build":"npm run build"},"checkCommand":"npm test && npm run build"}', (dir, logs) => {
    const env = floorCheckEnv(dir, log(logs), ENV);
    assert.deepEqual(selfCheckCommands(env), [{ name: 'tests', command: 'npm test' }, { name: 'build', command: 'npm run build' }]);
    assert.equal(upkeepConfig({ ...env, AGENT_OFFICE_OPORA_UPKEEP: 'on' }).checkCommand, 'npm test && npm run build');
    assert.equal(env.OTHER, 'kept');
    assert.equal(ENV.AGENT_OFFICE_OPORA_CHECK_COMMAND, 'npm run build', 'the process env is not changed');
    assert.equal(logs.length, 1);
    assert.equal(logs[0]![0], 'info');
    assert.match(logs[0]![1], /self-checks tests, build; upkeep check `npm test && npm run build`/);
  }));

test('a key left out keeps the env var; name=command lines work as in the env var', () => withFloor(
  JSON.stringify({ selfChecks: 'tests=npx vitest run\nbuild=npm run build' }), (dir, logs) => {
    const env = floorCheckEnv(dir, log(logs), ENV);
    assert.deepEqual(selfCheckCommands(env).map((c) => c.command), ['npx vitest run', 'npm run build']);
    assert.equal(env.AGENT_OFFICE_OPORA_CHECK_COMMAND, 'npm run build');
  }));

test('{} and "" turn them off on this floor, and say so', () => withFloor('{"selfChecks":{},"checkCommand":""}', (dir, logs) => {
  const env = floorCheckEnv(dir, log(logs), ENV);
  assert.deepEqual(selfCheckCommands(env), []);
  assert.equal(upkeepConfig(env).checkCommand, undefined);
  assert.equal(createSelfCheckReporter('http://127.0.0.1:1', 'office-x', dir, () => {}, env), undefined);
  assert.match(logs[0]![1], /self-checks off; upkeep check off/);
}));

for (const [what, content] of [
  ['broken JSON', '{"selfChecks":'],
  ['an array', '[]'],
  ['an unknown key', '{"selfcheck":{"tests":"npm test"}}'],
  ['a bad check name', '{"selfChecks":{"Tests!":"npm test"}}'],
  ['an empty command', '{"selfChecks":{"tests":""}}'],
  ['a non-string check command', '{"checkCommand":["npm","test"]}'],
] as const) {
  test(`a file with ${what} is ignored with one warning and the env vars apply`, () => withFloor(content, (dir, logs) => {
    assert.equal(floorCheckEnv(dir, log(logs), ENV), ENV);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]![0], 'warn');
    assert.match(logs[0]![1], /opora-checks\.json.*using the env vars' checks/);
  }));
}

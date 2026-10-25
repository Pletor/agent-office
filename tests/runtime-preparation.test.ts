import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { attachRuntimePreparation } from '../src/server/workers/runtime-preparation.js';
import { stagedOporaEnabled } from '../src/server/workers/prepared-task.js';
import { binScript } from '../src/server/workers/process.js';
import type { StagedWorker } from '../src/server/workers/staged-start.js';
import type { Worker } from '../src/server/workers/types.js';

test('automatic readiness requires explicit staging and context-v2 configuration', t => {
  const keys = ['AGENT_OFFICE_HARNESS_PREPARE_WORKER', 'AGENT_OFFICE_OPORA_PREPARE_WORKER', 'AGENT_OFFICE_OPORA_CONTEXT_VERSION'];
  const before = keys.map(k => process.env[k]);
  t.after(() => keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; }));
  process.env[keys[0]] = '1'; delete process.env[keys[1]];
  assert.throws(stagedOporaEnabled, /requires/);
  process.env[keys[1]] = '1'; process.env[keys[2]] = '2';
  assert.equal(stagedOporaEnabled(), true);
  process.env[keys[0]] = 'yes'; assert.throws(stagedOporaEnabled, /requires/);
  delete process.env[keys[0]];
  const stage = {} as StagedWorker; assert.equal(attachRuntimePreparation(stage, '.'), stage);
});

test('actual worker checker accepts absent/rule kits and records refusal for unsupported equipment',
  { skip: !binScript('harness-prepare-worker.js') && 'Optional Harness checker is tested in the composed installation' }, async t => {
  const before = process.env.AGENT_OFFICE_HARNESS_PREPARE_WORKER;
  process.env.AGENT_OFFICE_HARNESS_PREPARE_WORKER = '1';
  const root = mkdtempSync(path.join(tmpdir(), 'runtime-preparation-'));
  let category = 'rules', empty = true, requests = 0;
  const server = http.createServer((req, res) => {
    requests++; assert.equal(req.headers.authorization, 'Bearer private-token');
    const content = 'Never execute this resource during readiness';
    res.end(JSON.stringify({ execution: { executionId: 'e', epoch: 1, project: 'p', workspace: 'w', nodeId: 'n',
      acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64) }, kit: empty ? null : {
        schema: 'harness.kit/1', resources: [{ resource: 'resource:one', category, content,
          digest: createHash('sha256').update(content).digest('hex'), requires: [] }],
      } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); rmSync(root, { recursive: true, force: true });
    if (before === undefined) delete process.env.AGENT_OFFICE_HARNESS_PREPARE_WORKER; else process.env.AGENT_OFFICE_HARNESS_PREPARE_WORKER = before; });
  for (const mode of ['empty', 'rules', 'unsupported']) {
    empty = mode === 'empty'; category = mode === 'unsupported' ? 'plugins' : 'rules';
    const worker = { info: { id: mode }, preparing: true, hookToken: 'private-token' } as Worker;
    const signal = new AbortController().signal;
    const stage = { worker: worker.info, cwd: root, signal,
      prepare: async (operation: (cwd: string, signal: AbortSignal) => Promise<unknown>) => operation(root, signal),
    } as StagedWorker;
    attachRuntimePreparation(stage, root, { hookUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
      dataDir: root, workers: new Map([[mode, worker]]) });
    if (mode === 'unsupported') await assert.rejects(stage.verify!(signal), /equipment is unavailable/);
    else await stage.verify!(signal);
    const file = path.join(root, 'preparation-results', createHash('sha256').update(mode).digest('hex') + '.json');
    const raw = readFileSync(file, 'utf8'), report = JSON.parse(raw);
    assert.equal(report.ready, mode !== 'unsupported'); assert.equal(report.kitPresent, mode !== 'empty');
    assert.ok(!raw.includes('private-token') && !raw.includes('Never execute'));
  }
  assert.equal(readdirSync(path.join(root, 'preparation-results')).length, 3); assert.ok(requests >= 6);
});

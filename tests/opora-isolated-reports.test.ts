import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { ManagedAgentsHttp } from '../src/server/opora/executors/managed-http.js';
import { PROVIDER, type ExecutionIntent } from '../src/server/opora/executors/types.js';
import { digest } from '../src/server/opora/executors/validation.js';
import { readRemoteReport, remoteReportInstructions } from '../src/server/opora/isolated-reports.js';

const sessionId = 'sesn_mapped', eventId = 'sevt_latest';
function intent(): ExecutionIntent {
  const admittedAt = Date.now() / 1000;
  return { intentId: 'a'.repeat(40), requestId: 'bind-one', provider: PROVIDER, project: 'draft', workspace: 'draft',
    nodeId: 'node', executionId: 'b'.repeat(32), epoch: 1, acceptedRevision: 'c'.repeat(40), assignmentDigest: 'd'.repeat(64),
    contextProtocolVersion: 2, contextVersion: 'e'.repeat(64), executionProtocolVersion: 2,
    budget: { policyHead: '1'.repeat(40), familyId: '2'.repeat(40), allocationId: '3'.repeat(40), attempt: 1,
      repairRound: 0, kind: 'initial', admittedAt, runDeadlineAt: admittedAt + 60, maxRunSeconds: 60 },
    authorityDeadlineAt: admittedAt + 60, repository: { url: 'https://github.com/example/repo', commitSha: '4'.repeat(40) },
    agentId: 'agent_one', agentVersion: 1, environmentId: 'env_one', environmentDigest: '5'.repeat(64),
    configurationDigest: '6'.repeat(64), maxListCostCents: '100' };
}
function envelope(value: ExecutionIntent) {
  return { schemaVersion: 1, kind: 'oporahub-reported-result', intentId: value.intentId, executionId: value.executionId,
    epoch: value.epoch, acceptedRevision: value.acceptedRevision, assignmentDigest: value.assignmentDigest,
    result: { summary: 'Implemented and checked locally.', evidence: { tests: ['unit'], passed: true } } };
}
function event(text: string) {
  return { type: 'agent.message', id: eventId, content: [{ type: 'text', text }], processed_at: '2026-10-21T12:00:00+02:00' };
}
async function fixture() {
  const value = intent();
  let response: unknown = { data: [event(JSON.stringify(envelope(value)))], next_page: 'older-page-never-follow' };
  let behavior: 'normal' | 'redirect' | 'hang' = 'normal';
  const calls: string[] = [];
  const server = createServer((request, reply) => {
    calls.push(request.url!);
    assert.equal(request.headers['x-api-key'], 'PRIVATE_PROVIDER_KEY');
    const query = new URL(request.url!, 'http://provider.invalid').searchParams;
    if (query.has('types') || query.getAll('types[]').join() !== 'agent.message') {
      reply.writeHead(400, { 'Content-Type': 'application/json' });
      reply.end(JSON.stringify({ error: { type: 'invalid_request_error', message: "Use the array parameter types[]." } })); return;
    }
    if (behavior === 'hang') return;
    if (behavior === 'redirect') { reply.writeHead(302, { Location: '/evil' }); reply.end(); return; }
    reply.writeHead(200, { 'Content-Type': 'application/json' }); reply.end(JSON.stringify(response));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const http = new ManagedAgentsHttp({ agentId: value.agentId, agentVersion: value.agentVersion,
    environmentId: value.environmentId, environmentDigest: value.environmentDigest, configurationDigest: value.configurationDigest,
    maxListCostCents: '100' }, () => ({ apiKey: 'PRIVATE_PROVIDER_KEY', githubToken: 'PRIVATE_GITHUB_TOKEN' }), async (url, init) => {
      assert.equal(new URL(url).origin, 'https://api.anthropic.com');
      assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
      const raw = await fetch('http://127.0.0.1:' + address.port + new URL(url).pathname + new URL(url).search, init);
      return new Response(raw.body, { status: raw.status, headers: raw.headers });
    }, 100);
  return { value, http, calls, set: (body: unknown) => { response = body; }, mode: (mode: typeof behavior) => { behavior = mode; },
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}

test('real HTTP latest-only report has exact immutable identity and deterministic private receipt identity', async () => {
  const f = await fixture();
  try {
    const first = await readRemoteReport(f.http, f.value, sessionId);
    const again = await readRemoteReport(f.http, f.value, sessionId);
    assert.deepEqual(again, first); assert.ok(first);
    assert.deepEqual(Object.keys(first).sort(), ['digest', 'eventId', 'processedAt', 'requestId', 'result']);
    assert.equal(first.processedAt, '2026-10-21T10:00:00.000Z');
    assert.equal(first.requestId, createHash('sha256').update(f.value.intentId + sessionId + eventId).digest('hex'));
    assert.equal(first.digest, digest({ eventId, processedAt: first.processedAt, result: first.result,
      intentId: f.value.intentId, executionId: f.value.executionId, epoch: f.value.epoch,
      acceptedRevision: f.value.acceptedRevision, assignmentDigest: f.value.assignmentDigest, sessionId }));
    assert.deepEqual(f.calls, Array(2).fill('/v1/sessions/' + sessionId + '/events?types%5B%5D=agent.message&order=desc&limit=1'));
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE_|authorization_token|contextVersion|"budget"/);
  } finally { await f.close(); }
});

test('instructions carry only public report identity and no authority or verification claim', () => {
  const value = intent(), text = remoteReportInstructions(value);
  assert.match(text, /not independent verification/);
  assert.doesNotMatch(text, /PRIVATE_|contextVersion|configurationDigest|environmentDigest|maxListCostCents|allocationId|"budget"/);
  assert.deepEqual(JSON.parse(text.split('\n').at(-1)!), { ...envelope(value), result: { summary: 'Describe the actual outcome here.' } });
});

test('one entire JSON fence preserves strict report identity and deterministic result identity', async () => {
  const f = await fixture();
  try {
    const raw = await readRemoteReport(f.http, f.value, sessionId);
    for (const text of ['```json\n' + JSON.stringify(envelope(f.value)) + '\n```',
      ' \r\n```json\r\n' + JSON.stringify(envelope(f.value)) + '\r\n```\r\n\t']) {
      f.set({ data: [event(text)] });
      assert.deepEqual(await readRemoteReport(f.http, f.value, sessionId), raw);
    }
  } finally { await f.close(); }
});

test('fences never extract prose, other languages, multiple blocks or malformed JSON', async () => {
  const f = await fixture();
  try {
    const json = JSON.stringify(envelope(f.value)), fenced = '```json\n' + json + '\n```';
    for (const text of ['Report:\n' + fenced, fenced + '\nDone.', fenced + '\n' + fenced,
      '```javascript\n' + json + '\n```', '```\n' + json + '\n```', '```json' + json + '```',
      '```json\n{"kind":"oporahub-reported-result",}\n```']) {
      f.set({ data: [event(text)] }); assert.equal(await readRemoteReport(f.http, f.value, sessionId), null);
    }
  } finally { await f.close(); }
});

test('absent, prose, JSON without report kind and redacted latest messages never fabricate a result', async () => {
  const f = await fixture();
  try {
    for (const data of [[], [event('Still working.')], [event('{"summary":"No explicit report"}')],
      [{ ...event('ignored'), content: [{ type: 'redacted' }] }],
      [{ ...event('ignored'), content: [{ type: 'text', text: '{}' }, { type: 'redacted' }] }]]) {
      f.set({ data, next_page: 'do-not-follow' });
      assert.equal(await readRemoteReport(f.http, f.value, sessionId), null);
    }
    assert.equal(f.calls.length, 5);
  } finally { await f.close(); }
});

test('wrong metadata, extra envelope fields and unsafe/deep/duplicate JSON fail closed', async () => {
  const f = await fixture();
  try {
    const report = envelope(f.value);
    const texts = ['intentId', 'executionId', 'epoch', 'acceptedRevision', 'assignmentDigest'].map(key =>
      JSON.stringify({ ...report, [key]: key === 'epoch' ? 2 : 'wrong' }));
    texts.push(JSON.stringify({ ...report, token: 'must-not-strip-and-accept' }), JSON.stringify({ ...report, result: { summary: '' } }),
      JSON.stringify(report).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      JSON.stringify(report).replace('"passed":true', '"passed":1e309'),
      JSON.stringify(report).replace('"passed":true', '"passed":' + '['.repeat(35) + '0' + ']'.repeat(35)));
    for (const text of texts) for (const presentation of [text, '```json\n' + text + '\n```']) {
      f.set({ data: [event(presentation)] }); await assert.rejects(readRemoteReport(f.http, f.value, sessionId));
    }
  } finally { await f.close(); }
});

test('ambiguous events, wrong provider event identity, text byte bounds and unsafe session paths reject', async () => {
  const f = await fixture();
  try {
    const report = JSON.stringify({ ...envelope(f.value), result: { summary: 'Valid', evidence: 'x'.repeat(63500) } });
    const padded = report + ' '.repeat(64000 - Buffer.byteLength(report));
    for (const body of [{ data: [event('{}'), event('{}')] }, { data: [{ ...event('{}'), type: 'user.message' }] },
      { data: [{ ...event('{}'), id: 'wrong' }] }, { data: [{ ...event('{}'), processed_at: 'not-a-date' }] },
      { data: [{ ...event('{}'), processed_at: '2026-02-30T00:00:00Z' }] },
      { data: [event('é'.repeat(32001))] }, { data: [event('x'.repeat(300000))] },
      { data: [event('```json\n' + padded + '\n```')] },
      { data: [{ ...event('{}'), session_id: 'sesn_other' }] }]) {
      f.set(body); await assert.rejects(readRemoteReport(f.http, f.value, sessionId));
    }
    const before = f.calls.length;
    await assert.rejects(readRemoteReport(f.http, f.value, '../sessions/other'));
    assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

test('transport redirect and timeout never follow another destination or retry a report', async () => {
  const f = await fixture();
  try {
    f.mode('redirect'); await assert.rejects(readRemoteReport(f.http, f.value, sessionId));
    assert.equal(f.calls.length, 1);
    f.mode('hang'); await assert.rejects(readRemoteReport(f.http, f.value, sessionId));
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

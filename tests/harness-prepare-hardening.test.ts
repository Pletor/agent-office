// The preparation runner under the failures its critics found (docs/harness.md "Preparation runner"):
// a store of thousands of records, refusals that must leave nothing, a lease Opora can't release, a
// restart between the claim and its record, recovery on shared checkouts and spoofed contracts, late
// adapter attempts, adapters writing outside their folder, a dry run on a cold data dir, and who may
// read a plan. The store is real (records, index, snapshots), Opora is the fake HTTP one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessProfiles, harnessRepoKey } from '../src/server/harness/profiles.js';
import { HarnessLibrary, harnessSources } from '../src/server/harness/catalog.js';
import { HarnessRegistry } from '../src/server/harness/registry.js';
import { fakeAdapter, registerAdapter } from '../src/server/harness/adapters.js';
import { prepareRun, preparePlan, redactPaths } from '../src/server/harness/prepare.js';
import { recoverRuns } from '../src/server/harness/prepare-recover.js';
import { activeDir, claimFile, markerFile, PREPARED_SCHEMA, preparedDir, readRecord, recordFile, recordScope, scopeDir, type PreparedRecord, type PrepareState } from '../src/server/harness/prepare-store.js';
import { sweepFinal } from '../src/server/harness/prepare-index.js';
import { preparePlanRequest } from '../src/server/harness/prepare-api.js';
import { officeHarness } from '../src/server/harness/api.js';
import { harnessPreparePlanRoute } from '../src/server/http/routes/harness.js';
import { requestHandler } from '../src/server/http/router.js';
import { claimAndSeat } from '../src/server/opora/prepared.js';
import { OporaError } from '../src/server/opora/client.js';
import { crash, leaseOps, place, records, restarted, setup, snapshots, tree } from './fixtures/prepare-setup.js';
import type { Ctx } from '../src/server/office/context.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const HOUR = 60 * 60_000, DAY = 24 * HOUR;
/** A pid no process has (Windows pids are multiples of 4): the owner of a record an office left when it stopped. */
const GONE = { pid: 4194303, token: 'office-that-stopped' };

/** Writes a record as the store does (with its marker in the index when `marker`), aged by `ageMs`. */
function synth(dir: string, runId: string, o: Partial<PreparedRecord> & { state: PrepareState; marker?: boolean; ageMs?: number; nodeId?: string }) {
  const at = new Date(Date.now() - (o.ageMs ?? HOUR)).toISOString();
  const { marker = o.state !== 'rolledBack', ageMs = HOUR, nodeId = 'c1', ...fields } = o;
  const r: PreparedRecord = {
    schema: PREPARED_SCHEMA, runId, repo: harnessRepoKey(dir), card: { ...place, nodeId }, revision: 3, createdAt: at, updatedAt: at, owner: GONE,
    adapters: ['context'], capabilities: [], contexts: {}, steps: (['resolve', 'availability', 'snapshot', 'adapters', 'verify'] as const).map((id) => ({ id, status: 'done', detail: '', attempts: [], writes: [] })),
    history: [{ state: 'planned', at }], ...fields,
  };
  mkdirSync(activeDir(dir), { recursive: true });
  writeFileSync(recordFile(dir, runId), JSON.stringify(r));
  const when = new Date(Date.now() - ageMs);
  utimesSync(recordFile(dir, runId), when, when);
  if (marker) writeFileSync(markerFile(dir, r), '');
  return r;
}
const indexed = (dir: string) => { mkdirSync(activeDir(dir), { recursive: true }); writeFileSync(path.join(activeDir(dir), '.indexed'), ''); };
const tempDir = (t: { after(fn: () => void): void }) => { const dir = mkdtempSync(path.join(tmpdir(), 'office-prepare-h-')); t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 })); return dir; };

test('B1: a store of over 2,000 records (from before the index): an orphan claimed run is still found and released, the card’s prepared run is still taken up, the poll never blocks, old final records go', async (t) => {
  const f = await setup(t, { adapters: 'fake', workersFile: true });
  f.bridge.shutdown();
  await crash('prepared', f.dir, f.op.url);
  const [prepared] = records(f.dir);
  assert.equal(prepared.state, 'prepared');
  // An office stopped holding c1's lease; its record's name sorts after every other.
  synth(f.dir, 'zzzzzzzz-orphan-claimed', { state: 'claimed', lease: { token: 'tok-c1-orphan', agent: 'a', at: new Date().toISOString() }, deskId: 'desk-3', floor: 'shop' });
  f.op.leases.set('c1', 'tok-c1-orphan');
  // 2,100 final records whose names sort first: 200 older than a week, the rest recent.
  for (let i = 0; i < 2100; i++) synth(f.dir, '0' + String(i).padStart(10, '0') + '-final', { state: 'rolledBack', nodeId: 'c9', ageMs: i < 200 ? 8 * DAY : i * 1000 });
  // A store written before the index: no markers at all.
  rmSync(activeDir(f.dir), { recursive: true, force: true });
  let lag = 0, last = performance.now();
  const beat = setInterval(() => { const now = performance.now(); lag = Math.max(lag, now - last - 5); last = now; }, 5);
  const again = restarted(t, f.dir, f.op.url);
  const started = Date.now();
  await again.bridge.poll();
  const pollMs = Date.now() - started;
  clearInterval(beat);
  const orphan = readRecord(f.dir, 'zzzzzzzz-orphan-claimed')!;
  assert.equal(orphan.state, 'rolledBack', JSON.stringify(orphan.history));
  assert.equal(f.op.leases.has('c1'), false, 'the orphan’s lease was released on Opora');
  assert.equal(orphan.lease?.token, undefined, 'the token is dropped once Opora confirmed the release');
  assert.ok(orphan.lease?.released, 'and the record says when it was released');
  assert.ok(lag < 500, `the event loop was blocked for ${Math.round(lag)} ms in one go`);
  assert.ok(pollMs < 30_000, `the poll took ${pollMs} ms`);
  // The card's prepared run is found by its index entry: taken up, not prepared a second time.
  assert.equal(await again.bridge.take('c2', 'Ana'), undefined);
  assert.equal(readRecord(f.dir, prepared.runId)!.state, 'seated');
  assert.deepEqual(records(f.dir).filter((r) => r.card.nodeId === 'c2').map((r) => r.runId), [prepared.runId], 'one run of the card');
  assert.equal(snapshots(f.dir).length, 1);
  // Final records go by age and past the count (200), a time budget per poll at a time.
  const deps = { workers: () => again.workers, held: new Set([prepared.runId]), release: async () => 'released' as const, floor: 'shop' };
  for (let i = 0; i < 100 && records(f.dir).filter((r) => r.state === 'rolledBack').length > 200; i++) await recoverRuns(f.dir, f.dir, deps);
  const finals = records(f.dir).filter((r) => r.state === 'rolledBack');
  assert.equal(finals.length, 200);
  assert.equal(finals.some((r) => r.runId < '00000000200'), false, 'the ones older than a week went first');
  assert.equal(readRecord(f.dir, prepared.runId)!.state, 'seated', 'a seated run is never swept with them');
});

test('the sweep removes final records by age and past the count, never a run that isn’t final, and stops at its time budget', async (t) => {
  const dir = tempDir(t);
  indexed(dir);
  for (const state of ['planned', 'preparing', 'prepared', 'claimed', 'failed', 'seated'] as const) synth(dir, 'aaaaaaaa-' + state, { state, ageMs: 30 * DAY });
  // A non-final record that lost its marker (a hand edit, a crash) isn't removed either: it is read before anything goes.
  synth(dir, 'dddddddd-claimed-unmarked', { state: 'claimed', marker: false, ageMs: 30 * DAY });
  for (let i = 0; i < 260; i++) synth(dir, 'bbbbbbbb-final-' + String(i).padStart(4, '0'), { state: 'rolledBack', ageMs: (i + 1) * 60_000 });
  for (let i = 0; i < 20; i++) synth(dir, 'cccccccc-old-' + i, { state: 'rolledBack', ageMs: 8 * DAY });
  assert.deepEqual(await sweepFinal(dir, Date.now(), { keep: 200, budgetMs: -1 }), [], 'a spent budget removes nothing; the next poll goes on');
  const removed = await sweepFinal(dir, Date.now(), { keep: 200, budgetMs: 60_000 });
  assert.equal(removed.length, 80, '20 by age, 60 past the count');
  const left = records(dir);
  assert.equal(left.filter((r) => r.state === 'rolledBack').length, 200);
  assert.equal(left.some((r) => r.runId.startsWith('cccccccc')), false);
  assert.equal(left.some((r) => r.runId === 'bbbbbbbb-final-0000'), true, 'the newest stay');
  assert.deepEqual(left.filter((r) => r.state !== 'rolledBack').map((r) => r.runId).sort(), ['aaaaaaaa-claimed', 'aaaaaaaa-failed', 'aaaaaaaa-planned', 'aaaaaaaa-prepared', 'aaaaaaaa-preparing', 'aaaaaaaa-seated', 'dddddddd-claimed-unmarked']);
});

test('a refusal before anything was created leaves no record and writes nothing; the same failure isn’t tried again until its cooldown passed, a profile change lets it at once', async (t) => {
  const f = await setup(t, { adapters: 'mcp', options: { cooldown: { baseMs: 400, maxMs: 10_000 } } });
  assert.match((await f.bridge.take('c2', 'Ana'))!, /Unsupported adapter, refused before anything was prepared: mcp .*Nothing was written; the card was not claimed\.$/);
  for (let i = 0; i < 5; i++) assert.match((await f.bridge.take('c2', 'Ana'))!, /It failed the same way 1 time in a row, so it is not tried again before/);
  assert.equal(existsSync(preparedDir(f.dir)), false, 'no record, no index, no lock file');
  assert.deepEqual(snapshots(f.dir), []);
  await new Promise((r) => setTimeout(r, 450));
  assert.doesNotMatch((await f.bridge.take('c2', 'Ana'))!, /not tried again/, 'tried again once the cooldown passed');
  assert.match((await f.bridge.take('c2', 'Ana'))!, /the same way 2 times in a row/, 'and the next cooldown is longer');
  await f.profiles.save(f.dir, '', 'repository', { 'rules.review': { resource: f.rule } }, 2);
  assert.equal(await f.bridge.take('c2', 'Ana'), undefined, 'a changed profile is tried at once');
  assert.equal(leaseOps(f.op, 'claim').length, 1);
});

test('a seat that fails while Opora can’t release the lease (503) keeps the run claimed; a later poll releases the lease and rolls the run back', async (t) => {
  const f = await setup(t, { adapters: 'fake', seat: () => 'The desk is broken' });
  f.op.failRelease = 503;
  assert.equal(await f.bridge.take('c2', 'Ana'), 'The desk is broken. Opora did not confirm the release of the lease: the run stays claimed and its lease is released at the next poll.');
  let [r] = records(f.dir);
  assert.equal(r.state, 'claimed', 'not rolled back while the lease may be held');
  assert.match(r.error!.reason, /Opora did not confirm the release/);
  assert.equal(f.op.leases.get('c2'), r.lease!.token);
  assert.equal(snapshots(f.dir).length, 1);
  await f.bridge.poll();
  [r] = records(f.dir);
  assert.equal(r.state, 'claimed', 'still 503: tried again at the next poll');
  assert.match(r.error!.reason, /did not answer/);
  f.op.failRelease = 0;
  await f.bridge.poll();
  [r] = records(f.dir);
  assert.equal(r.state, 'rolledBack');
  assert.equal(f.op.leases.has('c2'), false, 'the lease is gone from Opora');
  assert.equal(r.lease!.token, undefined);
  assert.ok(r.lease!.released);
  assert.deepEqual(snapshots(f.dir), []);
  assert.equal(existsSync(scopeDir(f.dir, r.runId)), false);
});

test('claimAndSeat: a release that throws (network) or answers 503 keeps the run claimed; 404/409/410 count as released and roll it back', async (t) => {
  const f = await setup(t);
  for (const [error, state] of [[new Error('fetch failed'), 'claimed'], [new OporaError(503, 'down'), 'claimed'], [new OporaError(404, 'no lease'), 'rolledBack'], [new OporaError(410, 'gone'), 'rolledBack']] as const) {
    const run = await prepareRun({ dataDir: f.dir, repo: f.dir, place, card: 'c2', nodes: f.bridge.canvasNodes(), local: false });
    const reply = await claimAndSeat({ context: '', state: 'prepared', claiming: run.claiming, claimed: run.claimed, seated: run.seated, releaseFailed: run.releaseFailed, discard: run.rollback }, { name: 'Pay API', group: 'dev', deskId: 'desk-1' }, 'agent', {
      claim: async () => ({ token: 't-' + state }), release: async () => { throw error; }, seat: async () => 'no desk', refused: () => 'refused',
    });
    const r = readRecord(f.dir, run.runId)!;
    assert.equal(r.state, state, `${error.message}: ${JSON.stringify(r.history)}`);
    assert.equal(r.deskId, 'desk-1');
    if (state === 'claimed') {
      assert.match(reply as string, /^no desk\. Opora did not confirm the release/);
      assert.equal(r.lease!.token, 't-claimed');
      await recoverRuns(f.dir, f.dir, { workers: () => [], held: new Set(), release: async () => 'released' });
      assert.equal(readRecord(f.dir, run.runId)!.state, 'rolledBack', 'the next recovery releases it');
    } else assert.equal(reply, 'no desk');
  }
});

test('restart between the claim and its record: the token written as the claim answered releases the lease', async (t) => {
  const f = await setup(t, { adapters: 'fake', workersFile: true });
  f.bridge.shutdown();
  await crash('claim-window', f.dir, f.op.url);
  let [r] = records(f.dir);
  assert.equal(r.state, 'prepared');
  assert.equal(r.claiming?.agent !== undefined, true, 'the claim was recorded as asked for');
  assert.ok(existsSync(claimFile(f.dir, r.runId)), 'the token went to disk as the claim answered');
  assert.ok(f.op.leases.has('c2'));
  const again = restarted(t, f.dir, f.op.url);
  await again.bridge.poll();
  [r] = records(f.dir);
  assert.equal(r.state, 'rolledBack');
  assert.equal(r.error?.step, 'claim');
  assert.equal(f.op.leases.has('c2'), false, 'the lease was released on Opora');
  assert.equal(existsSync(claimFile(f.dir, r.runId)), false);
  assert.equal(await again.bridge.take('c2', 'Ana'), undefined, 'and the card can be taken again');
});

test('restart while the claim was asked for, before Opora answered: no token exists anywhere, so the run is rolled back and says the lease runs out with its TTL', async (t) => {
  const g = await setup(t, { adapters: 'fake', workersFile: true });
  g.bridge.shutdown();
  await crash('claiming', g.dir, g.op.url);
  const other = restarted(t, g.dir, g.op.url);
  await other.bridge.poll();
  const [s] = records(g.dir);
  assert.equal(s.state, 'rolledBack');
  assert.match(s.error!.reason, /before Opora answered: a lease granted then runs out with its TTL/);
});

test('recovery: a claimed run the bridge holds is left alone, another floor’s run is not touched, and a Run: line alone adopts no one', async (t) => {
  const dir = tempDir(t);
  indexed(dir);
  const released: string[] = [];
  const deps = (o: { held?: string[]; shared?: boolean; workers?: Partial<WorkerInfo>[] } = {}) => ({
    workers: () => (o.workers ?? []) as WorkerInfo[], held: new Set(o.held ?? []), floor: 'shop', sharedCheckout: o.shared ?? false,
    release: async (_p: unknown, _c: string, token: string) => { released.push(token); return 'released' as const; },
  });
  const claimed = (runId: string, o: Partial<PreparedRecord> = {}) => synth(dir, runId, { state: 'claimed', lease: { token: 'tok-' + runId.slice(0, 1), agent: 'a', at: new Date().toISOString() }, deskId: 'desk-1', floor: 'shop', ...o });
  const state = (runId: string) => readRecord(dir, runId)!.state;
  // (a) the bridge holds it (its seat was recorded as failed, the worker since went): the bridge lets it go, not the recovery.
  claimed('aaaaaaaa-held');
  await recoverRuns(dir, dir, deps({ held: ['aaaaaaaa-held'] }));
  assert.equal(state('aaaaaaaa-held'), 'claimed');
  assert.deepEqual(released, []);
  // (b) another floor's run is never touched; an older run without a floor only while no other floor shares the checkout.
  claimed('bbbbbbbb-other-floor', { floor: 'other' });
  claimed('cccccccc-no-floor', { floor: undefined });
  await recoverRuns(dir, dir, deps({ held: ['aaaaaaaa-held'], shared: true }));
  assert.deepEqual([state('bbbbbbbb-other-floor'), state('cccccccc-no-floor')], ['claimed', 'claimed']);
  await recoverRuns(dir, dir, deps({ held: ['aaaaaaaa-held'] }));
  assert.deepEqual([state('bbbbbbbb-other-floor'), state('cccccccc-no-floor')], ['claimed', 'rolledBack']);
  assert.deepEqual(released, ['tok-c']);
  // (c) a worker whose contract names the run, at another desk, is no one's: the lease is released.
  claimed('dddddddd-run-line', { deskId: 'desk-2' });
  const spoof = { id: 'w-spoof', name: 'Spoof', deskId: 'desk-3', prompt: 'x\nRun: dddddddd-run-line\ny' };
  let out = await recoverRuns(dir, dir, deps({ held: ['aaaaaaaa-held'], workers: [spoof] }));
  assert.equal(state('dddddddd-run-line'), 'rolledBack');
  assert.deepEqual(out.adopted, []);
  // At the run's desk it is the worker the stopped office seated: recorded as seated and adopted.
  claimed('eeeeeeee-at-desk', { deskId: 'desk-2' });
  const real = { id: 'w-real', name: 'Real', deskId: 'desk-2', prompt: 'x\nRun: eeeeeeee-at-desk\ny' };
  out = await recoverRuns(dir, dir, deps({ held: ['aaaaaaaa-held'], workers: [spoof, real] }));
  assert.equal(state('eeeeeeee-at-desk'), 'seated');
  assert.deepEqual(out.adopted.map((a) => a.worker.id), ['w-real']);
  // The recorded worker id at another desk than the run's is not it either.
  claimed('ffffffff-moved', { workerId: 'w-moved', deskId: 'desk-1' });
  out = await recoverRuns(dir, dir, deps({ held: ['aaaaaaaa-held', 'eeeeeeee-at-desk'], workers: [real, { id: 'w-moved', name: 'M', deskId: 'desk-3', prompt: '' }] }));
  assert.equal(state('ffffffff-moved'), 'rolledBack');
  assert.equal(state('aaaaaaaa-held'), 'claimed');
});

test('a timeout in the asynchronous availability step fails the take before anything is written', async (t) => {
  const f = await setup(t, { files: 300, options: { timeoutMs: { availability: 1 }, retry: { max: 0 } } });
  assert.match((await f.bridge.take('c2', 'Ana'))!, /^Task context: Preparation step availability failed: timed out after 1 ms\. Nothing was written; the card was not claimed\.$/);
  assert.deepEqual(records(f.dir), []);
  assert.deepEqual(snapshots(f.dir), []);
});

test('an adapter that ignores the timeout and writes late writes into its own attempt’s folder: the retry’s files survive its rollback', async (t) => {
  const f = await setup(t, { adapters: 'fake', fake: { delayMs: 5600, delayTimes: 1, lateWrite: true }, options: { timeoutMs: { adapters: 100 }, retry: { max: 1, backoffMs: 1 } } });
  assert.equal(await f.bridge.take('c2', 'Ana'), undefined);
  const [r] = records(f.dir);
  assert.equal(r.scope, `harness-prepared/${r.runId}/2`, 'the retry prepared in its own folder');
  assert.deepEqual(r.steps.find((s) => s.id === 'adapters')!.attempts.map((a) => a.error), ['timed out after 100 ms']);
  // The first attempt writes after the retry was used, and is undone: only its own folder goes.
  await new Promise((done) => setTimeout(done, 1200));
  assert.equal(f.fake.calls.rollback, 1, 'the late attempt was rolled back, never used');
  assert.equal(existsSync(path.join(scopeDir(f.dir, r.runId), '1')), false, 'the late attempt’s folder is gone');
  assert.ok(existsSync(path.join(recordScope(f.dir, r), 'fake.json')), 'the retry’s scoped config is still there');
});

test('an adapter that reports writes outside its scoped folder is refused (not retried), rolled back, and the path is not shown absolute', async (t) => {
  const f = await setup(t, { adapters: 'fake', fake: { outside: 'escape.json' } });
  const reply = (await f.bridge.take('c2', 'Ana'))!;
  assert.match(reply, /adapter fake reported writes outside its scoped folder, refused: <dataDir>[\\/]escape\.json/);
  assert.equal(reply.includes(f.dir), false);
  const [r] = records(f.dir);
  assert.equal(r.state, 'rolledBack');
  assert.equal(r.error?.step, 'adapters');
  assert.deepEqual(f.fake.calls, { prepare: 1, rollback: 1, verify: 0 });
  assert.equal(leaseOps(f.op, 'claim').length, 0);
});

test('a dry run on a cold data dir writes nothing: no registry, no digest cache, no record; the take right after pins the digest it announced', async (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, '.harness', 'rules'), { recursive: true });
  writeFileSync(path.join(dir, '.harness', 'rules', 'review.md'), 'Review every change.\n');
  const listed = await new HarnessLibrary(harnessSources(dir, false), new HarnessRegistry(dir)).list({ persist: false });
  assert.equal(existsSync(path.join(dir, 'harness-registry.json')), false, 'a listing with persist: false records nothing');
  const rule = listed.entries.find((e) => e.path === 'rules/review.md')!.id;
  const profiles = new HarnessProfiles(dir);
  await profiles.save(dir, '', 'repository', { 'rules.review': { resource: rule }, adapters: { value: 'fake' } }, 0);
  // Cold: the library never recorded anything here.
  for (const file of ['harness-registry.json', 'harness-digests.json']) rmSync(path.join(dir, file), { force: true });
  const fake = fakeAdapter();
  t.after(registerAdapter(fake.adapter));
  const before = tree(dir);
  const nodes = [{ id: 'c2', kind: 'node', name: 'Pay API', parentId: null }] as never;
  const plan = await preparePlan({ dataDir: dir, repo: dir, place, card: 'c2', nodes, local: false });
  let status = 0, body = '';
  const res = { writeHead: (s: number) => { status = s; }, end: (b: string) => { body = b; } };
  await preparePlanRequest({ cfg: { dataDir: dir } } as never, { id: 'shop', dir, opora: { view: () => ({ project: { id: 'p1' }, workspace: 'draft' }), canvasNodes: () => nodes } } as never, res as never, new URL('http://x/?task=opora:p1:draft:c2'), false);
  assert.equal(status, 200, body);
  assert.deepEqual(tree(dir), before, 'not one file was written, changed or touched');
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(JSON.parse(body).digest, plan.digest);
  assert.equal(JSON.stringify(plan).includes(dir), false, 'no absolute path in the plan');
  const run = await prepareRun({ dataDir: dir, repo: dir, place, card: 'c2', nodes, local: false });
  assert.equal(run.digest, plan.digest, 'the revision the plan predicted is the one the take recorded');
  await run.rollback('test over');
});

test('plan errors name no server folder: a refusal is redacted, an unexpected error is not sent', async (t) => {
  assert.equal(redactPaths('C:\\data\\office\\x.json and C:/data/office/y and C:\\repo\\a', { '<dataDir>': 'C:\\data\\office', '<checkout>': 'C:\\repo' }), '<dataDir>\\x.json and <dataDir>/y and <checkout>\\a');
  const dir = tempDir(t);
  let status = 0, body = '';
  const res = { writeHead: (s: number) => { status = s; }, end: (b: string) => { body = b; } };
  const log = console.error;
  console.error = () => undefined;
  t.after(() => { console.error = log; });
  await preparePlanRequest({ cfg: { dataDir: dir } } as never, { id: 'shop', dir, opora: { view: () => ({ project: { id: 'p1' }, workspace: 'draft' }), canvasNodes: () => { throw new Error(`EPERM: operation not permitted, open '${dir}\\secret'`); } } } as never, res as never, new URL('http://x/?task=opora:p1:draft:c2'), false);
  assert.equal(status, 500);
  assert.equal(body.includes(dir), false, body);
});

test('who may read a plan: anonymous no, a member and an administrator yes, a worker only for its own floor’s project; another project’s card is refused', async (t) => {
  const dir = tempDir(t), elsewhere = tempDir(t);
  const floorOf = (id: string, at: string, project: string) => ({ id, dir: at, opora: { view: () => ({ project: { id: project }, workspace: 'draft' }), canvasNodes: () => [] }, workers: { authenticate: (w: string, token: string) => (token === 'tok-' + w && w.startsWith(id) ? { id: w } : undefined) }, planning: { state: () => ({ current: undefined }) } });
  const floors = new Map([['shop', floorOf('shop', dir, 'p1')], ['other', floorOf('other', elsewhere, 'p2')]]);
  const sessions: Record<string, unknown> = { member: { account: { id: 'm', role: 'member' } }, admin: { account: { id: 'a', role: 'admin' } }, shared: {} };
  const ctx = {
    cfg: { dataDir: dir, port: 1, tailnet: undefined }, floors, services: { lookup: () => undefined }, accounts: { get: () => undefined },
    auth: { fromRequest: (req: http.IncomingMessage) => sessions[String(req.headers['x-session'])], fromAnyCookie: () => undefined },
    workerFloor: (w: string) => [...floors.values()].find((f) => w.startsWith(f.id)),
  } as unknown as Ctx;
  const routes = requestHandler(ctx, [harnessPreparePlanRoute]);
  const server = http.createServer((req, res) => (req.url!.startsWith('/office/harness') ? void officeHarness(ctx, req, res, new URL(req.url!, 'http://x')) : void routes(req, res)));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const session = (who: string, query: string) => fetch(`${base}/api/harness/prepare-plan?${query}`, { headers: { 'x-session': who } }).then((r) => r.status);
  const worker = (w: string, token: string, task: string) => fetch(`${base}/office/harness?worker=${w}&preparePlan=1&task=${encodeURIComponent(task)}`, { headers: token ? { authorization: 'Bearer ' + token } : {} }).then((r) => r.status);
  const card = 'floor=shop&task=' + encodeURIComponent('opora:p1:draft:c2');
  assert.equal(await session('nobody', card), 401, 'anonymous');
  assert.equal(await session('member', card), 200, 'a member reads the plan (project-published resources)');
  assert.equal(await session('admin', card), 200, 'an administrator');
  assert.equal(await session('shared', card), 200, 'the shared-password session');
  assert.equal(await session('member', 'floor=shop&task=' + encodeURIComponent('opora:p2:draft:c9')), 409, 'another project’s card');
  assert.equal(await session('member', 'floor=nope&task=x'), 404);
  assert.equal(await session('member', 'floor=shop&task=c2'), 400);
  assert.equal(await worker('shop-w1', 'tok-shop-w1', 'opora:p1:draft:c2'), 200, 'a worker of the floor');
  assert.equal(await worker('other-w1', 'tok-other-w1', 'opora:p1:draft:c2'), 409, 'a worker of another floor, for this floor’s card');
  assert.equal(await worker('shop-w1', 'tok-other-w1', 'opora:p1:draft:c2'), 401, 'a forged token');
  assert.equal(await worker('shop-w1', '', 'opora:p1:draft:c2'), 401, 'no token');
  assert.equal(existsSync(preparedDir(dir)), false, 'no plan prepared anything');
});

test('a record is acted on only with its own state and the shape it should have', (t) => {
  const dir = tempDir(t);
  const r = synth(dir, 'aaaaaaaa-good', { state: 'claimed' });
  assert.ok(readRecord(dir, r.runId));
  for (const [id, bad] of [['aaaaaaaa-tostring', { state: 'toString' }], ['aaaaaaaa-proto', { state: '__proto__' }], ['aaaaaaaa-lease', { lease: { token: 5, agent: 'a', at: '' } }], ['aaaaaaaa-owner', { owner: 'me' }], ['aaaaaaaa-steps', { steps: [{ id: 'nope', attempts: [], writes: [] }] }]] as const) {
    writeFileSync(recordFile(dir, id), JSON.stringify({ ...r, runId: id, ...bad }));
    assert.equal(readRecord(dir, id), undefined, id);
  }
});

test('a snapshot that can’t be removed keeps the run failed with the reason; a recovery finishes the rollback once it can', async (t) => {
  const f = await setup(t, { adapters: 'fake' });
  const run = await prepareRun({ dataDir: f.dir, repo: f.dir, place, card: 'c2', nodes: f.bridge.canvasNodes(), local: false });
  const snap = path.join(f.dir, 'harness-snapshots', run.runId + '.json');
  rmSync(snap);
  mkdirSync(snap);
  writeFileSync(path.join(snap, 'held'), 'x');
  await run.rollback('test over');
  let r = readRecord(f.dir, run.runId)!;
  assert.equal(r.state, 'failed');
  assert.match(r.rollback!.errors.join(';'), /^snapshot: /);
  assert.ok(readdirSync(activeDir(f.dir)).some((n) => n.endsWith(run.runId)), 'still in the index of active runs');
  rmSync(snap, { recursive: true, force: true });
  const { done } = await recoverRuns(f.dir, f.dir, { workers: () => [], held: new Set(), release: async () => 'released' });
  assert.deepEqual(done.map((d) => d.action), ['rollback finished']);
  r = readRecord(f.dir, run.runId)!;
  assert.equal(r.state, 'rolledBack');
});

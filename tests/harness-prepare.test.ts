// The preparation runner (src/server/harness/prepare.ts, docs/harness.md "Preparation runner"): a card is
// claimed only once its run is prepared and verified, and seated only once claimed; a failure at any
// step rolls the run back and never leaves a lease on Opora; a restarted office neither prepares nor
// starts a run twice. Everything goes through the real bridge and a fake Opora over HTTP; the restarts
// are real processes that exit in the middle of a take (tests/fixtures/prepare-crash.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HarnessProfiles } from '../src/server/harness/profiles.js';
import { HarnessLibrary, harnessSources } from '../src/server/harness/catalog.js';
import { HarnessRegistry } from '../src/server/harness/registry.js';
import { fakeAdapter, listAdapters, registerAdapter, resolveAdapters, type FakeAdapterOptions } from '../src/server/harness/adapters.js';
import { finishRollback, prepareRun, preparePlan, type PrepareOptions } from '../src/server/harness/prepare.js';
import { preparedCardRun, recoverRuns } from '../src/server/harness/prepare-recover.js';
import { listRecords, PREPARE_TRANSITIONS, scopeDir, type PreparedRecord } from '../src/server/harness/prepare-store.js';
import { preparePlanRequest } from '../src/server/harness/prepare-api.js';
import { loadSnapshot } from '../src/server/harness/snapshot.js';
import { claimAndSeat } from '../src/server/opora/prepared.js';
import { remoteHarness } from '../bin/harness-remote.js';
import { bridgeOn, fakeFloor, fakeOpora } from './fixtures/prepare-opora.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const place = { project: 'p1', workspace: 'draft' };

/** Shop's checkout with a rule bound at the project, the fake adapter registered and named by the profile when `adapters` says so. */
async function setup(t: { after(fn: () => void | Promise<void>): void }, o: { adapters?: string; fake?: FakeAdapterOptions; options?: PrepareOptions; seat?: (deskId: string, prompt: string) => string | undefined; workersFile?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-prepare-'));
  const op = await fakeOpora(dir);
  const cleanup: (() => void | Promise<void>)[] = [() => op.close(), () => rmSync(dir, { recursive: true, force: true })];
  t.after(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });
  mkdirSync(path.join(dir, '.harness', 'rules'), { recursive: true });
  writeFileSync(path.join(dir, '.harness', 'rules', 'review.md'), 'Review every change.\n');
  const catalog = await new HarnessLibrary(harnessSources(dir, false), new HarnessRegistry(dir)).list();
  const rule = catalog.entries.find((e) => e.path === 'rules/review.md')!.id;
  const profiles = new HarnessProfiles(dir);
  await profiles.save(dir, '', 'global', { language: { value: 'en' } }, 0);
  await profiles.save(dir, '', 'repository', { 'rules.review': { resource: rule }, ...(o.adapters !== undefined ? { adapters: { value: o.adapters } } : {}) }, 1);
  const fake = fakeAdapter(o.fake);
  const off = registerAdapter(fake.adapter);
  const { floor, workers } = fakeFloor(dir, o.workersFile ? path.join(dir, 'workers.json') : undefined, o.seat);
  const { bridge, toasts } = bridgeOn(floor, dir, op.url, {
    prepareTask: (project, workspace, card, _owner, nodes) => preparedCardRun(dir, dir, { project, workspace }, card, nodes, false, o.options),
    recoverRuns: async (recovery) => (await recoverRuns(dir, dir, recovery)).adopted,
  });
  cleanup.push(off, () => bridge.shutdown());
  await bridge.poll();
  return { dir, op, bridge, toasts, workers, fake, profiles, rule };
}

const records = (dir: string) => listRecords(dir).records;
const snapshots = (dir: string) => (existsSync(path.join(dir, 'harness-snapshots')) ? readdirSync(path.join(dir, 'harness-snapshots')) : []);
const leaseOps = (op: { calls: { path: string; body?: Record<string, unknown> }[] }, kind: string) => op.calls.filter((c) => c.path === '/api/desktop-v3/lease' && c.body?.op === kind);

/** Every file under `dir` with a digest of its content: what a dry run must leave exactly as it was. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const file = path.join(at, name);
      if (statSync(file).isDirectory()) walk(file);
      else out[path.relative(dir, file)] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

/** Asserts a failed take left nothing: no lease of ours on Opora, no snapshot, no scoped files, the run rolled back with the step that failed. */
function assertRolledBack(f: Awaited<ReturnType<typeof setup>>, step: string) {
  const [r] = records(f.dir);
  assert.equal(r.state, 'rolledBack', JSON.stringify(r.history));
  assert.equal(r.error?.step, step);
  assert.deepEqual(r.rollback?.errors, []);
  assert.deepEqual(snapshots(f.dir), [], 'the snapshot is gone');
  assert.equal(existsSync(scopeDir(f.dir, r.runId)), false, 'the scoped files are gone');
  assert.equal(f.workers.length, 0, 'nobody was seated');
  assert.equal([...f.op.leases.values()].some((token) => token.startsWith('tok-')), false, 'no lease of ours is left on Opora');
}

test('prepare → claim → seat through the bridge and Opora: the run walks the state machine, its capabilities are verified, the lease is held', async (t) => {
  const f = await setup(t, { adapters: 'fake' });
  assert.equal(await f.bridge.take('c2', 'Ana'), undefined);
  const [r] = records(f.dir);
  assert.deepEqual(r.history.map((h) => h.state), ['planned', 'preparing', 'prepared', 'claimed', 'seated']);
  assert.deepEqual(r.steps.map((s) => [s.id, s.status]), [['resolve', 'done'], ['availability', 'done'], ['snapshot', 'done'], ['adapters', 'done'], ['verify', 'done']]);
  assert.deepEqual(r.adapters, ['context', 'fake']);
  assert.ok(r.capabilities.length >= 3 && r.capabilities.every((c) => c.state === 'verified'), JSON.stringify(r.capabilities));
  assert.equal(r.workerId, f.workers[0].id);
  assert.equal(f.op.leases.get('c2'), r.lease?.token, 'the lease on Opora is the one the run recorded');
  assert.match(f.workers[0].prompt!, new RegExp('Run: ' + r.runId + '\\nSnapshot SHA-256: ' + r.digest));
  assert.match(f.workers[0].prompt!, /Review every change\./);
  assert.equal(loadSnapshot(f.dir, r.runId).digest, r.digest);
  assert.ok(existsSync(path.join(scopeDir(f.dir, r.runId), 'fake.json')), 'the adapter’s scoped config is in place');
  assert.deepEqual(f.fake.calls, { prepare: 1, rollback: 0, verify: 1 });
  assert.equal(f.bridge.snapshotOf(f.workers[0].id)?.runId, r.runId);
  // Claim before prepared and seat before claimed are refused by the state machine itself.
  assert.deepEqual(PREPARE_TRANSITIONS.preparing.includes('claimed'), false);
  assert.deepEqual(PREPARE_TRANSITIONS.prepared.includes('seated'), false);
});

for (const c of [
  { name: 'an adapter that throws', o: { adapters: 'fake', fake: { throws: 'adapter exploded' }, options: { retry: { max: 0 } } }, match: /Task context: Preparation step adapters failed.*adapter exploded/, step: 'adapters', claims: 0 },
  { name: 'an adapter past its timeout', o: { adapters: 'fake', fake: { delayMs: 400 }, options: { timeoutMs: { adapters: 60 }, retry: { max: 0 } } }, match: /Task context: Preparation step adapters failed.*timed out after 60 ms/, step: 'adapters', claims: 0 },
  { name: 'an adapter that does not verify', o: { adapters: 'fake', fake: { verifyFails: 'config not readable' } }, match: /Task context: .*verify failed.*config not readable/, step: 'verify', claims: 0 },
  { name: 'a seat that returns an error', o: { seat: () => 'The desk is broken' }, match: /^The desk is broken$/, step: 'seat', claims: 1 },
  { name: 'a seat that throws', o: { seat: () => { throw new Error('spawn EPERM'); } }, match: /^spawn EPERM$/, step: 'seat', claims: 1 },
] as const) {
  test(`a take that fails at ${c.name} rolls the run back and leaves no lease on Opora`, async (t) => {
    const f = await setup(t, c.o as Parameters<typeof setup>[1]);
    assert.match((await f.bridge.take('c2', 'Ana'))!, c.match);
    assertRolledBack(f, c.step);
    assert.equal(leaseOps(f.op, 'claim').length, c.claims);
    assert.equal(f.op.leases.has('c2'), false, 'Opora holds no lease for the card');
    if (c.claims) assert.equal(leaseOps(f.op, 'release').length, 1, 'the lease was released');
    if (c.step === 'verify') assert.equal(f.fake.calls.rollback, 1, 'the adapter’s own rollback ran');
  });
}

test('a claim Opora refuses (409) rolls the run back, and the other holder keeps its lease', async (t) => {
  const f = await setup(t, { adapters: 'fake' });
  f.op.leases.set('c2', 'someone-else');
  assert.equal(await f.bridge.take('c2', 'Ana'), 'Someone else holds “Pay API” on Opora');
  const [r] = records(f.dir);
  assert.equal(r.state, 'rolledBack');
  assert.equal(r.error?.step, 'claim');
  assert.match(r.error!.reason, /claim was refused/);
  assert.deepEqual(snapshots(f.dir), []);
  assert.equal(existsSync(scopeDir(f.dir, r.runId)), false);
  assert.equal(f.fake.calls.rollback, 1, 'the adapter’s own rollback ran');
  assert.equal(f.op.leases.get('c2'), 'someone-else');
  assert.equal(leaseOps(f.op, 'release').length, 0, 'nobody else’s lease is released');
});

test('a retry within the budget passes, and the failed attempt is recorded with its reason', async (t) => {
  const f = await setup(t, { adapters: 'fake', fake: { throws: 'EBUSY: config locked', throwTimes: 1 }, options: { retry: { max: 1, backoffMs: 1 } } });
  assert.equal(await f.bridge.take('c2', 'Ana'), undefined);
  const adapters = records(f.dir)[0].steps.find((s) => s.id === 'adapters')!;
  assert.equal(adapters.status, 'done');
  assert.deepEqual(adapters.attempts.map((a) => a.error), ['EBUSY: config locked']);
  assert.equal(f.fake.calls.prepare, 2);
});

test('an exhausted retry budget fails the take with every attempt recorded; a deterministic refusal is not retried', async (t) => {
  const g = await setup(t, { adapters: 'fake', fake: { throws: 'EBUSY: config locked' }, options: { retry: { max: 2, backoffMs: 1 } } });
  assert.match((await g.bridge.take('c2', 'Ana'))!, /adapters failed after 3 attempts \(retry budget 2\): EBUSY: config locked/);
  assert.equal(g.fake.calls.prepare, 3);
  assert.deepEqual(records(g.dir)[0].steps.find((s) => s.id === 'adapters')!.attempts.map((a) => a.error), ['EBUSY: config locked', 'EBUSY: config locked', 'EBUSY: config locked']);
  assertRolledBack(g, 'adapters');
  // A deterministic refusal is not retried: an element that is gone is gone however often it is asked.
  rmSync(path.join(g.dir, '.harness', 'rules', 'review.md'));
  await new HarnessLibrary(harnessSources(g.dir, false), new HarnessRegistry(g.dir)).list();
  assert.match((await g.bridge.take('c1', 'Ana'))!, /availability failed after 1 attempt \(retry budget 2\): Assigned harness resource is unavailable/);
});

test('an adapter the office does not have, or one that belongs to H13, is refused with the reason before anything is written', async (t) => {
  const f = await setup(t, { adapters: 'mcp, nope' });
  const reply = (await f.bridge.take('c2', 'Ana'))!;
  assert.match(reply, /Unsupported adapters, refused before anything was prepared: mcp \(the runner this card's worker is seated with is not known[^)]*\); nope \(no adapter with this id is registered/);
  assert.equal(leaseOps(f.op, 'claim').length, 0);
  assertRolledBack(f, 'availability');
  assert.equal(records(f.dir)[0].steps.find((s) => s.id === 'snapshot')!.status, 'pending', 'the snapshot step was never reached');
  const plan = await preparePlan({ dataDir: f.dir, repo: f.dir, place, card: 'c2', nodes: f.bridge.canvasNodes(), local: false });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.refused.map((x) => x.id), ['mcp', 'nope']);
  const unsupported = fakeAdapter({ id: 'gpu', unsupported: 'no GPU on this machine' });
  const off = registerAdapter(unsupported.adapter);
  t.after(off);
  assert.deepEqual(resolveAdapters(['gpu']).refused, [{ id: 'gpu', reason: 'no GPU on this machine' }]);
  assert.deepEqual(listAdapters().map((a) => a.id).slice(0, 1), ['context'], 'the context adapter is built in');
});

test('a dry run reports every step, the requirements and what would be written, and writes nothing', async (t) => {
  const f = await setup(t, { adapters: 'fake' });
  const before = tree(f.dir);
  const plan = await preparePlan({ dataDir: f.dir, repo: f.dir, place, card: 'c2', nodes: f.bridge.canvasNodes(), local: false }, { timeoutMs: 5000, retry: { max: 1, backoffMs: 10 } });
  assert.deepEqual(tree(f.dir), before, 'not one file was written or changed');
  assert.equal(plan.ok, true, plan.reason);
  assert.deepEqual(plan.steps.map((s) => [s.id, s.status]), [['resolve', 'planned'], ['availability', 'planned'], ['snapshot', 'planned'], ['adapters', 'planned'], ['verify', 'planned']]);
  assert.deepEqual(plan.adapters, ['context', 'fake']);
  assert.ok(plan.requirements.every((c) => c.state === 'declared'), 'a plan only declares');
  assert.ok(plan.writes.some((w) => w.endsWith(path.join('harness-prepared', '<runId>.json'))));
  assert.ok(plan.steps.find((s) => s.id === 'adapters')!.writes.some((w) => w.endsWith('fake.json')));
  assert.equal(plan.options.retry.max, 1);
  assert.equal(f.fake.calls.prepare, 0);
  // The take that follows pins the same digest the plan announced.
  assert.equal(await f.bridge.take('c2', 'Ana'), undefined);
  assert.equal(records(f.dir)[0].digest, plan.digest);
});

test('the plan over HTTP: a card of the floor’s project is planned, another project’s is refused; the CLI asks the worker route for it', async (t) => {
  const f = await setup(t);
  const reply = async (key: string) => {
    let status = 0, body = '';
    const res = { writeHead: (s: number) => { status = s; }, end: (b: string) => { body = b; } };
    const floor = { id: 'shop', dir: f.dir, opora: { view: () => ({ project: { id: 'p1', name: 'Shop' }, workspace: 'draft' }), canvasNodes: () => f.bridge.canvasNodes() } };
    await preparePlanRequest({ cfg: { dataDir: f.dir } } as never, floor as never, res as never, new URL('http://x/?task=' + encodeURIComponent(key)), false);
    return { status, body: JSON.parse(body) };
  };
  const ok = await reply('opora:p1:draft:c2');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.dryRun, true);
  assert.equal((await reply('opora:other:draft:c9')).status, 409);
  assert.equal((await reply('c2')).status, 400);
  assert.deepEqual(records(f.dir), [], 'the route prepared nothing');
  const urls: string[] = [];
  const log = console.log;
  console.log = () => undefined;
  t.after(() => { console.log = log; });
  process.env.AGENT_OFFICE_HOOK_URL = 'http://127.0.0.1:1';
  t.after(() => { delete process.env.AGENT_OFFICE_HOOK_URL; });
  await remoteHarness(['--prepare-plan', '--task', 'opora:p1:draft:c2'], async (url: URL) => { urls.push(String(url)); return { ok: true, json: async () => ok.body } as Response; });
  assert.match(urls[0], /\/office\/harness\?worker=.*&task=opora%3Ap1%3Adraft%3Ac2&preparePlan=1/);
  await assert.rejects(remoteHarness(['--prepare-plan'], async () => { throw new Error('no call'); }), /--prepare-plan takes the card it plans/);
});

test('two takes of one card at once: one prepares it, the other is refused, nothing is prepared twice', async (t) => {
  const f = await setup(t, { adapters: 'fake', fake: { delayMs: 100 } });
  const ctx = { dataDir: f.dir, repo: f.dir, place, card: 'c2', nodes: f.bridge.canvasNodes(), local: false };
  const [a, b] = await Promise.allSettled([prepareRun(ctx), prepareRun(ctx)]);
  const won = [a, b].filter((x) => x.status === 'fulfilled');
  const lost = [a, b].filter((x) => x.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(won.length, 1);
  assert.match(lost[0].reason.message, /is (planned|preparing) by this office; it is not prepared or started a second time/);
  assert.equal(f.fake.calls.prepare, 1);
  assert.equal(snapshots(f.dir).length, 1);
  await (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof prepareRun>>>).value.rollback('test over');
});

test('a run moved meanwhile (a recovery rolled it back) is never claimed: the lease is let go and nothing is seated', async (t) => {
  const f = await setup(t);
  const run = await prepareRun({ dataDir: f.dir, repo: f.dir, place, card: 'c2', nodes: f.bridge.canvasNodes(), local: false });
  await finishRollback(f.dir, run.runId, 'swept by a recovery');
  const released: string[] = [];
  let seated = 0;
  const reply = await claimAndSeat({ context: run.context, state: 'prepared', claimed: run.claimed, seated: run.seated, discard: run.rollback }, { name: 'Pay API', group: 'dev' }, 'agent', {
    claim: async () => ({ token: 't1' }),
    release: async (token) => { released.push(token); },
    seat: async () => { seated++; return {} as WorkerInfo; },
    refused: () => 'refused',
  });
  assert.match(reply as string, /Task context: Run .* is rolledBack now, not prepared/);
  assert.deepEqual(released, ['t1']);
  assert.equal(seated, 0);
  // A task that isn't prepared is not even claimed.
  let claims = 0;
  assert.match(await claimAndSeat({ context: '', state: 'preparing' }, { name: 'x', group: 'dev' }, 'a', { claim: async () => { claims++; return { token: 't' }; }, release: async () => undefined, seat: async () => 'no', refused: () => '' }) as string, /not prepared; the card was not claimed/);
  assert.equal(claims, 0);
});

const crash = (mode: string, dir: string, url: string) => promisify(execFile)(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'fixtures', 'prepare-crash.ts'), mode, dir, url, path.join(dir, 'workers.json')], { cwd: path.join(import.meta.dirname, '..'), timeout: 110_000 });

test('restart after the run was prepared: the next take finds it and uses it, without preparing it again', async (t) => {
  const f = await setup(t, { adapters: 'fake', workersFile: true });
  f.bridge.shutdown();
  await crash('prepared', f.dir, f.op.url);
  const [before] = records(f.dir);
  assert.equal(before.state, 'prepared');
  assert.equal(leaseOps(f.op, 'claim').length, 0);
  const scoped = statSync(path.join(scopeDir(f.dir, before.runId), 'fake.json')).mtimeMs;
  // The office starts again: the prepared run is left for the next take of its card, which takes it up.
  const { floor, workers } = fakeFloor(f.dir, path.join(f.dir, 'workers.json'));
  const again = bridgeOn(floor, f.dir, f.op.url, { prepareTask: (project, workspace, card, _o, nodes) => preparedCardRun(f.dir, f.dir, { project, workspace }, card, nodes, false), recoverRuns: async (r) => (await recoverRuns(f.dir, f.dir, r)).adopted });
  t.after(() => again.bridge.shutdown());
  await again.bridge.poll();
  assert.equal(records(f.dir)[0].state, 'prepared', 'a fresh prepared run survives the recovery');
  assert.equal(await again.bridge.take('c2', 'Ana'), undefined);
  const after = records(f.dir);
  assert.equal(after.length, 1, 'no second run');
  assert.equal(after[0].runId, before.runId);
  assert.equal(after[0].state, 'seated');
  assert.ok(after[0].history.some((h) => /taken up again after a restart/.test(h.note ?? '')));
  assert.equal(snapshots(f.dir).length, 1, 'no second snapshot');
  assert.deepEqual(f.fake.calls, { prepare: 0, rollback: 0, verify: 1 }, 'the adapter was verified, not prepared again');
  assert.equal(statSync(path.join(scopeDir(f.dir, before.runId), 'fake.json')).mtimeMs, scoped, 'the scoped config was not rewritten');
  assert.equal(workers.length, 1);
  assert.match(workers[0].prompt!, new RegExp('Run: ' + before.runId));
});

test('restart after the claim, before the seat: the lease is released, the run rolled back, nobody seated; the card is taken again by a new run', async (t) => {
  const f = await setup(t, { adapters: 'fake', workersFile: true });
  f.bridge.shutdown();
  await crash('claimed', f.dir, f.op.url);
  const [before] = records(f.dir);
  assert.equal(before.state, 'claimed');
  assert.equal(f.op.leases.get('c2'), before.lease!.token, 'the stopped office held the lease');
  const { floor, workers } = fakeFloor(f.dir, path.join(f.dir, 'workers.json'));
  const again = bridgeOn(floor, f.dir, f.op.url, { prepareTask: (project, workspace, card, _o, nodes) => preparedCardRun(f.dir, f.dir, { project, workspace }, card, nodes, false), recoverRuns: async (r) => (await recoverRuns(f.dir, f.dir, r)).adopted });
  t.after(() => again.bridge.shutdown());
  await again.bridge.poll();
  const [r] = records(f.dir);
  assert.equal(r.state, 'rolledBack');
  assert.equal(f.op.leases.has('c2'), false, 'the lease was released on Opora');
  assert.deepEqual(snapshots(f.dir), []);
  assert.equal(existsSync(scopeDir(f.dir, r.runId)), false);
  assert.equal(workers.length, 0);
  await again.bridge.poll();
  assert.equal(await again.bridge.take('c2', 'Ana'), undefined);
  assert.equal(workers.length, 1);
  assert.notEqual(records(f.dir)[0].runId, before.runId);
});

test('restart right after the seat, before it was recorded: the run is recorded as seated and held, no second worker is seated', async (t) => {
  const f = await setup(t, { adapters: 'fake', workersFile: true });
  f.bridge.shutdown();
  await crash('seat-window', f.dir, f.op.url);
  const [before] = records(f.dir);
  assert.equal(before.state, 'claimed');
  const { floor, workers } = fakeFloor(f.dir, path.join(f.dir, 'workers.json'));
  assert.equal(workers.length, 1, 'the worker the stopped office seated is still at its desk');
  const again = bridgeOn(floor, f.dir, f.op.url, { prepareTask: (project, workspace, card, _o, nodes) => preparedCardRun(f.dir, f.dir, { project, workspace }, card, nodes, false), recoverRuns: async (r) => (await recoverRuns(f.dir, f.dir, r)).adopted });
  t.after(() => again.bridge.shutdown());
  await again.bridge.poll();
  const [r] = records(f.dir);
  assert.equal(r.state, 'seated');
  assert.equal(r.workerId, workers[0].id);
  assert.equal(again.bridge.snapshotOf(workers[0].id)?.runId, before.runId, 'the bridge holds the run again');
  assert.equal(f.op.leases.get('c2'), before.lease!.token, 'the worker keeps its lease');
  assert.match((await again.bridge.take('c2', 'Ana'))!, /isn’t free|already on|isn’t on the canvas/);
  await again.bridge.poll();
  assert.equal(workers.length, 1, 'no second worker');
  assert.equal(records(f.dir).length, 1, 'no second run');
});

test('stale records are swept by age: a prepared run nobody claims is rolled back, final records go after a week', async (t) => {
  const f = await setup(t, { adapters: 'fake', workersFile: true });
  f.bridge.shutdown();
  await crash('prepared', f.dir, f.op.url);
  const deps = { workers: () => [], held: new Set<string>(), release: async () => 'released' as const };
  const { done } = await recoverRuns(f.dir, f.dir, deps, Date.now() + 31 * 60_000);
  assert.deepEqual(done.map((d) => d.action), ['rolled back (stale)']);
  const [r] = records(f.dir) as PreparedRecord[];
  assert.equal(r.state, 'rolledBack');
  assert.deepEqual(snapshots(f.dir), []);
  assert.equal(existsSync(scopeDir(f.dir, r.runId)), false);
  await recoverRuns(f.dir, f.dir, deps, Date.now() + 8 * 24 * 60 * 60_000);
  assert.deepEqual(records(f.dir), []);
});

test('a timed-out adapter that writes late is waited for and undone: no scoped file outlives the rollback', async (t) => {
  const f = await setup(t, { adapters: 'fake', fake: { delayMs: 300, lateWrite: true }, options: { timeoutMs: { adapters: 50 }, retry: { max: 0 } } });
  assert.match((await f.bridge.take('c2', 'Ana'))!, /adapters failed: timed out after 50 ms/);
  const [r] = records(f.dir);
  await new Promise((done) => setTimeout(done, 400));
  assert.equal(existsSync(scopeDir(f.dir, r.runId)), false, 'the late write was undone');
  assert.equal(f.fake.calls.rollback, 1, 'the late result was rolled back, never used');
  assertRolledBack(f, 'adapters');
});

test('a poll’s recovery while a take is under way leaves the run alone: the lease is kept and the run ends seated', async (t) => {
  let recovery: Promise<unknown> | undefined;
  let seen = '';
  const f = await setup(t, { adapters: 'fake', seat: () => {
    const [r] = records(f.dir);
    seen = r.state;
    // The run is claimed and in flight; no worker is at a desk yet. A recovery now must not release its lease.
    recovery = recoverRuns(f.dir, f.dir, { workers: () => [], held: new Set(), release: async () => { throw new Error('the lease of a take under way was released'); } });
    return undefined;
  } });
  assert.equal(await f.bridge.take('c2', 'Ana'), undefined);
  const { done } = (await recovery) as { done: { action: string }[] };
  assert.equal(seen, 'claimed');
  assert.ok(done.every((d) => !/released|rolled back/.test(d.action)), JSON.stringify(done));
  const [r] = records(f.dir);
  assert.equal(r.state, 'seated');
  assert.equal(f.op.leases.get('c2'), r.lease?.token, 'the lease is still held');
  // And a poll right after holds the run once, not twice.
  await f.bridge.poll();
  assert.equal(f.bridge.view().runs.filter((x) => x.cardId === 'c2' && x.state !== 'gone').length, 1);
});

test('a lease Opora could not release (it did not answer) keeps the run claimed until a later poll releases it', async (t) => {
  const f = await setup(t, { adapters: 'fake', workersFile: true });
  f.bridge.shutdown();
  await crash('claimed', f.dir, f.op.url);
  const tries: string[] = [];
  const deps = (answer: 'released' | 'unreachable') => ({ workers: () => [], held: new Set<string>(), release: async (_p: unknown, _c: string, token: string) => { tries.push(token); return answer; } });
  await recoverRuns(f.dir, f.dir, deps('unreachable'));
  assert.equal(records(f.dir)[0].state, 'claimed');
  assert.match(records(f.dir)[0].error!.reason, /did not answer/);
  assert.equal(snapshots(f.dir).length, 1, 'nothing is rolled back while the lease may still be held');
  await recoverRuns(f.dir, f.dir, deps('released'));
  assert.equal(records(f.dir)[0].state, 'rolledBack');
  assert.equal(tries.length, 2);
});

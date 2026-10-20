// The run snapshot (H09): element IDs, revisions and digests pinned per run, a deterministic digest,
// write-once persistence, lazy reads that never hand out the library's new content, secret redaction,
// size limits and the fail-closed paths (docs/harness.md "Run snapshot and lazy reads").
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, utimes, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { HarnessLibrary, harnessSources } from '../src/server/harness/catalog.js';
import { HarnessRegistry } from '../src/server/harness/registry.js';
import { HarnessProfiles } from '../src/server/harness/profiles.js';
import { resolveHandoff, type ResolvedHandoff } from '../src/server/harness/handoff.js';
import { HARNESS_GUIDES } from '../src/server/harness/guides.js';
import { buildSnapshot, canonicalJson, loadSnapshot, persistSnapshot, pruneSnapshots, readFromSnapshot, snapshotDigest, snapshotDir, SNAPSHOT_LIMITS, type StoredSnapshot } from '../src/server/harness/snapshot.js';
import { harnessCardRun, runContract } from '../src/server/harness/run.js';
import { snapshotRead } from '../src/server/harness/snapshot-api.js';
import { officeHarness } from '../src/server/harness/api.js';
import { redactSecrets } from '../src/server/harness/redact.js';
import { remoteHarness } from '../bin/harness-remote.js';
import type { HarnessText } from '../src/shared/harness.js';
import type { Ctx } from '../src/server/office/context.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const CARD = { project: 'p1', workspace: 'w1', nodeId: 'c1' };
const NODES = [{ id: 's1', kind: 'sector', name: 'Root', parentId: null }, { id: 'c1', kind: 'node', name: 'Card', parentId: 's1' }, { id: 'c2', kind: 'node', name: 'Other', parentId: 's1' }];

function text(id: string, category: HarnessText['category'], body: string, extra: Partial<HarnessText> = {}): HarnessText {
  return { id, title: id + '.md', category, group: 'g', source: 'Project / .harness', path: category + '/' + id + '.md', version: 1, digest: sha(body), aliases: [], text: body, ...extra };
}
function resolved(resources: { entry: HarnessText; slot: string }[], effective: ResolvedHandoff['profile']['effective'] = {}): ResolvedHandoff {
  const slots = { ...effective };
  for (const { entry, slot } of resources) slots[slot] = { binding: { resource: entry.id }, scope: 'project' };
  return { task: 'opora:p1:w1:c1', level: 'task', profile: { revision: 3, path: [{ level: 'task', node: 'opora:p1:w1:c1' }], layers: {} as never, effective: slots }, resources: resources.map(({ entry, slot }) => ({ entry, bound: [{ slot, scope: 'project' as const }] })) };
}

async function repo(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-harness-snapshot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const put = async (file: string, body: string) => { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), body); };
  const ids = async () => {
    const catalog = await new HarnessLibrary(harnessSources(dir, false), new HarnessRegistry(dir)).list();
    return Object.fromEntries(catalog.entries.map((e) => [e.path, e.id]));
  };
  return { dir, put, ids, profiles: new HarnessProfiles(dir) };
}

test('canonical JSON sorts keys at every depth, keeps array order and drops undefined members', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined }, 'é': 'ü' }), '{"a":{"d":[3,{"x":2,"y":1}]},"b":1,"é":"ü"}');
  assert.equal(canonicalJson({ z: 1, a: 2 }), canonicalJson({ a: 2, z: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]), 'array order is meaningful');
});

test('the snapshot digest is deterministic: same inputs twice, reordered inputs, and one changed byte', () => {
  const rules = text('el:project:aaaaaaaaaaaaaaaaaaaa', 'rules', 'Review every change.\n');
  const skill = text('el:project:bbbbbbbbbbbbbbbbbbbb', 'skills', 'A skill body.\n');
  const effective = { language: { binding: { value: 'cs' }, scope: 'global' as const }, tone: { binding: { value: 'terse' }, scope: 'project' as const } };
  const one = buildSnapshot({ card: CARD, binding: null, resolved: resolved([{ entry: rules, slot: 'rules.review' }, { entry: skill, slot: 'skills.main' }], effective), guides: HARNESS_GUIDES, runId: 'run-aaaaaaaa', createdAt: '2026-01-01T00:00:00.000Z' });
  const two = buildSnapshot({ card: CARD, binding: null, resolved: resolved([{ entry: rules, slot: 'rules.review' }, { entry: skill, slot: 'skills.main' }], effective), guides: HARNESS_GUIDES, runId: 'run-bbbbbbbb', createdAt: '2027-02-02T00:00:00.000Z' });
  assert.match(one.digest, /^[0-9a-f]{64}$/);
  assert.equal(one.digest, two.digest, 'run id and time are not part of the digest');
  const reordered = { tone: effective.tone, language: effective.language };
  const three = buildSnapshot({ card: CARD, binding: null, resolved: resolved([{ entry: skill, slot: 'skills.main' }, { entry: rules, slot: 'rules.review' }], reordered), guides: [...HARNESS_GUIDES].reverse() });
  assert.equal(three.digest, one.digest, 'resources, slots and guides in another order give the same digest');
  assert.equal(snapshotDigest(one), one.digest, 'the digest is the canonical JSON of the body');
  const changed = buildSnapshot({ card: CARD, binding: null, resolved: resolved([{ entry: text(rules.id, 'rules', 'Review every change!\n'), slot: 'rules.review' }, { entry: skill, slot: 'skills.main' }], effective), guides: HARNESS_GUIDES });
  assert.notEqual(changed.digest, one.digest, 'one changed byte of one text changes the digest');
  const otherCard = buildSnapshot({ card: { ...CARD, nodeId: 'c2' }, binding: null, resolved: resolved([{ entry: rules, slot: 'rules.review' }, { entry: skill, slot: 'skills.main' }], effective), guides: HARNESS_GUIDES });
  assert.notEqual(otherCard.digest, one.digest, 'the card is part of what is pinned');
  // Essential categories go into the prompt; the rest (and every handbook guide) is read by ID.
  assert.deepEqual(one.eager, [rules.id]);
  assert.ok(one.lazy.includes(skill.id) && one.lazy.includes('guide:testing'));
  const el = one.elements.find((e) => e.id === rules.id)!;
  assert.deepEqual({ ns: el.ns, category: el.category, version: el.version, digest: el.digest, scope: el.scope, origin: el.origin }, { ns: 'project', category: 'rules', version: 1, digest: rules.digest, scope: 'project', origin: { source: 'Project / .harness', path: 'rules/' + rules.id + '.md', bound: [{ slot: 'rules.review', scope: 'project' }] } });
  assert.equal(one.schema, 'harness.snapshot/1');
});

test('each secret pattern is redacted and only its kind is recorded, never the value', () => {
  const secrets = {
    'private-key': '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\n-----END RSA PRIVATE KEY-----',
    'aws-access-key': 'aws id AKIAIOSFODNN7EXAMPLE here',
    'github-token': 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 there',
    'api-key': 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
    'bearer-token': 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    'credential-assignment': 'password=hunter2hunter2',
  } as const;
  for (const [kind, sample] of Object.entries(secrets)) {
    const { text: out, found } = redactSecrets(sample);
    assert.ok(found[kind] >= 1, kind + ' found in ' + JSON.stringify(found));
    assert.match(out, new RegExp('\\[redacted:' + kind + '\\]'));
  }
  assert.equal(redactSecrets('GITHUB_TOKEN: "abcdefgh12345678"').text, 'GITHUB_TOKEN: "[redacted:credential-assignment]"');
  assert.equal(redactSecrets('token=<your-token>').text, 'token=<your-token>', 'a placeholder is not a secret');
  assert.equal(redactSecrets('token: string').text, 'token: string', 'a short type annotation is not a secret');
  assert.equal(redactSecrets('-----BEGIN PRIVATE KEY-----\nabc').text, '[redacted:private-key]', 'a key cut short still goes');
  const leaky = text('el:project:cccccccccccccccccccc', 'instructions', 'Use ' + secrets['github-token'] + ' and ' + secrets['aws-access-key'] + '.\n');
  const snap = buildSnapshot({ card: CARD, binding: null, resolved: resolved([{ entry: leaky, slot: 'instructions.start' }], { apiKey: { binding: { value: 'api_key=sk-live-0123456789abcdefghij' }, scope: 'project' } }) });
  const json = JSON.stringify(snap);
  assert.doesNotMatch(json, /ghp_abcdef|AKIAIOSFODNN7EXAMPLE|sk-live-0123/, 'no value survives anywhere in the snapshot');
  assert.deepEqual(snap.redactions.map((r) => [r.element, r.kind, r.count]), [[leaky.id, 'aws-access-key', 1], [leaky.id, 'github-token', 1], ['slots', 'api-key', 1]], 'the sk- key inside the assignment is caught first');
  const el = snap.elements[0];
  assert.equal(el.redacted, true);
  assert.equal(el.digest, leaky.digest, 'the digest still names the source bytes that were read');
  assert.equal(el.textDigest, sha(snap.content[el.id]), 'the text digest names what the snapshot holds');
  assert.match(runContract(snap), /Redacted: aws-access-key ×1/);
});

test('fail closed: credential-like name, digest mismatch, over a size limit, too many resources', () => {
  const build = (entries: HarnessText[]) => buildSnapshot({ card: CARD, binding: null, resolved: resolved(entries.map((entry, i) => ({ entry, slot: 's' + i }))) });
  assert.throws(() => build([text('el:project:dddddddddddddddddddd', 'rules', 'x', { path: 'rules/.env.md' })]), /credential-like file name/);
  assert.throws(() => build([text('el:project:dddddddddddddddddddd', 'rules', 'x', { digest: sha('y') })]), /does not match the digest it was read with/);
  assert.throws(() => build([text('el:project:dddddddddddddddddddd', 'skills', 'x'.repeat(SNAPSHOT_LIMITS.elementBytes + 1))]), /exceeds 128 KiB/);
  const big = (i: number, category: HarnessText['category']) => text('el:project:' + String(i).padStart(20, '0'), category, String(i).repeat(60 * 1024));
  assert.throws(() => build([big(1, 'rules'), big(2, 'instructions')]), /essential harness instructions exceed 96 KiB/);
  assert.doesNotThrow(() => build([big(1, 'rules'), big(2, 'skills')]), 'the same sizes pass when one is read by ID');
  assert.throws(() => build(Array.from({ length: 18 }, (_, i) => big(i + 1, 'skills'))), /run snapshot exceeds 1 MiB/);
  assert.throws(() => build(Array.from({ length: 25 }, (_, i) => text('el:project:' + String(i).padStart(20, '0'), 'skills', 'x' + i))), /exceeds 24 resources/);
});

test('a snapshot is written once, never overwritten, refused when altered, and old ones are pruned', async (t) => {
  const { dir } = await repo(t);
  const snap = buildSnapshot({ card: CARD, binding: null, resolved: resolved([{ entry: text('el:project:eeeeeeeeeeeeeeeeeeee', 'rules', 'Rule.\n'), slot: 'rules.a' }]), runId: 'run-11111111' });
  const file = persistSnapshot(dir, snap);
  assert.equal(file, path.join(snapshotDir(dir), 'run-11111111.json'));
  assert.deepEqual(loadSnapshot(dir, 'run-11111111'), JSON.parse(await readFile(file, 'utf8')));
  assert.throws(() => persistSnapshot(dir, { ...snap, content: { ...snap.content, x: 'other' } }), /already exists and is never overwritten/);
  assert.equal(loadSnapshot(dir, 'run-11111111').digest, snap.digest, 'the refused write changed nothing');
  assert.deepEqual((await readdir(snapshotDir(dir))).sort(), ['run-11111111.json'], 'no temporary file is left behind');
  assert.throws(() => loadSnapshot(dir, 'run-22222222'), /unavailable \(not found\)/);
  assert.throws(() => loadSnapshot(dir, '../escape-attempt'), /Invalid run id/);
  // An edited file (content or manifest) is refused, not served.
  const stored = JSON.parse(await readFile(file, 'utf8')) as StoredSnapshot;
  await writeFile(path.join(snapshotDir(dir), 'run-33333333.json'), JSON.stringify({ ...stored, runId: 'run-33333333', content: { [stored.elements[0].id]: 'Edited.\n' } }));
  assert.throws(() => loadSnapshot(dir, 'run-33333333'), /does not match its digest/);
  await writeFile(path.join(snapshotDir(dir), 'run-44444444.json'), JSON.stringify({ ...stored, runId: 'run-44444444', revision: 99 }));
  assert.throws(() => loadSnapshot(dir, 'run-44444444'), /does not match its digest/);
  // Retention: older than the age bound goes; the run just written always stays.
  const old = path.join(snapshotDir(dir), 'run-44444444.json');
  const past = new Date(Date.now() - (SNAPSHOT_LIMITS.maxAgeDays + 1) * 24 * 3600 * 1000);
  await utimes(old, past, past);
  pruneSnapshots(dir, 'run-11111111');
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(file), true);
  assert.equal(existsSync(path.join(snapshotDir(dir), 'run-33333333.json')), true, 'a recent snapshot stays');
});

test('a run pins exactly the bound versions: global, element and registry changes mid-run never reach it', async (t) => {
  const { dir, put, ids, profiles } = await repo(t);
  await put('.harness/rules/review.md', 'Review rule v1.\n');
  await put('.harness/skills/deploy/SKILL.md', 'Deploy skill v1.\n');
  const id = await ids();
  const rules = id['rules/review.md'], skill = id['skills/deploy/SKILL.md'];
  await profiles.save(dir, '', 'global', { 'settings.language': { value: 'en' } }, 0);
  await profiles.save(dir, '', 'repository', { 'rules.review': { resource: rules }, 'skills.deploy': { resource: skill } }, 1);
  const run = await harnessCardRun(dir, dir, { project: 'p1', workspace: 'w1' }, 'c1', NODES, false);
  assert.match(run.context, new RegExp('Run: ' + run.snapshot.runId));
  assert.match(run.context, new RegExp('Snapshot SHA-256: ' + run.snapshot.digest));
  assert.match(run.context, /Review rule v1\./, 'the rule is essential: embedded');
  assert.doesNotMatch(run.context, /Deploy skill v1\./, 'the skill is read by ID, not embedded');
  assert.match(run.context, new RegExp(skill + ' · skills · deploy / SKILL.md · revision 1'));
  assert.match(run.context, /office-harness --read <id>/);
  const before = loadSnapshot(dir, run.snapshot.runId);
  assert.deepEqual(before.card, { project: 'p1', workspace: 'w1', nodeId: 'c1' });
  // Mid-run: global edited, both element files edited, the registry bumped by a listing.
  await profiles.save(dir, '', 'global', { 'settings.language': { value: 'de' }, extra: { value: 'later' } }, 2);
  await put('.harness/rules/review.md', 'Review rule v2.\n');
  await put('.harness/skills/deploy/SKILL.md', 'Deploy skill v2.\n');
  const relisted = await new HarnessLibrary(harnessSources(dir, false), new HarnessRegistry(dir)).list();
  assert.equal(relisted.entries.find((e) => e.id === skill)!.version, 2, 'the registry moved on');
  const after = loadSnapshot(dir, run.snapshot.runId);
  assert.deepEqual(after, before, 'the snapshot on disk is unchanged');
  const own = run.snapshot;
  const read = await snapshotRead(dir, dir, own, skill, '');
  assert.equal(read.text, 'Deploy skill v1.\n', 'a lazy read hands out the snapshot text, never the new file');
  assert.equal(read.status, 'changed');
  assert.match(read.note, /Changed since snapshot: the library now holds revision 2/);
  assert.equal(read.version, 1);
  await unlink(path.join(dir, '.harness/skills/deploy/SKILL.md'));
  const gone = await snapshotRead(dir, dir, own, skill, own.runId);
  assert.equal(gone.status, 'unavailable');
  assert.equal(gone.text, 'Deploy skill v1.\n');
  // The next run sees the new state; this one still does not.
  const next = await harnessCardRun(dir, dir, { project: 'p1', workspace: 'w1' }, 'c2', NODES, false).catch((err: Error) => err);
  assert.ok(next instanceof Error && /unavailable/.test(next.message), 'the next run fails closed on the deleted (tombstoned) skill');
  assert.equal((await snapshotRead(dir, dir, own, rules, '')).text, 'Review rule v1.\n');
});

test('lazy reads are confined to the worker\'s own run: another run, a foreign element, no run', async (t) => {
  const { dir, put, ids, profiles } = await repo(t);
  await put('.harness/skills/a/SKILL.md', 'Skill A.\n');
  await put('.harness/skills/b/SKILL.md', 'Skill B.\n');
  const id = await ids();
  await profiles.save(dir, [{ level: 'task', node: 'opora:p1:w1:c1' }], 'task', { s: { resource: id['skills/a/SKILL.md'] } }, 0);
  await profiles.save(dir, [{ level: 'task', node: 'opora:p1:w1:c2' }], 'task', { s: { resource: id['skills/b/SKILL.md'] } }, 1);
  const a = await harnessCardRun(dir, dir, { project: 'p1', workspace: 'w1' }, 'c1', NODES, false);
  const b = await harnessCardRun(dir, dir, { project: 'p1', workspace: 'w1' }, 'c2', NODES, false);
  assert.notEqual(a.snapshot.digest, b.snapshot.digest);
  await assert.rejects(snapshotRead(dir, dir, a.snapshot, id['skills/b/SKILL.md'], b.snapshot.runId), (err: Error & { status?: number }) => err.status === 403 && /not this worker's run/.test(err.message));
  await assert.rejects(snapshotRead(dir, dir, a.snapshot, id['skills/b/SKILL.md'], ''), (err: Error & { status?: number }) => err.status === 404 && /not in this run's snapshot/.test(err.message));
  await assert.rejects(snapshotRead(dir, dir, undefined, id['skills/a/SKILL.md'], ''), /no run snapshot/);
  await assert.rejects(snapshotRead(dir, dir, { ...a.snapshot, digest: b.snapshot.digest }, id['skills/a/SKILL.md'], ''), /does not match the digest recorded/);
  assert.equal((await snapshotRead(dir, dir, a.snapshot, 'guide:testing', '')).status, 'unchanged', 'the handbook guides are offered by ID');

  // Over HTTP with the worker's hook token: the run is the one the floor's bridge seated the worker with.
  const runs: Record<string, { runId: string; digest: string }> = { 'worker-a': a.snapshot, 'worker-b': b.snapshot };
  const floor = { id: 'f', dir, opora: { snapshotOf: (w: string) => runs[w] }, workers: { authenticate: (w: string, token: string) => token === 'tok-' + w ? { id: w } : undefined }, planning: { state: () => ({ current: undefined }) } };
  const ctx = { cfg: { dataDir: dir }, workerFloor: () => floor, accounts: { get: () => undefined } } as unknown as Ctx;
  const server = http.createServer((req, res) => void officeHarness(ctx, req, res, new URL(req.url!, 'http://x')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.close(); server.closeAllConnections(); });
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const get = (worker: string, token: string, query: string) => fetch(`${base}/office/harness?worker=${worker}&${query}`, { headers: { authorization: 'Bearer ' + token } });
  const ok = await get('worker-a', 'tok-worker-a', 'read=' + encodeURIComponent(id['skills/a/SKILL.md']));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).text, 'Skill A.\n');
  assert.equal((await get('worker-a', 'tok-worker-b', 'read=x')).status, 401, 'a forged token reads nothing');
  assert.equal((await get('worker-a', 'tok-worker-a', `read=${encodeURIComponent(id['skills/b/SKILL.md'])}&run=${b.snapshot.runId}`)).status, 403);
  assert.equal((await get('worker-b', 'tok-worker-b', 'read=' + encodeURIComponent(id['skills/a/SKILL.md']))).status, 404);
  assert.equal((await get('worker-c', 'tok-worker-c', 'read=guide:testing')).status, 404, 'a worker without a run has no snapshot to read');

  // The CLI inside a worker prints the snapshot's text with its revision, digest, run and status.
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  Object.assign(process.env, { AGENT_OFFICE_HOOK_URL: base, AGENT_OFFICE_WORKER_ID: 'worker-a', AGENT_OFFICE_HOOK_TOKEN: 'tok-worker-a' });
  const lines: string[] = [];
  const log = console.log;
  console.log = (s: string) => void lines.push(s);
  try { await remoteHarness(['--read', id['skills/a/SKILL.md'], '--run', a.snapshot.runId]); } finally { console.log = log; }
  assert.match(lines[0], new RegExp(`Element: ${id['skills/a/SKILL.md']} · revision \\d+ · sha256:[0-9a-f]{64} · run ${a.snapshot.runId}`));
  assert.match(lines[0], /Status: unchanged\.[\s\S]*Skill A\.\n$/);
  await assert.rejects(remoteHarness(['--read', id['skills/b/SKILL.md'], '--run', b.snapshot.runId]), /not this worker's run/);
  await assert.rejects(remoteHarness(['--effective', '--run', a.snapshot.runId]), /--run goes with --read/);
});

test('reading a snapshot element the run does not hold is refused with the ids it does hold', () => {
  const snap = buildSnapshot({ card: CARD, binding: null, resolved: resolved([{ entry: text('el:project:ffffffffffffffffffff', 'skills', 'S.\n'), slot: 's' }]) });
  assert.throws(() => readFromSnapshot(snap, 'el:project:00000000000000000000'), /not in this run's snapshot .* el:project:ffffffffffffffffffff/);
  assert.equal(readFromSnapshot(snap, 'el:project:ffffffffffffffffffff', { version: 1, digest: sha('S.\n') }).status, 'unchanged');
});

test('resolveHandoff fails closed on a tombstoned element before anything is built', async (t) => {
  const { dir, put, ids, profiles } = await repo(t);
  await put('.harness/rules/gone.md', 'Soon gone.\n');
  const id = (await ids())['rules/gone.md'];
  await profiles.save(dir, '', 'repository', { 'rules.gone': { resource: id } }, 0);
  await unlink(path.join(dir, '.harness/rules/gone.md'));
  await ids();
  assert.equal(new HarnessLibrary(harnessSources(dir, false), new HarnessRegistry(dir)).resolve(id).status, 'missing', 'the registry keeps its tombstone');
  await assert.rejects(resolveHandoff(dir, dir, [{ level: 'task', node: 'opora:p1:w1:c1' }], false), /unavailable for this worker/);
  await assert.rejects(harnessCardRun(dir, dir, { project: 'p1', workspace: 'w1' }, 'c1', NODES, false), /unavailable for this worker/);
  assert.equal(existsSync(snapshotDir(dir)), false, 'no snapshot is written for a run that failed closed');
});

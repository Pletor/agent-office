// The element registry's safety properties (H03 round 2 after the independent review): lock takeover and
// release under injected interleavings, lease renewal of a long-held lock and fencing of a writer whose
// lock was claimed, pruning that never mistakes an inaccessible checkout for a deleted one, a digest cache
// that is verified against the registry and kept under its byte cap, the OpenViking global rule, a denied
// file on a warm cache, and the revision history's eviction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, utimes, realpath, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { HarnessLibrary, harnessSources } from '../src/server/harness/catalog.js';
import { HarnessRegistry, MAX_VERSIONS, rootGone } from '../src/server/harness/registry.js';
import { acquireLock, claimStale } from '../src/server/harness/registry-lock.js';
import { DigestCache } from '../src/server/harness/digests.js';
import { HarnessProfiles } from '../src/server/harness/profiles.js';
import { harnessHandoff, assertBindable } from '../src/server/harness/handoff.js';

const win = process.platform === 'win32';
const asRoot = !win && process.getuid?.() === 0;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-harness-safety-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const at = (file: string) => path.join(dir, file);
  const put = async (file: string, text: string | Buffer) => {
    await mkdir(path.dirname(at(file)), { recursive: true });
    await writeFile(at(file), text);
  };
  return { dir, at, put, data: at('data'), registry: at('data/harness-registry.json'), lock: at('data/harness-registry.json.lock') };
}
const lib = (project: string, data: string, extra: Parameters<typeof HarnessLibrary>[0] = []) => new HarnessLibrary([...harnessSources(project, false), ...extra], new HarnessRegistry(data));
/**
 * Replace one fs function for the duration of `fn`; the lock and registry modules import the named
 * functions from node:fs, so the live bindings follow the replacement. This is how an interleaving
 * with another process is injected deterministically: the other party acts inside the call.
 */
async function stubbed<K extends 'renameSync' | 'statSync'>(name: K, make: (original: (typeof fs)[K]) => (typeof fs)[K], fn: () => Promise<void>) {
  const original = fs[name];
  fs[name] = make(original);
  syncBuiltinESMExports();
  try { await fn(); } finally { fs[name] = original; syncBuiltinESMExports(); }
}
const timing = { staleMs: 200, tries: 6, waitMs: 20 };
const leftovers = async (data: string) => (await readdir(data)).filter((f) => f.includes('.lock.'));

test('stale takeover vs a fresh lock: a lock replaced between the observation and the rename is put back, never deleted, and the contender does not acquire', async (t) => {
  const { put, data, lock } = await fixture(t);
  await put('data/harness-registry.json.lock', 'dead-owner 0');
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  let swapped = false;
  await stubbed('renameSync', (original) => ((from, to) => {
    if (String(from) === lock && !swapped) { swapped = true; fs.unlinkSync(lock); fs.writeFileSync(lock, 'fresh-owner ' + Date.now()); }
    return original(from, to);
  }) as typeof fs.renameSync, async () => {
    const held = await acquireLock(lock, timing);
    assert.equal(held, undefined, 'the fresh lock is young: never claimed');
  });
  assert.ok(swapped, 'the interleaving was injected');
  assert.match(await readFile(lock, 'utf8'), /^fresh-owner /, 'the fresh lock is back in place');
  assert.deepEqual(await leftovers(data), [], 'no claimed file left behind');
});

test('a stale lock whose owner is dead is claimed exactly once, by its observed identity', async (t) => {
  const { put, data, lock } = await fixture(t);
  await put('data/harness-registry.json.lock', 'dead-owner ' + (Date.now() - 60_000));
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  assert.equal(claimStale(lock, 'contender-a', 200), true);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(claimStale(lock, 'contender-b', 200), false, 'nothing to claim');
  const held = await acquireLock(lock, timing);
  assert.ok(held);
  assert.match(await readFile(lock, 'utf8'), /^[0-9a-f-]{36} \d+$/, 'owner token and lease timestamp');
  held.release();
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(await leftovers(data), []);
});

test('release vs a replacement: a lock that was replaced after the owner checked it is put back, never deleted', async (t) => {
  const { put, data, lock } = await fixture(t);
  await put('data/.keep', '');
  const held = await acquireLock(lock, timing);
  assert.ok(held);
  let swapped = false;
  await stubbed('renameSync', (original) => ((from, to) => {
    if (String(from) === lock && !swapped) { swapped = true; fs.unlinkSync(lock); fs.writeFileSync(lock, 'new-owner ' + Date.now()); }
    return original(from, to);
  }) as typeof fs.renameSync, async () => { held.release(); });
  assert.ok(swapped);
  assert.match(await readFile(lock, 'utf8'), /^new-owner /, 'the replacement lock survives the release');
  assert.deepEqual(await leftovers(data), []);
});

test('a lock held longer than the stale threshold is renewed while its owner lives, and a writer whose lock was claimed does not commit', async (t) => {
  const { at, put, data, lock } = await fixture(t);
  await put('data/.keep', '');
  // The lease is renewed every staleMs / 4, so a generous threshold keeps this independent of a busy test runner.
  const held = await acquireLock(lock, { staleMs: 1200, tries: 3, waitMs: 20 });
  assert.ok(held);
  await delay(2600);
  const contender = await acquireLock(lock, { staleMs: 1200, tries: 3, waitMs: 20 });
  assert.equal(contender, undefined, 'the lease was renewed: the live owner is never taken over');
  assert.ok(held.valid());
  held.release();
  assert.equal(fs.existsSync(lock), false);
  // A writer that stops renewing (a stalled process) loses its lock to a contender and must not commit afterwards.
  const stalled = await acquireLock(lock, { staleMs: 10_000, tries: 3, waitMs: 20 });
  assert.ok(stalled);
  const dead = new Date(Date.now() - 60_000);
  fs.writeFileSync(lock, fs.readFileSync(lock, 'utf8').split(' ')[0] + ' ' + (Date.now() - 60_000));
  await utimes(lock, dead, dead);
  const taker = await acquireLock(lock, { staleMs: 10_000, tries: 3, waitMs: 20 });
  assert.ok(taker, 'a lock whose lease ran out is claimed');
  assert.equal(stalled.valid(), false, 'fencing: the stalled writer sees its lock is gone');
  stalled.release();
  assert.ok(taker.valid(), 'the stalled writer\'s release left the taker\'s lock alone');
  taker.release();
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(await leftovers(data), []);
  // The registry itself: a listing whose lock was claimed meanwhile is not recorded.
  await put('p/.harness/rules/x.md', 'x');
  const registry = new HarnessRegistry(data, { staleMs: 10_000, tries: 3, waitMs: 20 });
  const library = new HarnessLibrary(harnessSources(at('p'), false), registry);
  await stubbed('statSync', (original) => ((file, ...rest) => {
    // The first stat of the registry's own lock during the update comes from valid(): the lock has been claimed by then.
    if (String(file) === lock && fs.existsSync(lock) && !fs.readFileSync(lock, 'utf8').startsWith('taker ')) { fs.unlinkSync(lock); fs.writeFileSync(lock, 'taker ' + Date.now()); }
    return (original as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.statSync, async () => {
    const warn = t.mock.method(console, 'warn', () => {});
    try {
      const listed = await library.list();
      assert.equal(listed.entries.find((e) => e.path === 'rules/x.md')!.version, 0, 'the revision of this listing was not persisted');
      assert.ok(warn.mock.calls.some((c) => /taken over/.test(String(c.arguments[0]))));
    } finally { warn.mock.restore(); }
  });
  assert.equal(fs.existsSync(path.join(data, 'harness-registry.json')), false, 'nothing was written');
  assert.match(await readFile(lock, 'utf8'), /^taker /, 'the taker\'s lock was not released by the fenced writer');
});

test('pruning: an EACCES on an existing checkout keeps its records; an unreachable volume root or ancestor keeps them too', async (t) => {
  const { at, put, data, registry } = await fixture(t);
  await put('p/.harness/rules/live.md', 'live');
  const library = lib(at('p'), data);
  const live = (await library.list()).entries.find((e) => e.path === 'rules/live.md')!;
  const real = await realpath(at('p'));
  const denied = (file: fs.PathLike) => Object.assign(new Error('EACCES: permission denied, stat ' + String(file)), { code: 'EACCES' });
  const stat = (original: typeof fs.statSync, fails: (file: string) => boolean) => ((file: fs.PathLike, ...rest: unknown[]) => {
    if (fails(String(file))) throw denied(file);
    return (original as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.statSync;
  await stubbed('statSync', (original) => stat(original, (f) => f === real), async () => {
    for (let i = 0; i < 3; i++) await new HarnessRegistry(data).observe([], new Set());
    assert.equal(rootGone(real), false);
  });
  let stored = JSON.parse(await readFile(registry, 'utf8')) as { elements: Record<string, unknown>; rootsMissing: Record<string, string> };
  assert.ok(stored.elements[live.id], 'a checkout that cannot be checked is kept');
  assert.deepEqual(stored.rootsMissing, {}, 'and not even recorded as a sighting');
  // Gone with ENOENT, but the volume root (a mapped network drive that is offline) or a folder above it cannot be reached: kept.
  const ghost = path.join(path.dirname(real), 'no-such-checkout-' + Date.now());
  await stubbed('statSync', (original) => stat(original, (f) => f === path.parse(ghost).root), async () => { assert.equal(rootGone(ghost), false); });
  await stubbed('statSync', (original) => stat(original, (f) => f === path.dirname(ghost)), async () => { assert.equal(rootGone(ghost), false); });
  assert.equal(rootGone(ghost), true, 'really gone with a reachable parent: a deleted checkout');
  assert.equal(rootGone('\\\\server\\share\\checkout'), false, 'a UNC path is never checked');
  // Two consecutive saves finding it gone prune; one does not (the sighting is cleared when the folder is back).
  await rm(at('p'), { recursive: true, force: true });
  await new HarnessRegistry(data).observe([], new Set());
  stored = JSON.parse(await readFile(registry, 'utf8'));
  assert.ok(stored.elements[live.id], 'one sighting does not prune');
  assert.ok(Object.keys(stored.rootsMissing).length > 0);
  await put('p/.harness/rules/live.md', 'live');
  await new HarnessRegistry(data).observe([], new Set());
  stored = JSON.parse(await readFile(registry, 'utf8'));
  assert.deepEqual(stored.rootsMissing, {}, 'the folder came back: the sighting is cleared');
  await rm(at('p'), { recursive: true, force: true });
  for (let i = 0; i < 2; i++) await new HarnessRegistry(data).observe([], new Set());
  stored = JSON.parse(await readFile(registry, 'utf8'));
  assert.equal(stored.elements[live.id], undefined, 'pruned by the second consecutive save');
});

test('a cache entry the registry has never seen is re-hashed and never persisted; the cache writer keeps the file under the loader\'s byte cap', async (t) => {
  const { at, put, data } = await fixture(t);
  const file = at('p/.harness/rules/x.md');
  await put('p/.harness/rules/x.md', 'real bytes');
  const s = fs.lstatSync(file, { bigint: true });
  const fake = 'a'.repeat(64);
  await put('data/harness-digests.json', JSON.stringify({ schema: 1, files: { [file]: [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':') + ' ' + fake } }));
  const library = lib(at('p'), data);
  const x = (await library.list()).entries.find((e) => e.path === 'rules/x.md')!;
  assert.equal(x.digest, sha('real bytes'), 'the invented digest was not trusted');
  const stored = JSON.parse(await readFile(path.join(data, 'harness-registry.json'), 'utf8')) as { elements: Record<string, { versions: Record<string, number> }> };
  assert.deepEqual(stored.elements[x.id].versions, { [sha('real bytes')]: 1 });
  const cache = JSON.parse(await readFile(path.join(data, 'harness-digests.json'), 'utf8')) as { files: Record<string, string> };
  assert.equal(cache.files[file].split(' ')[1], sha('real bytes'), 'the cache entry was replaced by the verified digest');
  // 4,000 long paths would serialize past 2 MiB; the writer evicts the least recently used until a fresh loader accepts the file.
  const big = at('big-digests.json'), name = (i: number) => 'C:/' + 'x'.repeat(500) + '/' + i + '.md';
  const writer = DigestCache.at(big);
  for (let i = 0; i < 4000; i++) writer.set(name(i), '1:2:3:4:5', fake);
  writer.flush();
  assert.ok(fs.statSync(big).size <= 2 * 1024 * 1024, 'under the cap: ' + fs.statSync(big).size);
  const cold = new (DigestCache as unknown as new (file: string) => DigestCache)(big);
  assert.equal(cold.get(name(3999), '1:2:3:4:5'), fake, 'the most recent entries survived and a fresh process loads them');
  assert.equal(cold.get(name(0), '1:2:3:4:5'), undefined, 'the oldest were evicted');
});

test('OpenViking may be bound globally only when AGENT_OFFICE_OPENVIKING_DIR pins it; a per-project discovery is refused with the reason, in the save and in the handoff', async (t) => {
  const { at, put, data } = await fixture(t);
  await put('a/OpenViking/agent-plugins/README.md', 'Viking A');
  await put('b/OpenViking/agent-plugins/README.md', 'Viking B');
  const viking = (project: string, env: NodeJS.ProcessEnv) => new HarnessLibrary(harnessSources(project, true, env).filter((s) => s.ns === 'openviking'), new HarnessRegistry(data));
  const la = viking(at('a'), {}), lb = viking(at('b'), {});
  const readme = (e: { source: string; path: string }) => e.source === 'OpenViking / agent-plugins' && e.path === 'README.md';
  const ea = (await la.list()).entries.find(readme)!, eb = (await lb.list()).entries.find(readme)!;
  assert.equal(ea.id, eb.id, 'the same ID in both projects');
  assert.notEqual((await la.read(ea.id))?.text, (await lb.read(eb.id))?.text, 'for different files');
  assert.throws(() => assertBindable(la, 'global', ea.id), /OpenViking element in global layer: el:openviking:.*AGENT_OFFICE_OPENVIKING_DIR is not set.*repository or task scope/);
  assert.doesNotThrow(() => assertBindable(la, 'repository', ea.id));
  const pinned = viking(at('b'), { AGENT_OFFICE_OPENVIKING_DIR: at('a/OpenViking') });
  const ep = (await pinned.list()).entries.find(readme)!;
  assert.equal(ep.id, ea.id);
  assert.doesNotThrow(() => assertBindable(pinned, 'global', ep.id), 'pinned installation-wide: the same file in every project');
  assert.equal((await pinned.read(ep.id))?.text, 'Viking A');
  // The handoff applies the same rule to a global binding already in the store.
  const profiles = new HarnessProfiles(data);
  profiles.save(at('a'), '', 'global', { 'memory.recall': { resource: ea.id } }, 0);
  const env = process.env.AGENT_OFFICE_OPENVIKING_DIR;
  t.after(async () => { if (env === undefined) delete process.env.AGENT_OFFICE_OPENVIKING_DIR; else process.env.AGENT_OFFICE_OPENVIKING_DIR = env; });
  delete process.env.AGENT_OFFICE_OPENVIKING_DIR;
  await assert.rejects(harnessHandoff(data, at('b'), '', true), /unavailable for this worker: OpenViking element in global layer/);
  process.env.AGENT_OFFICE_OPENVIKING_DIR = at('a/OpenViking');
  assert.match(await harnessHandoff(data, at('b'), '', true), /Viking A/, 'pinned: the handoff embeds the one installation-wide file');
});

test('a file that becomes unreadable without changing is dropped from the listing on a warm cache too, and its source is incomplete', async (t) => {
  const { at, put, data } = await fixture(t);
  if (asRoot) return t.skip('permissions do not bind root');
  await put('p/.harness/rules/x.md', 'x');
  await put('p/.harness/rules/y.md', 'y');
  const library = lib(at('p'), data);
  const first = await library.list();
  const x = first.entries.find((e) => e.path === 'rules/x.md')!, y = first.entries.find((e) => e.path === 'rules/y.md')!;
  const file = at('p/.harness/rules/y.md');
  const user = process.env.USERNAME ?? '';
  const deny = () => win ? execFileSync('icacls', [file, '/deny', user + ':(RD)'], { stdio: 'pipe' }) : chmod(file, 0o000);
  const allow = () => win ? execFileSync('icacls', [file, '/remove:d', user], { stdio: 'pipe' }) : chmod(file, 0o644);
  try { await deny(); } catch (err) { return t.skip('cannot deny reading here: ' + (err as Error).message); }
  try {
    await assert.rejects(readFile(file), 'the read really is denied');
    await rm(at('p/.harness/rules/x.md'));
    const listed = await library.list();
    assert.equal(listed.entries.some((e) => e.id === y.id), false, 'not listed while unreadable, cached digest or not');
    const gone = library.resolve(x.id);
    assert.ok(gone.status === 'missing' && gone.missingSince === '', 'the deleted neighbour is not tombstoned: the source was not completely listed');
    assert.equal(await library.read(y.id), undefined);
  } finally { await allow(); }
  const back = (await library.list()).entries.find((e) => e.id === y.id)!;
  assert.equal(back.version, 1);
  assert.equal(back.digest, y.digest);
});

test(`the revision history keeps ${MAX_VERSIONS} digests: content evicted from it gets a new, higher number when it returns`, async (t) => {
  const { data } = await fixture(t);
  const registry = new HarnessRegistry(data);
  const seen = (i: number) => ({ id: 'el:project:' + '1'.repeat(20), ns: 'project', key: '.harness/rules/x.md', root: 'a'.repeat(16), title: 'x.md', path: 'rules/x.md', source: 'Project / .harness', category: 'rules' as const, digest: sha('v' + i) });
  for (let i = 1; i <= MAX_VERSIONS; i++) assert.equal((await registry.observe([seen(i)], new Set())).get(seen(i).id), i);
  assert.equal((await registry.observe([seen(1)], new Set())).get(seen(1).id), 1, 'within the history: the number it had');
  assert.equal((await registry.observe([seen(MAX_VERSIONS + 1)], new Set())).get(seen(1).id), MAX_VERSIONS + 1);
  assert.equal((await registry.observe([seen(2)], new Set())).get(seen(2).id), 2, 'a digest kept in the history keeps its number');
  assert.equal((await registry.observe([seen(1)], new Set())).get(seen(1).id), MAX_VERSIONS + 2, 'the lowest-numbered digest was evicted: its content returns as new content');
});

test('lookup() follows another process\'s write between listings (one stat per lookup), and a re-hashed file is the most recently used cache entry', async (t) => {
  const { at, put, data } = await fixture(t);
  await put('p/.harness/rules/x.md', 'x');
  const reader = lib(at('p'), data);
  const x = (await reader.list()).entries.find((e) => e.path === 'rules/x.md')!;
  assert.equal(reader.registry!.lookup(x.id)?.missingSince, '');
  // Another process (here: a second library over the same data dir) sees the file gone and records the tombstone.
  await rm(at('p/.harness/rules/x.md'));
  await lib(at('p'), data).list();
  const known = reader.registry!.lookup(x.id);
  assert.ok(known?.missingSince, 'the reader sees the other writer\'s tombstone without listing again');
  const cache = DigestCache.at(at('lru.json'));
  for (let i = 0; i < 4000; i++) cache.set('f' + i, '1:2:3:4:5', 'a'.repeat(64));
  cache.set('f0', '1:2:3:4:6', 'b'.repeat(64)); // re-hashed: moves to the end instead of keeping its old, first-to-go position
  cache.set('extra', '1:2:3:4:5', 'c'.repeat(64));
  assert.equal(cache.get('f0', '1:2:3:4:6'), 'b'.repeat(64));
  assert.equal(cache.get('f1', '1:2:3:4:5'), undefined, 'the least recently used entry went instead');
});

test('a lock that cannot be renamed on release (a scanner holds it) is still removed once it is verified as ours; a transient EPERM on create is contention, not a refusal', async (t) => {
  const { put, data, lock } = await fixture(t);
  await put('data/.keep', '');
  const held = await acquireLock(lock, timing);
  assert.ok(held);
  await stubbed('renameSync', (original) => ((from, to) => {
    if (String(from) === lock) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return original(from, to);
  }) as typeof fs.renameSync, async () => { held.release(); });
  assert.equal(fs.existsSync(lock), false, 'not left behind to block the next writer');
  assert.deepEqual(await leftovers(data), []);
});

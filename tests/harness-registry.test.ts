// The element registry (H03): IDs that survive restarts and checkout moves, revisions that follow
// content, tombstones for elements that disappear, and compatibility with the IDs profiles saved before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, readFile, utimes, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { HarnessLibrary, harnessSources, sourceCategory, sourceGroup, elementId } from '../src/server/harness/catalog.js';
import { HarnessRegistry } from '../src/server/harness/registry.js';
import { HarnessProfiles } from '../src/server/harness/profiles.js';
import { harnessHandoff } from '../src/server/harness/handoff.js';
import { HARNESS_GUIDES } from '../src/server/harness/guides.js';
import { HARNESS_CATEGORIES, HARNESS_CATEGORY_PURPOSE, harnessBundle } from '../src/shared/harness.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-harness-registry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const at = (file: string) => path.join(dir, file);
  const put = async (file: string, text: string | Buffer) => {
    await mkdir(path.dirname(at(file)), { recursive: true });
    await writeFile(at(file), text);
  };
  return { dir, at, put, data: at('data') };
}
const legacy = (file: string) => createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 24);

test('the thirteen categories each state a purpose, and the handbook covers every one', () => {
  assert.deepEqual([...HARNESS_CATEGORIES], ['instructions', 'skills', 'hooks', 'rules', 'commands', 'scripts', 'tools', 'mcp', 'memory', 'plugins', 'permissions', 'testing', 'operations']);
  for (const c of HARNESS_CATEGORIES) assert.ok(HARNESS_CATEGORY_PURPOSE[c].length > 20, c);
  assert.deepEqual(HARNESS_GUIDES.map((g) => g.category), [...HARNESS_CATEGORIES]);
  assert.equal(sourceCategory('.harness/plugins/office/plugin.json'), 'plugins');
  assert.equal(sourceCategory('.harness/permission/allow.md'), 'permissions');
  assert.equal(sourceCategory('.harness/runbooks/release.md'), 'operations');
  assert.equal(sourceGroup('.harness/hooks/claude/after-tool.py', 'hooks', 'Project / .harness'), 'claude');
  assert.equal(sourceGroup('tooling/SKILL.md', 'skills', 'Machine / .claude/skills'), 'tooling');
  assert.equal(sourceGroup('AGENTS.md', 'instructions', 'Project instructions'), 'Project instructions');
});

test('an element keeps its ID across a restart and a checkout move, and never depends on the absolute path', async (t) => {
  const { at, put, data } = await fixture(t);
  await put('one/AGENTS.md', 'rules');
  await put('one/.harness/hooks/claude/after-tool.py', 'print(1)');
  const first = await new HarnessLibrary(harnessSources(at('one'), false), new HarnessRegistry(data)).list();
  const hook = first.entries.find((e) => e.path === 'hooks/claude/after-tool.py')!;
  assert.match(hook.id, /^el:project:[0-9a-f]{20}$/);
  assert.equal(hook.version, 1);
  // Restart: a fresh library and registry instance over the same data dir.
  const again = await new HarnessLibrary(harnessSources(at('one'), false), new HarnessRegistry(data)).list();
  assert.deepEqual(again.entries.map((e) => [e.id, e.version]), first.entries.map((e) => [e.id, e.version]));
  // Move: the checkout is renamed; IDs and revisions are unchanged, only the legacy alias differs.
  await rename(at('one'), at('two'));
  const moved = await new HarnessLibrary(harnessSources(at('two'), false), new HarnessRegistry(data)).list();
  const movedHook = moved.entries.find((e) => e.path === 'hooks/claude/after-tool.py')!;
  assert.equal(movedHook.id, hook.id);
  assert.equal(movedHook.version, 1);
  assert.notDeepEqual(movedHook.aliases, hook.aliases);
  assert.equal(elementId({ name: 'x', dir: '/a/b', ns: 'project', prefix: '.harness' }, 'hooks/x.py').id, elementId({ name: 'y', dir: '/c/d', ns: 'project', prefix: '.harness' }, 'hooks/x.py').id);
  assert.notEqual(elementId({ name: 'x', dir: '/a', ns: 'project', prefix: '.harness' }, 'hooks/x.py').id, elementId({ name: 'x', dir: '/a', ns: 'machine', prefix: '.harness' }, 'hooks/x.py').id);
});

test('the revision follows the content: a change bumps it, known content keeps its number, and reads report the digest', async (t) => {
  const { at, put, data } = await fixture(t);
  await put('p/.harness/rules/review.md', 'v1');
  const lib = new HarnessLibrary(harnessSources(at('p'), false), new HarnessRegistry(data));
  const v1 = (await lib.list()).entries.find((e) => e.path === 'rules/review.md')!;
  assert.equal(v1.version, 1);
  assert.equal((await lib.list()).entries.find((e) => e.id === v1.id)!.version, 1, 'an unchanged listing does not bump');
  await put('p/.harness/rules/review.md', 'v2 content');
  const v2 = (await lib.list()).entries.find((e) => e.id === v1.id)!;
  assert.equal(v2.version, 2);
  assert.notEqual(v2.digest, v1.digest);
  const read = (await lib.read(v1.id))!;
  assert.equal(read.digest, v2.digest);
  assert.match(harnessBundle([read]), new RegExp('Element: ' + v1.id + ' · revision 2 · sha256:' + v2.digest));
  await put('p/.harness/rules/review.md', 'v1');
  assert.equal((await lib.list()).entries.find((e) => e.id === v1.id)!.version, 1, 'content seen before keeps its revision');
  await put('p/.harness/rules/review.md', 'v3');
  assert.equal((await lib.list()).entries.find((e) => e.id === v1.id)!.version, 3, 'revisions never go backwards for new content');
  const guide = (await lib.list()).entries.find((e) => e.id === 'guide:plugins')!;
  assert.equal(guide.version, 1);
  assert.equal((await lib.read('guide:plugins'))?.version, 1);
});

test('a vanished element leaves a tombstone: it resolves as missing, is never remapped, and comes back with its own ID', async (t) => {
  const { at, put, data } = await fixture(t);
  await put('p/.harness/rules/review.md', 'keep me');
  await put('p/.harness/rules/other.md', 'other');
  const lib = new HarnessLibrary(harnessSources(at('p'), false), new HarnessRegistry(data));
  const review = (await lib.list()).entries.find((e) => e.path === 'rules/review.md')!;
  const other = (await lib.list()).entries.find((e) => e.path === 'rules/other.md')!;
  await rm(at('p/.harness/rules/review.md'));
  await lib.list();
  const gone = lib.resolve(review.id);
  assert.equal(gone.status, 'missing');
  if (gone.status === 'missing') {
    assert.equal(gone.path, 'rules/review.md');
    assert.equal(gone.version, 1);
    assert.equal(gone.digest, review.digest);
    assert.ok(Date.parse(gone.missingSince) > 0);
  }
  assert.equal(await lib.read(review.id), undefined);
  assert.equal(lib.resolve(other.id).status, 'available');
  assert.equal(lib.resolve('el:project:00000000000000000000').status, 'unknown');
  // Another library over the same data dir sees the tombstone too (shared installation registry).
  const second = new HarnessLibrary(harnessSources(at('p'), false), new HarnessRegistry(data));
  await second.list();
  assert.equal(second.resolve(review.id).status, 'missing');
  // Back on disk: same ID, the next revision; no other element was ever handed its ID.
  await put('p/.harness/rules/review.md', 'keep me again');
  const back = (await lib.list()).entries.find((e) => e.path === 'rules/review.md')!;
  assert.equal(back.id, review.id);
  assert.equal(back.version, 2);
  assert.equal(lib.resolve(review.id).status, 'available');
  // A truncated listing does not tombstone what it did not get to: `zz.md` is listed first, then 1,200 files that
  // sort before it push it past the bound, and it must not be declared missing.
  await put('big/.harness/zz.md', 'last');
  const bigLib = new HarnessLibrary(harnessSources(at('big'), false), new HarnessRegistry(data));
  const zz = (await bigLib.list()).entries.find((e) => e.path === 'zz.md')!;
  for (let i = 0; i < 1200; i++) await put('big/.harness/notes/n' + String(i).padStart(4, '0') + '.md', 'n' + i);
  const big = await bigLib.list();
  assert.equal(big.limited, true);
  assert.equal(big.entries.some((e) => e.id === zz.id), false, 'pushed past the bound');
  const cut = bigLib.resolve(zz.id);
  assert.ok(cut.status === 'missing' && cut.missingSince === '', 'known, not listed, but not tombstoned by a listing that was cut short');
});

test('a shared machine element has one ID in every project, and one project\'s assignment never moves another\'s', async (t) => {
  const { at, put, data } = await fixture(t);
  await put('machine/tooling/SKILL.md', 'shared skill');
  await put('a/.harness/rules/a.md', 'A');
  await put('b/.harness/rules/b.md', 'B');
  const shared = { name: 'Machine / skills', dir: at('machine'), ns: 'machine', prefix: '.claude/skills', category: 'skills' as const };
  const libA = new HarnessLibrary([...harnessSources(at('a'), false), shared], new HarnessRegistry(data));
  const libB = new HarnessLibrary([...harnessSources(at('b'), false), shared], new HarnessRegistry(data));
  const skillA = (await libA.list()).entries.find((e) => e.path === 'tooling/SKILL.md')!;
  const skillB = (await libB.list()).entries.find((e) => e.path === 'tooling/SKILL.md')!;
  assert.equal(skillA.id, skillB.id);
  assert.match(skillA.id, /^el:machine:/);
  const ruleA = (await libA.list()).entries.find((e) => e.path === 'rules/a.md')!;
  const profiles = new HarnessProfiles(data);
  await profiles.save(at('a'), '', 'repository', { 'skills.main': { resource: skillA.id }, 'rules.quality': { resource: ruleA.id } }, 0);
  await profiles.save(at('b'), '', 'repository', { 'skills.main': { resource: skillB.id } }, 1);
  // Project A swaps its assignment; project B's layer is untouched and still resolves to the same element.
  await profiles.save(at('a'), '', 'repository', { 'skills.main': null }, 2);
  const b = profiles.view(at('b'));
  assert.deepEqual(b.layers.repository, { 'skills.main': { resource: skillB.id } });
  assert.equal(libB.resolve(skillB.id).status, 'available');
  // The shared skill changes: both projects see revision 2 under the same ID; B's assignment did not change.
  await put('machine/tooling/SKILL.md', 'shared skill v2');
  assert.equal((await libA.list()).entries.find((e) => e.id === skillA.id)!.version, 2);
  assert.equal((await libB.list()).entries.find((e) => e.id === skillB.id)!.version, 2);
  assert.deepEqual(profiles.view(at('b')).layers.repository, { 'skills.main': { resource: skillB.id } });
  // Project-level elements stay apart: A's rule is known to the installation but not available in B, and B's complete listing never tombstones it.
  const fromB = libB.resolve(ruleA.id);
  assert.equal(fromB.status, 'missing');
  if (fromB.status === 'missing') assert.equal(fromB.missingSince, '', 'not a tombstone: it still exists where it was listed');
  assert.equal(libA.resolve(ruleA.id).status, 'available');
  await rm(at('a/.harness/rules/a.md'));
  await libA.list();
  const gone = libA.resolve(ruleA.id);
  assert.ok(gone.status === 'missing' && gone.missingSince, 'its own source instance tombstones it');
});

test('the same relative path in two projects shares one ID but keeps its own content, revision and tombstone per place', async (t) => {
  const { at, put, data } = await fixture(t);
  await put('a/AGENTS.md', 'rules of A');
  await put('b/AGENTS.md', 'rules of B');
  const libA = new HarnessLibrary(harnessSources(at('a'), false), new HarnessRegistry(data));
  const libB = new HarnessLibrary(harnessSources(at('b'), false), new HarnessRegistry(data));
  const agentsA = (await libA.list()).entries.find((e) => e.path === 'AGENTS.md')!;
  const agentsB = (await libB.list()).entries.find((e) => e.path === 'AGENTS.md')!;
  assert.equal(agentsA.id, agentsB.id);
  assert.equal(agentsA.version, 1);
  assert.equal(agentsB.version, 2, 'different content, next number');
  assert.equal((await libA.list()).entries.find((e) => e.path === 'AGENTS.md')!.version, 1, 'A keeps its number after B listed');
  assert.equal((await libB.list()).entries.find((e) => e.path === 'AGENTS.md')!.version, 2);
  const registry = new HarnessRegistry(data);
  assert.equal(registry.lookup(agentsA.id)?.missingSince, '');
  // B loses its copy: only B's instance is tombstoned; from A it is still available, and the record is not "missing everywhere".
  await rm(at('b/AGENTS.md'));
  await libB.list();
  assert.equal(libA.resolve(agentsA.id).status, 'available');
  const fromB = libB.resolve(agentsB.id);
  assert.ok(fromB.status === 'missing' && fromB.missingSince === '', 'gone here, still published in A');
  await libA.list();
  assert.equal(libA.resolve(agentsA.id).status, 'available', 'A listing does not revive or disturb B');
  await rm(at('a/AGENTS.md'));
  await libA.list();
  const everywhere = libA.resolve(agentsA.id);
  assert.ok(everywhere.status === 'missing' && everywhere.missingSince, 'gone from every place it was listed');
});

test('registry writes never break a listing: a held lock skips recording without blocking, a stale lock is taken over, a folder in place of the registry is left alone', async (t) => {
  const { at, put, data } = await fixture(t);
  await put('p/.harness/rules/x.md', 'x');
  const lock = path.join(data, 'harness-registry.json.lock');
  await put('data/harness-registry.json.lock', 'someone-else');
  const lib = new HarnessLibrary(harnessSources(at('p'), false), new HarnessRegistry(data));
  // The bounded wait for the lock is asynchronous: timers keep firing while the listing waits (Atomics.wait would freeze them).
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 10);
  const held = (await lib.list()).entries.find((e) => e.path === 'rules/x.md')!;
  clearInterval(ticker);
  assert.ok(ticks >= 20, 'the event loop kept running while waiting for the lock: ' + ticks + ' ticks');
  assert.equal(held.version, 0, 'another writer holds the lock: listed, unversioned');
  assert.equal(held.digest.length, 64);
  await assert.rejects(stat(path.join(data, 'harness-registry.json')), 'nothing written while locked');
  assert.equal(await readFile(lock, 'utf8'), 'someone-else', 'a young lock of another writer is never deleted');
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  assert.equal((await lib.list()).entries.find((e) => e.path === 'rules/x.md')!.version, 1, 'a stale lock is taken over');
  await assert.rejects(stat(lock), 'the lock is released');
  // The registry path occupied by a folder: unreadable, so nothing is versioned and nothing is replaced (a refused write is tested in harness-registry-robustness).
  const { at: at2, put: put2, data: data2 } = await fixture(t);
  await put2('p/.harness/rules/y.md', 'y');
  await mkdir(path.join(data2, 'harness-registry.json'), { recursive: true });
  const lib2 = new HarnessLibrary(harnessSources(at2('p'), false), new HarnessRegistry(data2));
  assert.equal((await lib2.list()).entries.find((e) => e.path === 'rules/y.md')!.version, 0);
  assert.ok((await stat(path.join(data2, 'harness-registry.json'))).isDirectory());
  assert.equal(lib2.resolve('constructor').status, 'unknown');
  assert.equal(lib2.resolve('__proto__').status, 'unknown');
});

test('old resource IDs (hash of the absolute path) keep resolving as aliases', async (t) => {
  const { at, put, data } = await fixture(t);
  await put('p/.harness/rules/review.md', 'review');
  const lib = new HarnessLibrary(harnessSources(at('p'), false), new HarnessRegistry(data));
  const entry = (await lib.list()).entries.find((e) => e.path === 'rules/review.md')!;
  const old = legacy(at('p/.harness/rules/review.md'));
  assert.deepEqual(entry.aliases, [old]);
  assert.equal(lib.resolve(old).status, 'available');
  assert.equal((await lib.read(old))?.id, entry.id, 'a read by alias returns the canonical ID');
  assert.equal((await lib.read('guide:testing'))?.id, 'guide:testing', 'guide IDs are unchanged');
  // A profile saved with the old ID still resolves through the handoff path (read by alias).
  const profiles = new HarnessProfiles(data);
  await profiles.save(at('p'), '', 'repository', { 'rules.quality': { resource: old } }, 0);
  assert.deepEqual(profiles.view(at('p')).layers.repository, { 'rules.quality': { resource: old } });
  const handoff = await harnessHandoff(data, at('p'), '', false);
  assert.match(handoff, /review/);
  assert.match(handoff, new RegExp('Element: ' + entry.id + ' · revision 1'));
});

test('credential-like, binary and nested credential-like files are excluded from the registry, which stores digests, never content', async (t) => {
  const { at, put, data } = await fixture(t);
  await put('p/.harness/tools/browser.md', 'ok');
  await put('p/.harness/tools/.env', 'SECRET=1');
  await put('p/.harness/tools/auth.json', '{"token":"x"}');
  await put('p/.harness/tools/service.token', 'x');
  await put('p/.harness/tools/binary.md', Buffer.from([1, 0, 2]));
  const registry = new HarnessRegistry(data);
  const lib = new HarnessLibrary(harnessSources(at('p'), false), registry);
  const catalog = await lib.list();
  assert.deepEqual(catalog.entries.filter((e) => e.source === 'Project / .harness').map((e) => e.path), ['tools/browser.md']);
  const stored = JSON.parse(await readFile(path.join(data, 'harness-registry.json'), 'utf8'));
  const paths = Object.values(stored.elements as Record<string, { path: string }>).map((r) => r.path);
  assert.ok(!paths.some((p) => /env|auth|token|binary/.test(p)), paths.join());
  assert.ok(!JSON.stringify(stored).includes('SECRET'), 'no content is stored, only digests');
});

test('an unreadable registry fails closed: versions read 0, nothing is overwritten', async (t) => {
  const { at, put, data } = await fixture(t);
  await put('data/harness-registry.json', '{not json');
  await put('p/.harness/rules/x.md', 'x');
  const lib = new HarnessLibrary(harnessSources(at('p'), false), new HarnessRegistry(data));
  const entry = (await lib.list()).entries.find((e) => e.path === 'rules/x.md')!;
  assert.equal(entry.version, 0);
  assert.equal(await readFile(path.join(data, 'harness-registry.json'), 'utf8'), '{not json');
});

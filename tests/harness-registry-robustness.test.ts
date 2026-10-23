// The element registry under adverse conditions (H03 follow-up after the critics): project elements in the
// global layer, a registry that cannot be written, reads that are denied, deleted checkouts, concurrent
// writers, a fresh process, the credential filter and what resolve() tells a non-admin library.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, readFile, readdir, utimes, stat, chmod } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { HarnessLibrary, harnessSources, elementId } from '../src/server/harness/catalog.js';
import { HarnessRegistry } from '../src/server/harness/registry.js';
import { HarnessProfiles } from '../src/server/harness/profiles.js';
import { harnessHandoff, assertBindable } from '../src/server/harness/handoff.js';

const root = path.resolve(import.meta.dirname, '..');
const win = process.platform === 'win32';
const asRoot = !win && process.getuid?.() === 0;
const run = promisify(execFile);

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-harness-robust-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const at = (file: string) => path.join(dir, file);
  const put = async (file: string, text: string | Buffer) => {
    await mkdir(path.dirname(at(file)), { recursive: true });
    await writeFile(at(file), text);
  };
  return { dir, at, put, data: at('data'), registry: at('data/harness-registry.json') };
}
const lib = (project: string, data: string, extra: Parameters<typeof HarnessLibrary>[0] = []) => new HarnessLibrary([...harnessSources(project, false), ...extra], new HarnessRegistry(data));
const legacy = (file: string) => createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 24);
/** A script run in a fresh node process (cold module cache, cold digest cache) with the library imported from this checkout. */
async function fresh(dir: string, name: string, body: string): Promise<string> {
  const file = path.join(dir, name + '.mts');
  const imports = ['catalog', 'registry'].map((m) => JSON.stringify(pathToFileURL(path.join(root, 'src/server/harness', m + '.ts')).href));
  await writeFile(file, `import { HarnessLibrary, harnessSources } from ${imports[0]};\nimport { HarnessRegistry } from ${imports[1]};\n` + body);
  const { stdout } = await run(process.execPath, ['--import', 'tsx', file], { cwd: root, encoding: 'utf8' });
  return stdout.trim();
}

test('a project element is refused in the global layer; a repository binding in A never reaches B; an old global binding blocks the handoff instead of rebinding', async (t) => {
  const { at, put, data } = await fixture(t);
  await put('a/.harness/rules/x.md', 'rules of A');
  await put('b/.harness/rules/x.md', 'rules of B');
  const libA = lib(at('a'), data), libB = lib(at('b'), data);
  const xA = (await libA.list()).entries.find((e) => e.path === 'rules/x.md')!;
  const xB = (await libB.list()).entries.find((e) => e.path === 'rules/x.md')!;
  assert.equal(xA.id, xB.id, 'the same relative path is one ID in both projects');
  assert.throws(() => assertBindable(libA, 'global', xA.id), /Project-scoped element in global layer: el:project:.*repository or task scope/);
  assert.doesNotThrow(() => assertBindable(libA, 'repository', xA.id));
  assert.doesNotThrow(() => assertBindable(libA, 'task', xA.id));
  assert.doesNotThrow(() => assertBindable(libA, 'global', 'guide:testing'), 'the handbook is the same everywhere');
  const profiles = new HarnessProfiles(data);
  await profiles.save(at('a'), '', 'repository', { 'rules.quality': { resource: xA.id } }, 0);
  assert.match(await harnessHandoff(data, at('a'), '', false), /rules of A/);
  assert.match(await harnessHandoff(data, at('b'), '', false), /No resource instructions assigned/, 'A\'s repository binding is invisible in B');
  // A store written before the rule (or by hand) holding a global binding to a project element: B's handoff must not pick up B's same-path file.
  await profiles.save(at('a'), '', 'global', { 'rules.quality': { resource: xA.id } }, 1);
  await assert.rejects(harnessHandoff(data, at('b'), '', false), /unavailable for this worker: project-scoped element in global layer/);
  assert.match(await harnessHandoff(data, at('a'), '', false), /rules of A/, 'the repository binding of A still overrides the global slot');
  await profiles.save(at('a'), '', 'repository', {}, 2);
  await assert.rejects(harnessHandoff(data, at('a'), '', false), /project-scoped element in global layer/, 'the rule does not depend on which project happens to match');
  const machine = { name: 'Machine / skills', dir: at('machine'), ns: 'machine', prefix: '.claude/skills', category: 'skills' as const };
  await put('machine/tooling/SKILL.md', 'shared');
  const libM = lib(at('a'), data, [machine]);
  const skill = (await libM.list()).entries.find((e) => e.path === 'tooling/SKILL.md')!;
  assert.throws(() => assertBindable(libM, 'global', skill.id), /explicitly shared/, 'private machine resources are not published to ordinary workers');
});

test('a read-only main file recovers published revisions; an unwritable directory cannot record them', async (t) => {
  const { at, put, data, registry } = await fixture(t);
  if (asRoot) return t.skip('permissions do not bind root');
  await put('p/.harness/rules/kept.md', 'kept');
  await put('p/.harness/rules/x.md', 'x1');
  const library = lib(at('p'), data);
  assert.equal((await library.list()).entries.find((e) => e.path === 'rules/x.md')!.version, 1);
  const before = await readFile(registry);
  // Windows: a read-only file cannot be replaced by rename. POSIX: the folder decides, so the folder is made read-only.
  const target = win ? registry : data;
  await chmod(target, win ? 0o444 : 0o555);
  const warn = t.mock.method(console, 'warn', () => {});
  try {
    await put('p/.harness/rules/x.md', 'x2');
    await put('p/.harness/rules/y.md', 'y');
    const listed = await library.list();
    assert.equal(listed.entries.find((e) => e.path === 'rules/y.md')!.version, win ? 1 : 0, 'Windows can publish a durable successor beside the read-only main file');
    assert.equal(listed.entries.find((e) => e.path === 'rules/x.md')!.version, win ? 2 : 0);
    if (win) assert.equal((await lib(at('p'), data).list()).entries.find((e) => e.path === 'rules/x.md')!.version, 2, 'a fresh reader recovers the committed successor');
    // On Windows the lock is still taken, so a revision persisted earlier is still served; a read-only folder on POSIX refuses the lock too (then everything reads 0).
    assert.equal(listed.entries.find((e) => e.path === 'rules/kept.md')!.version, win ? 1 : 0);
    assert.deepEqual(await readFile(registry), before, 'the file is untouched');
    assert.equal(warn.mock.callCount(), win ? 0 : 1, 'publication succeeds on Windows; an unwritable directory warns once');
    assert.deepEqual((await readdir(data)).filter((f) => f.endsWith('.tmp')), [], 'no temp file left behind');
  } finally {
    warn.mock.restore();
    await chmod(target, win ? 0o644 : 0o755);
  }
  assert.equal((await library.list()).entries.find((e) => e.path === 'rules/y.md')!.version, 1, 'writable again: recorded');
});

test('the 8 MiB cap: tombstones are pruned first, then the write is refused with versions 0 and the file untouched', async (t) => {
  const { at, put, data, registry } = await fixture(t);
  const MAX = 8 * 1024 * 1024;
  // Records that are present somewhere whose root cannot be checked (nothing above it exists but the volume root): never pruned.
  const rootHash = 'f'.repeat(16);
  const roots: Record<string, string> = { [rootHash]: path.resolve('/no-such-parent-' + randomUUID(), 'wt') };
  const elements: Record<string, unknown> = {};
  const at0 = '2026-01-01T00:00:00.000Z';
  const size = () => Buffer.byteLength(JSON.stringify({ schema: 1, elements, roots }, null, 1));
  const add = (i: number) => {
    const versions: Record<string, number> = {};
    for (let v = 1; v <= 32; v++) versions[createHash('sha256').update(i + ':' + v).digest('hex')] = v;
    const digest = Object.keys(versions)[31];
    elements['el:project:' + createHash('sha256').update('e' + i).digest('hex').slice(0, 20)] = { ns: 'project', key: '.harness/rules/r' + String(i).padStart(4, '0') + '.md', title: 'r' + String(i).padStart(4, '0') + '.md', path: 'rules/r' + String(i).padStart(4, '0') + '.md', source: 'Project / .harness', category: 'rules', versions, firstSeenAt: at0, instances: { [rootHash]: { digest, revision: 32, lastSeenAt: at0 } } };
  };
  // Fill to just under the cap (records are the same size, so the count follows from one record's size).
  add(0); const one = size(); add(1); const each = size() - one;
  for (let i = 2; i < Math.floor((MAX - 60_000 - one) / each) + 1; i++) add(i);
  assert.ok(size() <= MAX && size() > MAX - 80_000, 'just under the cap: ' + size());
  await put('data/harness-registry.json', JSON.stringify({ schema: 1, elements, roots }, null, 1));
  const before = await readFile(registry);
  for (let i = 0; i < 200; i++) await put('p/.harness/rules/new' + i + '.md', 'new ' + i);
  const warn = t.mock.method(console, 'warn', () => {});
  try {
    const listed = await lib(at('p'), data).list();
    const fresh = listed.entries.filter((e) => e.path.startsWith('rules/new'));
    assert.equal(fresh.length, 200);
    assert.ok(fresh.every((e) => e.version === 0), 'refused: no unsaved revision is reported');
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /is full/);
  } finally { warn.mock.restore(); }
  assert.deepEqual(await readFile(registry), before, 'the full registry is left byte for byte as it was');
  // Tombstoned records make room: once every record is gone from its place, the same listing fits and is recorded.
  for (const r of Object.values(elements) as { instances: Record<string, { missingSince?: string }> }[]) r.instances[rootHash].missingSince = at0;
  while (size() > MAX) delete elements[Object.keys(elements).at(-1)!]; // the tombstone stamps need room of their own
  await put('data/harness-registry.json', JSON.stringify({ schema: 1, elements, roots }, null, 1));
  const recorded = (await lib(at('p'), data).list()).entries.filter((e) => e.path.startsWith('rules/new'));
  assert.equal(recorded.length, 200);
  assert.ok(recorded.every((e) => e.version === 1), 'pruned, then written');
  assert.ok((await stat(registry)).size < 1024 * 1024);
});

test('a read that is denied leaves the walk incomplete: the element is not listed, not tombstoned, and comes back at its own revision', async (t) => {
  const { at, put, data } = await fixture(t);
  if (asRoot) return t.skip('permissions do not bind root');
  await put('p/.harness/rules/x.md', 'x');
  await put('p/.harness/rules/y.md', 'y');
  const library = lib(at('p'), data);
  const y = (await library.list()).entries.find((e) => e.path === 'rules/y.md')!;
  const file = at('p/.harness/rules/y.md');
  const user = process.env.USERNAME ?? '';
  const deny = () => win ? execFileSync('icacls', [file, '/deny', user + ':(RD)'], { stdio: 'pipe' }) : chmod(file, 0o000);
  const allow = () => win ? execFileSync('icacls', [file, '/remove:d', user], { stdio: 'pipe' }) : chmod(file, 0o644);
  try { await deny(); } catch (err) { return t.skip('cannot deny reading here: ' + (err as Error).message); }
  // A changed mtime defeats the digest cache, so the listing has to read the file (a cached digest needs no read).
  await utimes(file, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
  try {
    await assert.rejects(readFile(file), 'the read really is denied');
    const listed = await library.list();
    assert.equal(listed.entries.some((e) => e.id === y.id), false, 'not listed while unreadable');
    assert.equal(listed.entries.some((e) => e.path === 'rules/x.md'), true, 'its neighbours are');
    const now = library.resolve(y.id);
    assert.ok(now.status === 'missing' && now.missingSince === '', 'known and unavailable here, but not declared gone: ' + JSON.stringify(now));
    const xId = listed.entries.find((e) => e.path === 'rules/x.md')!.id;
    await rm(at('p/.harness/rules/x.md'));
    await library.list();
    const x = library.resolve(xId);
    assert.ok(x.status === 'missing' && x.missingSince === '', 'nothing in a source with a denied read is tombstoned, not even a file that is really gone');
  } finally { await allow(); }
  const back = (await library.list()).entries.find((e) => e.id === y.id)!;
  assert.equal(back.version, 1, 'same content, same revision');
  assert.equal(back.digest, y.digest);
});

test('records of a deleted checkout are pruned by the second save that finds it gone; a checkout that only lost its .harness folder and a root whose parent is gone too are kept', async (t) => {
  const { at, put, data, registry } = await fixture(t);
  await put('wts/wt1/.harness/rules/only-here.md', 'only in wt1');
  await put('wts/wt2/.harness/rules/branch-only.md', 'only on this branch');
  await put('p/.harness/rules/p.md', 'p');
  const only = (await lib(at('wts/wt1'), data).list()).entries.find((e) => e.path === 'rules/only-here.md')!;
  const branchOnly = (await lib(at('wts/wt2'), data).list()).entries.find((e) => e.path === 'rules/branch-only.md')!;
  await lib(at('p'), data).list();
  let stored = JSON.parse(await readFile(registry, 'utf8')) as { elements: Record<string, { instances: Record<string, unknown> }>; roots: Record<string, string> };
  assert.ok(Object.values(stored.roots).some((dir) => dir.toLowerCase().endsWith('wt1')), 'the place of each instance is the checkout, kept with the instance hash');
  // A root that cannot be checked (nothing above it but the volume root: an unmounted disk, an absent share) is kept, conservatively.
  const ghost = 'a'.repeat(16), ghostId = 'el:project:' + 'b'.repeat(20);
  stored.roots[ghost] = path.resolve('/no-such-parent-' + randomUUID(), 'wt');
  stored.elements[ghostId] = { ...stored.elements[only.id], instances: { [ghost]: stored.elements[only.id].instances[Object.keys(stored.elements[only.id].instances)[0]] } };
  await writeFile(registry, JSON.stringify(stored, null, 1));
  await rm(at('wts/wt1'), { recursive: true, force: true });
  await rm(at('wts/wt2/.harness'), { recursive: true, force: true }); // a branch without published folders: the checkout is still there
  await put('p/.harness/rules/p.md', 'p changed');
  const p = lib(at('p'), data);
  await p.list();
  stored = JSON.parse(await readFile(registry, 'utf8'));
  assert.ok(stored.elements[only.id], 'one save that finds the checkout gone only records the sighting');
  const sightings = Object.keys((stored as unknown as { rootsMissing: Record<string, string> }).rootsMissing);
  assert.ok(sightings.length > 0 && sightings.every((h) => stored.roots[h].toLowerCase().endsWith('wt1')), 'the sighting is recorded for the places of the deleted checkout alone (one per source instance)');
  await p.list();
  stored = JSON.parse(await readFile(registry, 'utf8'));
  assert.equal(stored.elements[only.id], undefined, 'the deleted worktree\'s only element is gone from the registry after the second save');
  assert.equal(Object.values(stored.roots).some((dir) => dir.toLowerCase().includes('wt1')), false);
  assert.ok(stored.elements[ghostId], 'the unreachable root is kept');
  assert.ok(stored.elements[branchOnly.id], 'a checkout that only switched branches keeps its records');
  assert.equal(p.resolve(only.id).status, 'unknown');
});

test('two processes recording listings at once take turns: one valid registry, every element recorded, no lock or temp file left', async (t) => {
  const { at, put, data, registry, dir } = await fixture(t);
  for (const p of ['one', 'two']) for (let i = 0; i < 20; i++) await put(p + '/.harness/rules/' + p + i + '.md', p + ' ' + i);
  const script = (p: string) => `const lib = new HarnessLibrary(harnessSources(${JSON.stringify(at(p))}, false), new HarnessRegistry(${JSON.stringify(data)}));
for (let i = 0; i < 6; i++) await lib.list();
const last = await lib.list();
console.log(JSON.stringify(last.entries.filter((e) => e.path.startsWith('rules/')).map((e) => [e.id, e.version])));`;
  const [one, two] = await Promise.all([fresh(dir, 'one', script('one')), fresh(dir, 'two', script('two'))]);
  for (const out of [one, two]) {
    const pairs = JSON.parse(out) as [string, number][];
    assert.equal(pairs.length, 20);
    assert.ok(pairs.every(([, v]) => v === 1), 'the last listing of each process is recorded: ' + out);
  }
  const stored = JSON.parse(await readFile(registry, 'utf8')) as { elements: Record<string, unknown> };
  assert.equal(Object.keys(stored.elements).filter((id) => id.startsWith('el:project:')).length, 40, 'both processes\' elements survived each other\'s writes');
  assert.deepEqual((await readdir(data)).filter((f) => f.endsWith('.lock') || f.endsWith('.tmp')), []);
});

test('a fresh process sees the same IDs and revisions and reuses the persisted digests; an edit the cache key cannot tell is shown until read() repairs it', async (t) => {
  const { at, put, data, dir } = await fixture(t);
  for (let i = 0; i < 50; i++) await put('p/.harness/rules/r' + i + '.md', 'rule ' + i);
  const r7 = at('p/.harness/rules/r7.md'), stamp = new Date('2026-01-01T00:00:00Z');
  await utimes(r7, stamp, stamp);
  const first = (await lib(at('p'), data).list()).entries.filter((e) => e.path.startsWith('rules/')).map((e) => [e.id, e.version, e.digest]);
  const cacheFile = path.join(data, 'harness-digests.json');
  const digests = JSON.parse(await readFile(cacheFile, 'utf8')) as { schema: number; files: Record<string, string> };
  assert.equal(digests.schema, 1);
  assert.equal(Object.keys(digests.files).length, 50, 'one entry per listed file');
  assert.ok(Object.values(digests.files).every((v) => /^[0-9:]+ [0-9a-f]{64}$/.test(v)), 'file identity and digest, never content');
  const oldDigest = createHash('sha256').update('rule 7').digest('hex'), newDigest = createHash('sha256').update('RULE 7').digest('hex');
  const r7Id = first.find(([, , d]) => d === oldDigest)![0] as string;
  // A same-size rewrite with the old mtime still changes the change time, so the key misses and the file is re-hashed.
  await writeFile(r7, 'RULE 7');
  await utimes(r7, stamp, stamp);
  const again = JSON.parse(await fresh(dir, 'again', `const lib = new HarnessLibrary(harnessSources(${JSON.stringify(at('p'))}, false), new HarnessRegistry(${JSON.stringify(data)}));
const c = await lib.list();
console.log(JSON.stringify(c.entries.filter((e) => e.path.startsWith('rules/')).map((e) => [e.id, e.version, e.digest])));`)) as [string, number, string][];
  assert.deepEqual(again.filter(([id]) => id !== r7Id), first.filter(([id]) => id !== r7Id), 'same IDs, versions and digests across processes for the unchanged files');
  assert.deepEqual(again.find(([id]) => id === r7Id), [r7Id, 2, newDigest], 'the edited file was re-hashed: new content, next revision');
  // An edit the key cannot tell (here: the cache entry rewritten to the file's current key with the previous digest, which the registry knows) is shown by a listing.
  const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as { files: Record<string, string> };
  cached.files[r7] = cached.files[r7].split(' ')[0] + ' ' + oldDigest;
  await writeFile(cacheFile, JSON.stringify(cached));
  const stale = JSON.parse(await fresh(dir, 'stale', `const lib = new HarnessLibrary(harnessSources(${JSON.stringify(at('p'))}, false), new HarnessRegistry(${JSON.stringify(data)}));
const c = await lib.list();
const e = c.entries.find((e) => e.id === ${JSON.stringify(r7Id)});
const listed = [e.version, e.digest];
const warned = [];
console.warn = (m) => warned.push(String(m));
const r = await lib.read(e.id);
const d = await lib.list();
console.log(JSON.stringify({ listed, read: [r.version, r.digest, r.text], next: [d.entries.find((e) => e.id === ${JSON.stringify(r7Id)}).version, d.entries.find((e) => e.id === ${JSON.stringify(r7Id)}).digest], warned }));`)) as { listed: [number, string]; read: [number, string, string]; next: [number, string]; warned: string[] };
  assert.deepEqual(stale.listed, [1, oldDigest], 'the cached digest is served (the documented staleness window)');
  assert.deepEqual(stale.read, [2, newDigest, 'RULE 7'], 'a read reports the digest of the bytes returned and the revision that content has');
  assert.deepEqual(stale.next, [2, newDigest], 'the next listing shows the repaired digest');
  assert.equal(stale.warned.filter((m) => /repaired/.test(m)).length, 1, 'logged once');
  assert.equal(JSON.parse(await readFile(cacheFile, 'utf8')).files[r7].split(' ')[1], newDigest, 'the cache entry was repaired too');
});

test('after a checkout move the canonical ID and the new alias resolve; the alias of the old path is unknown', async (t) => {
  const { at, put, data } = await fixture(t);
  await put('one/.harness/rules/review.md', 'review');
  const before = (await lib(at('one'), data).list()).entries.find((e) => e.path === 'rules/review.md')!;
  const oldAlias = legacy(at('one/.harness/rules/review.md'));
  assert.deepEqual(before.aliases, [oldAlias]);
  const profiles = new HarnessProfiles(data);
  await profiles.save(at('one'), '', 'repository', { 'rules.quality': { resource: oldAlias } }, 0);
  await rename(at('one'), at('two'));
  const moved = lib(at('two'), data);
  const after = (await moved.list()).entries.find((e) => e.path === 'rules/review.md')!;
  assert.equal(after.id, before.id);
  assert.deepEqual(after.aliases, [legacy(at('two/.harness/rules/review.md'))]);
  assert.equal(moved.resolve(oldAlias).status, 'unknown', 'the alias is a hash of the old absolute path: it does not follow the move');
  assert.equal(moved.resolve(after.id).status, 'available');
  // Repository profiles are keyed by the checkout path too, so the moved checkout starts with no layer; the old one, if reused, would block on the alias.
  assert.deepEqual(profiles.view(at('two')).layers.repository, {});
  await profiles.save(at('two'), '', 'repository', { 'rules.quality': { resource: oldAlias } }, 1);
  await assert.rejects(harnessHandoff(data, at('two'), '', false), /unavailable for this worker/);
  await profiles.save(at('two'), '', 'repository', { 'rules.quality': { resource: after.id } }, 2);
  assert.match(await harnessHandoff(data, at('two'), '', false), new RegExp('Element: ' + after.id + ' · revision 1'));
});

test('credential-like names are skipped wherever they sit on the path, on Windows paths too; look-alikes stay listed', async (t) => {
  const { at, put, data } = await fixture(t);
  const skipped = ['tools/my-secrets/notes.md', 'tools/tokens/budget.md', 'tools/service-account-dev.json', 'tools/apikey.md', 'tools/my-api-key.txt', 'tools/api_key.yaml', 'rules/passwords.md', 'keys/id_rsa.txt', 'keys/id_ed25519.md', 'ops/kubeconfig.yaml', 'ops/kubeconfig-prod.yml', 'tools/token-budget.md', 'tools/auth.json', 'tools/.env.local', 'tools/cert.pem'];
  const listed = ['tools/authors.md', 'tools/authentication.md', 'tools/author-guide.md', 'tools/oauth-flow.md', 'tools/tokyo.md', 'tools/browser.md', 'rules/pass.md', 'ops/kube.md'];
  for (const f of [...skipped, ...listed]) await put('p/.harness/' + f, 'text');
  const paths = (await lib(at('p'), data).list()).entries.filter((e) => e.source === 'Project / .harness').map((e) => e.path).sort();
  assert.deepEqual(paths, [...listed].sort());
  // The ID of a nested element is derived from the slash form even when the walk produced a backslash path.
  assert.equal(elementId({ name: 'x', dir: 'C:\\p\\.harness', ns: 'project', prefix: '.harness' }, 'tools\\browser.md').id, elementId({ name: 'x', dir: '/p/.harness', ns: 'project', prefix: '.harness' }, 'tools/browser.md').id);
});

test('resolve() describes only namespaces the library publishes: a non-admin library never learns a machine element\'s title or path', async (t) => {
  const { at, put, data } = await fixture(t);
  await put('machine/tooling/SKILL.md', 'shared skill');
  await put('p/.harness/rules/p.md', 'p');
  const machine = { name: 'Machine / skills', dir: at('machine'), ns: 'machine', prefix: '.claude/skills', category: 'skills' as const };
  const admin = lib(at('p'), data, [machine]);
  const skill = (await admin.list()).entries.find((e) => e.path === 'tooling/SKILL.md')!;
  await rm(at('machine/tooling'), { recursive: true, force: true });
  await admin.list();
  const fromAdmin = admin.resolve(skill.id);
  assert.ok(fromAdmin.status === 'missing' && fromAdmin.missingSince && fromAdmin.path === 'tooling/SKILL.md', 'the admin library sees the tombstone');
  const member = lib(at('p'), data);
  await member.list();
  assert.deepEqual(member.resolve(skill.id), { status: 'unknown', id: skill.id }, 'no metadata for a namespace this library does not publish');
  assert.deepEqual(member.resolve('guide:testing').status, 'available');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { HarnessLibrary, harnessSources } from '../src/server/harness/catalog.js';
import { harnessBundle } from '../src/shared/harness.js';
import { HARNESS_SHELF } from '../src/shared/harness-layout.js';
import { BOOKSHELF, BALCONY_DOOR } from '../src/shared/layout.js';
import { harnessRoute } from '../src/server/http/routes/harness.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-harness-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const put = async (file: string, text: string | Buffer) => {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  };
  return { dir, put };
}

test('catalog reads published resources and exports provenance; rejects unavailable IDs', async (t) => {
  const { dir, put } = await fixture(t);
  await put('skills/fixture/SKILL.md', '# A skill\nUse a bounded search.');
  await put('hooks/after-tool.py', 'print("done")');
  const lib = new HarnessLibrary([{ name: 'Published', dir }]);
  const catalog = await lib.list();
  const skill = catalog.entries.find((e) => e.path === 'skills/fixture/SKILL.md')!;
  assert.equal(skill.category, 'skills');
  assert.equal(catalog.entries.find((e) => e.title === 'after-tool.py')?.category, 'hooks');
  assert.equal(skill.group, 'fixture');
  assert.match(skill.id, /^el:source:[0-9a-f]{20}$/);
  assert.equal(skill.digest.length, 64);
  assert.equal(skill.version, 0, 'no registry attached: unversioned');
  const entry = (await lib.read(skill.id))!;
  assert.match(harnessBundle([entry]), /Published \/ skills\/fixture\/SKILL.md/);
  assert.match(entry.text, /bounded search/);
  assert.equal(await lib.read('../../outside.md'), undefined);
  await put('skills/fixture/SKILL.md', 'Updated');
  assert.equal((await lib.read(skill.id))?.text, 'Updated');
});

test('skips credentials, binaries, oversized files and directory links outside a source', async (t) => {
  const { dir, put } = await fixture(t);
  await put('published/good.md', 'safe');
  await put('published/.env', 'SECRET');
  await put('published/auth.json', 'SECRET');
  await put('published/credentials.json', 'SECRET');
  await put('published/large.md', 'x'.repeat(128 * 1024 + 1));
  await put('published/binary.md', Buffer.from([1, 0, 2]));
  await put('private/private.md', 'PRIVATE');
  await symlink(path.join(dir, 'private'), path.join(dir, 'published', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const lib = new HarnessLibrary([{ name: 'Published', dir: path.join(dir, 'published') }]);
  const catalog = await lib.list();
  const paths = catalog.entries.filter((e) => e.source === 'Published').map((e) => e.path);
  assert.deepEqual(paths, ['good.md']);
  // Replacing a listed directory with a link between listing and reading stays within root.
  await put('published/sub/entry.md', 'before');
  const second = await lib.list();
  const id = second.entries.find((e) => e.path === 'sub/entry.md')!.id;
  await put('private/entry.md', 'PRIVATE');
  await rm(path.join(dir, 'published/sub'), { recursive: true });
  await symlink(path.join(dir, 'private'), path.join(dir, 'published/sub'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await lib.read(id), undefined);
});

test('members do not discover machine resources; OpenViking sources need explicit or discovered roots', () => {
  const project = path.resolve('fixture');
  const env = { AGENT_OFFICE_HARNESS_DIR: path.resolve('machine'), AGENT_OFFICE_OPENVIKING_DIR: path.resolve('viking') };
  assert.ok(harnessSources(project, false, env).every((s) => s.dir.startsWith(project)));
  const admin = harnessSources(project, true, env);
  assert.ok(admin.some((s) => s.name === 'Published machine harness'));
  assert.equal(admin.filter((s) => s.name.startsWith('OpenViking')).length, 3);
});

test('project discovery rejects an intermediate directory link outside the project', async (t) => {
  const { dir, put } = await fixture(t);
  await put('project/AGENTS.md', 'Project rules');
  await put('private/skills/hidden/SKILL.md', 'PRIVATE');
  await symlink(path.join(dir, 'private'), path.join(dir, 'project/.claude'), process.platform === 'win32' ? 'junction' : 'dir');
  const lib = new HarnessLibrary(harnessSources(path.join(dir, 'project'), false));
  const catalog = await lib.list();
  assert.equal(catalog.entries.some((e) => e.path.includes('hidden')), false);
  assert.equal(catalog.sources.find((s) => s.name === 'Project / .claude/skills')?.available, false);
});

test('discovery is bounded and reports missing sources', async (t) => {
  const { dir, put } = await fixture(t);
  await put('a/'.repeat(12) + 'deep.md', 'too deep');
  const lib = new HarnessLibrary([{ name: 'Deep', dir }, { name: 'Missing', dir: path.join(dir, 'missing') }]);
  const catalog = await lib.list();
  assert.equal(catalog.limited, true);
  assert.equal(catalog.sources[1].available, false);
  assert.equal(catalog.entries.some((e) => e.title === 'deep.md'), false);
});

test('Harness shelf mirrors Docs and leaves the balcony doorway clear', () => {
  assert.equal(HARNESS_SHELF.x + BOOKSHELF.x, 2 * BALCONY_DOOR.u);
  assert.ok(HARNESS_SHELF.x - HARNESS_SHELF.width / 2 > BALCONY_DOOR.u + BALCONY_DOOR.width / 2);
  assert.equal(HARNESS_SHELF.z, BOOKSHELF.z);
});

test('HTTP route requires a session and does not reveal a resource for an unknown floor', async () => {
  assert.equal(harnessRoute.auth, 'session');
  const response = { status: 0, body: '', writeHead(status: number) { this.status = status; return this; }, end(body: string) { this.body = body; } };
  await harnessRoute.handle({ floors: new Map() } as any, { res: response, url: new URL('http://local/api/harness?floor=missing'), path: '/api/harness', session: {} } as any);
  assert.equal(response.status, 404);
});

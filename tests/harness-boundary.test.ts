// A listed Harness resource is re-checked on every read: swapping the published folder, a folder
// between it and the file, or the file itself for a link after list() must not reach other files.
// Fixtures are throwaway temp folders with harmless text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { HarnessLibrary } from '../src/server/harness/catalog.js';

const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';
const OUTSIDE = 'OUTSIDE FIXTURE';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-harness-boundary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const at = (file: string) => path.join(dir, file);
  const put = async (file: string, text: string) => {
    await mkdir(path.dirname(at(file)), { recursive: true });
    await writeFile(at(file), text);
  };
  await put('project/.harness/guide.md', 'PUBLISHED');
  await put('project/.harness/team/guide.md', 'TEAM');
  await put('outside/guide.md', OUTSIDE);
  await put('outside/team/guide.md', OUTSIDE);
  const lib = new HarnessLibrary([{ name: 'Project harness', dir: at('project/.harness'), boundary: at('project') }]);
  const catalog = await lib.list();
  const id = (p: string) => catalog.entries.find((e) => e.source === 'Project harness' && e.path === p)!.id;
  return { at, put, lib, catalog, id };
}

test('a published folder swapped for a link outside the boundary after list() is not read', async (t) => {
  const { at, lib, id } = await fixture(t);
  const guide = id('guide.md');
  await rename(at('project/.harness'), at('project/original-harness'));
  await symlink(at('outside'), at('project/.harness'), DIR_LINK);
  assert.equal(await lib.read(guide), undefined);
  assert.equal(await lib.read(id('team/guide.md')), undefined);
});

test('a boundary swapped for a link elsewhere after list() is not read', async (t) => {
  const { at, put, lib, id } = await fixture(t);
  const guide = id('guide.md');
  await put('elsewhere/.harness/guide.md', OUTSIDE);
  await rename(at('project'), at('original-project'));
  await symlink(at('elsewhere'), at('project'), DIR_LINK);
  assert.equal(await lib.read(guide), undefined);
});

test('an intermediate folder swapped for a link outside after list() is not read', async (t) => {
  const { at, lib, id } = await fixture(t);
  const team = id('team/guide.md');
  await rename(at('project/.harness/team'), at('project/.harness/original-team'));
  await symlink(at('outside/team'), at('project/.harness/team'), DIR_LINK);
  assert.equal(await lib.read(team), undefined);
  assert.equal((await lib.read(id('guide.md')))?.text, 'PUBLISHED');
});

test('a file swapped for a symlink outside after list() is not read', async (t) => {
  const { at, lib, id } = await fixture(t);
  const guide = id('guide.md');
  await rename(at('project/.harness/guide.md'), at('project/.harness/original-guide.md'));
  try { await symlink(at('outside/guide.md'), at('project/.harness/guide.md'), 'file'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    t.skip('creating a file symlink needs Developer Mode or administrator rights on Windows');
    return;
  }
  assert.equal(await lib.read(guide), undefined);
});

test('legitimate files stay readable, including edits saved by replacing the file', async (t) => {
  const { at, put, lib, catalog, id } = await fixture(t);
  assert.deepEqual(catalog.entries.filter((e) => e.source === 'Project harness').map((e) => e.path), ['guide.md', 'team/guide.md']);
  assert.equal((await lib.read(id('guide.md')))?.text, 'PUBLISHED');
  assert.equal((await lib.read(id('team/guide.md')))?.path, 'team/guide.md');
  await put('project/.harness/team/guide.next', 'TEAM v2');
  await rename(at('project/.harness/team/guide.next'), at('project/.harness/team/guide.md'));
  assert.equal((await lib.read(id('team/guide.md')))?.text, 'TEAM v2');
});

test('links that stay inside the boundary: above the published folder they work, below it they are never followed', async (t) => {
  const { at, put } = await fixture(t);
  // Above: the published folder is reached through a link into the project itself, as list() allows.
  await put('project/shared/claude/skills/demo/SKILL.md', 'INSIDE');
  await symlink(at('project/shared/claude'), at('project/.claude'), DIR_LINK);
  const linked = new HarnessLibrary([{ name: 'Skills', dir: at('project/.claude/skills'), boundary: at('project') }]);
  const skill = (await linked.list()).entries.find((e) => e.source === 'Skills')!;
  assert.equal((await linked.read(skill.id))?.text, 'INSIDE');
  // Below: a link inside the published folder is skipped by list(), and one swapped in after list()
  // is refused by read(), even when its target is published in the same folder.
  const { at: at2, lib, id } = await fixture(t);
  await symlink(at2('project/.harness/team'), at2('project/.harness/alias'), DIR_LINK);
  assert.equal((await lib.list()).entries.some((e) => e.path.startsWith('alias/')), false);
  const team = id('team/guide.md');
  await rename(at2('project/.harness/team'), at2('project/.harness/team-moved'));
  await symlink(at2('project/.harness/team-moved'), at2('project/.harness/team'), DIR_LINK);
  assert.equal(await lib.read(team), undefined);
  // The published folder itself swapped for a link to another folder inside the project: refused too.
  const { at: at3, lib: lib3, id: id3 } = await fixture(t);
  const guide = id3('guide.md');
  await rename(at3('project/.harness'), at3('project/harness-moved'));
  await symlink(at3('project/harness-moved'), at3('project/.harness'), DIR_LINK);
  assert.equal(await lib3.read(guide), undefined);
});

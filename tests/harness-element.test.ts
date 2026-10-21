// Creating an element from the library (src/server/harness/element-api.ts, docs/harness.md "Categories and
// the editor"): POST /api/harness/element over the real route table of tests/support/harness-context-office.ts.
// The auth matrix like the other harness routes (administrators and the shared-password session write,
// members get 403, signed-out 401, cross-origin 403, only POST), the folder rules (a known category, a group
// and a name without traversal, a text type, no credential-like or skipped names), no writing through links,
// never overwriting, the 128 KiB limit, the audit, and the reply carrying the element as listed. Also the
// profile reply's additions: the per-level audit filter and the state of every assigned element.
import test from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contextOffice } from './support/harness-context-office.js';
import { parseElementRequest } from '../src/server/harness/element-api.js';
import { HarnessProfiles } from '../src/server/harness/profiles.js';

const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';
const element = (over: Record<string, unknown> = {}) => ({ category: 'rules', group: 'review', name: 'checklist.md', content: '# Checklist\n\nRun the tests.\n', ...over });
const checkout = (dataDir: string, floor = 'ample') => path.join(dataDir, 'checkouts', floor);

test('auth matrix: administrators and the shared-password session create, members 403, signed out 401, cross-origin 403, only POST', async (t) => {
  let who: string | undefined = 'shared';
  const office = await contextOffice({ session: (_req: http.IncomingMessage) => (who === 'shared' ? {} : who === 'admin' ? { account: { id: 'ada', role: 'admin' } } : who === 'member' ? { account: { id: 'mia', role: 'member' } } : undefined) });
  t.after(() => office.close());
  const url = '/api/harness/element?floor=ample';
  who = 'member';
  const member = await office.call(url, element({ name: 'by-member.md' }));
  assert.equal(member.status, 403);
  assert.match((await member.json()).error, /Only administrators/);
  assert.ok(!existsSync(path.join(checkout(office.dataDir), '.harness', 'rules', 'review', 'by-member.md')), 'nothing written for a member');
  who = undefined;
  assert.equal((await office.call(url, element({ name: 'signed-out.md' }))).status, 401);
  who = 'shared';
  assert.equal((await office.call(url, element({ name: 'foreign.md' }), { origin: 'http://evil.example' })).status, 403, 'cross-origin');
  assert.equal((await office.call(url)).status, 405, 'GET is not answered');
  assert.equal((await office.call('/api/harness/element?floor=nope', element())).status, 404);
  assert.equal((await office.call(url, element({ name: 'shared.md' }))).status, 201, 'the shared-password session');
  who = 'admin';
  const admin = await office.call(url, element({ name: 'admin.md' }));
  assert.equal(admin.status, 201, 'an administrator account');
  const audit = JSON.parse(readFileSync(path.join(office.dataDir, 'harness-elements.json'), 'utf8')).audit;
  assert.deepEqual(audit.map((a: { by: string; path: string }) => [a.by, a.path]), [['shared-password', '.harness/rules/review/shared.md'], ['account:ada', '.harness/rules/review/admin.md']]);
});

test('a created element is in the reply and the catalog as listed: its ID, revision and digest', async (t) => {
  const office = await contextOffice();
  t.after(() => office.close());
  const response = await office.call('/api/harness/element?floor=ample', element());
  assert.equal(response.status, 201);
  const reply = await response.json();
  assert.equal(reply.path, '.harness/rules/review/checklist.md');
  assert.match(reply.id, /^el:project:[0-9a-f]{20}$/);
  assert.equal(reply.entry.id, reply.id);
  assert.equal(reply.entry.category, 'rules');
  assert.equal(reply.entry.group, 'review');
  assert.ok(reply.entry.version >= 1, 'a revision from the registry');
  assert.match(reply.entry.digest, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(path.join(checkout(office.dataDir), '.harness', 'rules', 'review', 'checklist.md'), 'utf8'), element().content);
  const catalog = await (await office.call('/api/harness?floor=ample')).json();
  assert.ok(catalog.entries.some((e: { id: string }) => e.id === reply.id), 'the next listing has it');
  // Without a group the file goes straight into the category folder.
  const flat = await (await office.call('/api/harness/element?floor=ample', element({ group: '', name: 'flat.md' }))).json();
  assert.equal(flat.path, '.harness/rules/flat.md');
  assert.equal(flat.entry.group, 'Project / .harness', 'an element right in its category folder is on the source shelf');
});

test('an existing file is never overwritten (409), whoever made it', async (t) => {
  const office = await contextOffice();
  t.after(() => office.close());
  assert.equal((await office.call('/api/harness/element?floor=ample', element())).status, 201);
  const again = await office.call('/api/harness/element?floor=ample', element({ content: 'replacement' }));
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /already exists: the library never overwrites/);
  assert.equal(readFileSync(path.join(checkout(office.dataDir), '.harness', 'rules', 'review', 'checklist.md'), 'utf8'), element().content);
  // The fixture's own file too.
  const fixture = await office.call('/api/harness/element?floor=ample', element({ category: 'instructions', group: '', name: 'ample-rules.md', content: 'x' }));
  assert.equal(fixture.status, 409);
  assert.match(readFileSync(path.join(checkout(office.dataDir), '.harness', 'instructions', 'ample-rules.md'), 'utf8'), /house rules/);
});

test('folder rules: a known category, a group and a file name without traversal, a text type, no credential-like or skipped names', async (t) => {
  const office = await contextOffice();
  t.after(() => office.close());
  const refused: [Record<string, unknown>, RegExp][] = [
    [{ category: 'nope' }, /Choose one of the categories/],
    [{ category: '../rules' }, /Choose one of the categories/],
    [{ group: '..' }, /not allowed/],
    [{ group: '../outside' }, /not allowed/],
    [{ group: 'a/b' }, /not allowed/],
    [{ group: 'a\\b' }, /not allowed/],
    [{ name: '../escape.md' }, /not allowed/],
    [{ name: 'a/b.md' }, /not allowed/],
    [{ name: '..hidden.md' }, /not allowed/],
    [{ name: '.env' }, /not allowed/],
    [{ name: 'C:x.md' }, /not allowed/],
    [{ name: 'con.md' }, /not allowed/],
    [{ name: 'trailing.md.' }, /not allowed/],
    [{ name: 'x'.repeat(101) + '.md' }, /not allowed/],
    [{ name: 'tool.exe' }, /only text files are published/],
    [{ name: 'checklist' }, /only text files are published/],
    [{ name: 'github-token.md' }, /credential-like name/],
    [{ name: 'api-key.md' }, /credential-like name/],
    [{ name: 'my-secrets.md' }, /credential-like name/],
    [{ name: 'server.pem' }, /credential-like name|only text files/],
    [{ group: 'credentials' }, /credential-like name|skipped/],
    [{ group: 'node_modules' }, /skipped by discovery/],
    [{ content: '' }, /Write the content/],
    [{ content: 'a\0b' }, /must be text/],
    [{ name: 42 }, /Give the file name/],
  ];
  for (const [over, error] of refused) {
    const response = await office.call('/api/harness/element?floor=ample', element(over));
    assert.equal(response.status, 400, JSON.stringify(over));
    assert.match((await response.json()).error, error, JSON.stringify(over));
  }
  assert.equal((await office.call('/api/harness/element?floor=ample', 'not an object' as unknown as object)).status, 400);
  // Nothing of it reached the disk: only the fixture's own instructions folder is there.
  assert.deepEqual(readdirSync(path.join(checkout(office.dataDir), '.harness')), ['instructions']);
  assert.ok(!existsSync(path.join(checkout(office.dataDir), 'outside')) && !existsSync(path.join(office.dataDir, 'checkouts', 'escape.md')));
  assert.throws(() => parseElementRequest([]), /Expected a JSON object/);
});

test('the 128 KiB limit: exactly 128 KiB is created, one byte more is 413', async (t) => {
  const office = await contextOffice();
  t.after(() => office.close());
  assert.equal((await office.call('/api/harness/element?floor=ample', element({ name: 'max.md', content: 'x'.repeat(128 * 1024) }))).status, 201);
  const over = await office.call('/api/harness/element?floor=ample', element({ name: 'over.md', content: 'x'.repeat(128 * 1024 + 1) }));
  assert.equal(over.status, 413);
  assert.match((await over.json()).error, /at most 128 KiB/);
  const huge = await office.call('/api/harness/element?floor=ample', element({ name: 'huge.md', content: 'x'.repeat(2 * 1024 * 1024) }));
  assert.equal(huge.status, 413, 'a body past the request limit');
  assert.ok(!existsSync(path.join(checkout(office.dataDir), '.harness', 'rules', 'review', 'over.md')));
});

test('never through a link: a linked .harness, category or group folder is refused and nothing lands outside', async (t) => {
  const office = await contextOffice();
  t.after(() => office.close());
  const outside = path.join(office.dataDir, 'outside');
  mkdirSync(outside, { recursive: true });
  const dir = checkout(office.dataDir, 'tajemstvi');
  rmSync(path.join(dir, '.harness'), { recursive: true, force: true });
  await symlink(outside, path.join(dir, '.harness'), DIR_LINK);
  const linkedRoot = await office.call('/api/harness/element?floor=tajemstvi', element());
  assert.equal(linkedRoot.status, 400);
  assert.match((await linkedRoot.json()).error, /\.harness\/ is a link/);
  // A linked category folder, and a linked group folder.
  const ample = checkout(office.dataDir);
  await symlink(outside, path.join(ample, '.harness', 'rules'), DIR_LINK);
  const linkedCategory = await office.call('/api/harness/element?floor=ample', element());
  assert.equal(linkedCategory.status, 400);
  assert.match((await linkedCategory.json()).error, /rules\/ is a link/);
  mkdirSync(path.join(ample, '.harness', 'tools'));
  await symlink(outside, path.join(ample, '.harness', 'tools', 'browser'), DIR_LINK);
  const linkedGroup = await office.call('/api/harness/element?floor=ample', element({ category: 'tools', group: 'browser', name: 'b.md' }));
  assert.equal(linkedGroup.status, 400);
  assert.deepEqual(readdirSync(outside), [], 'nothing was written through a link');
  // A file in the way (a group name that is a file) is refused too.
  writeFileSync(path.join(ample, '.harness', 'tools', 'notes'), 'x');
  assert.equal((await office.call('/api/harness/element?floor=ample', element({ category: 'tools', group: 'notes', name: 'n.md' }))).status, 400);
});

test('a link at the file\'s own name is never written through (where the OS lets a test make one)', async (t) => {
  const office = await contextOffice();
  t.after(() => office.close());
  const target = path.join(office.dataDir, 'target.md');
  writeFileSync(target, 'original');
  const at = path.join(checkout(office.dataDir), '.harness', 'instructions', 'linked.md');
  try { await symlink(target, at, 'file'); } catch { return t.skip('file symlinks need privileges here'); }
  const response = await office.call('/api/harness/element?floor=ample', element({ category: 'instructions', group: '', name: 'linked.md', content: 'overwrite' }));
  assert.ok(response.status === 409 || response.status === 400, String(response.status));
  assert.equal(readFileSync(target, 'utf8'), 'original');
});

test('the profile reply: the audit of one level only (filtered before the limit), and the state of every assigned element', async (t) => {
  const office = await contextOffice();
  t.after(() => office.close());
  const save = async (scope: string, layer: unknown) => {
    const read = await (await office.call('/api/harness/profile?floor=ample')).json();
    const response = await office.call('/api/harness/profile?floor=ample', { scope, layer, revision: read.revision });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const created = await (await office.call('/api/harness/element?floor=ample', element())).json();
  await save('project', { 'rules.checklist': { resource: created.id } });
  // 25 global saves push the project's one out of the latest 20 of every level.
  for (let i = 0; i < 25; i++) await save('global', { 'house.style': { value: 'v' + i } });
  const everything = await (await office.call('/api/harness/profile?floor=ample')).json();
  assert.ok(!everything.audit.some((a: { level: string }) => a.level === 'project'), 'without the filter the project save is out of the latest 20');
  const own = await (await office.call('/api/harness/profile?floor=ample&auditLevel=project')).json();
  assert.deepEqual(own.audit.map((a: { level: string; slots: string[] }) => [a.level, a.slots]), [['project', ['rules.checklist']]]);
  const global = await (await office.call('/api/harness/profile?floor=ample&auditLevel=global')).json();
  assert.equal(global.audit.length, 20);
  assert.ok(global.audit.every((a: { level: string }) => a.level === 'global'));
  // The tajemstvi floor's project audit never shows ample's.
  const other = await (await office.call('/api/harness/profile?floor=tajemstvi&auditLevel=project')).json();
  assert.deepEqual(other.audit, []);
  assert.deepEqual(new HarnessProfiles(office.dataDir).audit(20, checkout(office.dataDir), true, { level: 'project', node: '' }).map((a) => a.level), ['project']);
  // The assigned elements: the created one available with its revision and digest.
  const states = own.resources;
  assert.equal(states[created.id].status, 'available');
  assert.equal(states[created.id].title, 'checklist.md');
  assert.equal(states[created.id].version, created.entry.version);
  assert.match(states[created.id].digest, /^[0-9a-f]{64}$/);
  // Deleted from the checkout: it resolves as missing, with where it was.
  rmSync(path.join(checkout(office.dataDir), '.harness', 'rules', 'review', 'checklist.md'));
  const after = await (await office.call('/api/harness/profile?floor=ample')).json();
  assert.equal(after.resources[created.id].status, 'missing');
  assert.equal(after.resources[created.id].path, 'rules/review/checklist.md');
});

test('a member never learns a machine element: its assigned state is unknown, not its title or path', async (t) => {
  const home = path.join(os.tmpdir(), 'harness-element-home-' + process.pid + '-' + Date.now());
  mkdirSync(path.join(home, '.claude', 'skills', 'private-skill'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'skills', 'private-skill', 'SKILL.md'), '# Private\n');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  t.after(() => { process.env.HOME = saved.HOME; process.env.USERPROFILE = saved.USERPROFILE; rmSync(home, { recursive: true, force: true }); });
  let member = false;
  const office = await contextOffice({ session: () => (member ? { account: { id: 'mia', role: 'member' } } : {}) });
  t.after(() => office.close());
  const catalog = await (await office.call('/api/harness?floor=ample')).json();
  const skill = catalog.entries.find((e: { title: string }) => e.title === 'private-skill / SKILL.md');
  assert.ok(skill, 'the administrator lists the machine skill');
  const read = await (await office.call('/api/harness/profile?floor=ample')).json();
  assert.equal((await office.call('/api/harness/profile?floor=ample', { scope: 'global', layer: { 'skills.private': { resource: skill.id } }, revision: read.revision })).status, 200);
  const admin = await (await office.call('/api/harness/profile?floor=ample')).json();
  assert.equal(admin.resources[skill.id].status, 'available');
  member = true;
  const view = await (await office.call('/api/harness/profile?floor=ample')).json();
  assert.deepEqual(view.resources[skill.id], { status: 'unknown' });
  assert.ok(!JSON.stringify(view.resources).includes('private-skill'), 'no title or path of a machine element in a member\'s reply');
});

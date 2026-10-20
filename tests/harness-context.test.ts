// The library's context bar on the server (docs/harness.md "Choosing the context"): GET /api/harness/projects
// and GET /api/harness/tree?floor=. Two floors bound to two Opora projects (Ample, Tajemství opory) get
// their own trees and nothing of each other's; an unbound floor and one whose Opora isn't answering get no
// tree and say why; a floor's tree is never handed out under another floor's project; the auth matrix is
// the other harness routes' (signed-in sessions read, nobody else, GET only).
import test from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { contextOffice, canvas, PROJECTS } from './support/harness-context-office.js';
import { harnessTree, treeTrail, walkTree, MAX_TREE_NODES } from '../src/shared/harness-tree.js';
import { oporaKey } from '../src/shared/opora-identity.js';

const names = (tree: { name: string; children: unknown[] }[]): string[] => [...walkTree(tree as never)].map((n) => (n as { name: string }).name);

test('the tree is built from the canvas paths: page › layer › area › sector › task, a root sector is not a level, every key is the project\'s', () => {
  const place = { project: 'p', workspace: 'w' };
  const tree = harnessTree(canvas('Shop', 's'), place);
  assert.equal(tree.length, 1);
  const trail = treeTrail(tree, oporaKey(place, 's-task'));
  assert.deepEqual(trail.map((n) => [n.level, n.name]), [['page', 'Shop page'], ['layer', '[vrstva 01] Shop layer'], ['area', 'Shop area'], ['sector', 'Shop sector'], ['task', 'Shop task']]);
  assert.deepEqual(trail[3].children.map((c) => c.name), ['Shop task', 'Shop second task'], 'siblings sit side by side under their sector');
  assert.ok(!names(tree).includes('Shop'), 'the root sector is the project, not a specialization');
  assert.ok([...walkTree(tree)].every((n) => n.key.startsWith('opora:p:w:')), 'every node is keyed in the bound project and workspace');
  // A card between the page and the layers (a dead end) is left out; an area no sector goes through is placed by its own path.
  const dead = harnessTree([
    { id: 'page', kind: 'node', name: 'Page', parentId: null }, { id: 'mid', kind: 'node', name: 'Mid', parentId: 'page' },
    { id: 'layer', kind: 'node', name: 'Layer', parentId: 'mid' }, { id: 'sector', kind: 'sector', name: 'Sector', parentId: 'layer' },
    { id: 'lonely', kind: 'area', name: 'Lonely area', parentId: null },
  ], place);
  assert.ok(!names(dead).includes('Mid'), 'a dead-end card is not offered');
  assert.ok(names(dead).includes('Lonely area'));
  const big = Array.from({ length: MAX_TREE_NODES + 50 }, (_, i) => ({ id: 'n' + i, kind: 'node', name: 'N' + i, parentId: null }));
  assert.equal([...walkTree(harnessTree(big, place))].length, MAX_TREE_NODES, 'a huge canvas is capped');
});

test('two projects, two trees: Ample\'s floor never sees Tajemství opory\'s nodes and the other way round', async (t) => {
  const office = await contextOffice();
  t.after(() => office.close());
  const ample = await (await office.call('/api/harness/tree?floor=ample')).json();
  const tajemstvi = await (await office.call('/api/harness/tree?floor=tajemstvi')).json();
  assert.equal(ample.status, 'ready');
  assert.deepEqual(ample.binding, { project: PROJECTS.ample.project, workspace: PROJECTS.ample.workspace, projectName: 'Ample' });
  assert.equal(tajemstvi.binding.projectName, 'Tajemství opory');
  const a = names(ample.tree), b = names(tajemstvi.tree);
  assert.ok(a.includes('Ample task') && b.includes('Tajemství task'));
  assert.ok(a.every((n) => !/Tajemství/.test(n)), 'no Tajemství node in Ample\'s tree');
  assert.ok(b.every((n) => !/Ample/.test(n)), 'no Ample node in Tajemství\'s tree');
  assert.ok(JSON.stringify(ample).indexOf('p-tajemstvi') < 0 && JSON.stringify(tajemstvi).indexOf('p-ample') < 0, 'not even the other project\'s id');
  // One floor's tree is never handed out under another floor's project.
  const claimed = await office.call('/api/harness/tree?' + new URLSearchParams({ floor: 'ample', project: PROJECTS.tajemstvi.project, workspace: PROJECTS.tajemstvi.workspace }));
  assert.equal(claimed.status, 403);
  assert.doesNotMatch(await claimed.text(), /Tajemství task|Ample task/);
  const own = await office.call('/api/harness/tree?' + new URLSearchParams({ floor: 'ample', project: PROJECTS.ample.project, workspace: PROJECTS.ample.workspace }));
  assert.equal(own.status, 200, 'naming its own binding is fine');
  // A window that drifted to another project gives no tree at all, rather than that project's canvas under this binding.
  office.windows.ample.project = { id: PROJECTS.tajemstvi.project, name: 'Tajemství opory' };
  office.windows.ample.workspace = PROJECTS.tajemstvi.workspace;
  office.windows.ample.nodes = canvas('Tajemství', 'ta');
  const drifted = await (await office.call('/api/harness/tree?floor=ample')).json();
  assert.equal(drifted.status, 'elsewhere');
  assert.deepEqual(drifted.tree, []);
  assert.match(drifted.notice, /another project or workspace than its binding/);
});

test('an unbound floor and one whose Opora is down: the project level only, with the reason, never a tree', async (t) => {
  const office = await contextOffice();
  t.after(() => office.close());
  const loose = await (await office.call('/api/harness/tree?floor=loose')).json();
  assert.equal(loose.status, 'unbound');
  assert.equal(loose.binding, null);
  assert.deepEqual(loose.tree, [], 'its window reads a canvas, but an unbound floor offers none of it');
  assert.match(loose.notice, /Not linked to an Opora project/);
  const dark = await (await office.call('/api/harness/tree?floor=dark')).json();
  assert.equal(dark.status, 'unreachable');
  assert.deepEqual(dark.tree, []);
  assert.match(dark.notice, /Opora isn't answering \(connect ECONNREFUSED\)/);
  assert.equal(dark.binding.projectName, 'p-dark', 'a project Opora can\'t name shows its id');
  // Ample's Opora going down mid-session takes its tree away too.
  office.windows.ample.connected = false;
  assert.equal((await (await office.call('/api/harness/tree?floor=ample')).json()).status, 'unreachable');
});

test('the projects list: every floor with its binding and status, and the namespaces of the Global view', async (t) => {
  const office = await contextOffice();
  t.after(() => office.close());
  const reply = await (await office.call('/api/harness/projects')).json();
  assert.deepEqual(reply.projects.map((p: { floor: string; name: string; status: string; binding: { projectName: string } | null }) => [p.floor, p.name, p.status, p.binding?.projectName ?? null]), [
    ['ample', 'ample-shop', 'ready', 'Ample'], ['tajemstvi', 'tajemstvi-opory', 'ready', 'Tajemství opory'], ['loose', 'loose-repo', 'unbound', null], ['dark', 'dark-repo', 'unreachable', 'p-dark'],
  ]);
  assert.ok(!JSON.stringify(reply).includes('task'), 'the list carries no tree');
  assert.ok(reply.globalNamespaces.includes('handbook') && !reply.globalNamespaces.includes('project'), 'project elements are never Global');
});

test('auth matrix: signed-in sessions read, nobody else, unknown floors are 404 and only GET is answered', async (t) => {
  let who: string | undefined = 'admin';
  const office = await contextOffice({ session: (_req: http.IncomingMessage) => (who === 'admin' ? {} : who === 'member' ? { account: { id: 'mia', role: 'member' } } : undefined) });
  t.after(() => office.close());
  for (const url of ['/api/harness/tree?floor=ample', '/api/harness/projects']) {
    who = 'admin';
    assert.equal((await office.call(url)).status, 200, url + ' admin');
    who = 'member';
    assert.equal((await office.call(url)).status, 200, url + ' member reads like the profiles');
    assert.equal((await office.call(url, {})).status, 405, url + ' POST');
    who = undefined;
    assert.equal((await office.call(url)).status, 401, url + ' signed out');
  }
  who = 'admin';
  assert.equal((await office.call('/api/harness/tree?floor=nope')).status, 404);
  assert.equal((await office.call('/api/harness/tree')).status, 404);
});

test('a broken bindings file fails closed: no tree, a 503, nothing guessed', async (t) => {
  const office = await contextOffice();
  t.after(() => office.close());
  const { writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  writeFileSync(path.join(office.dataDir, 'harness-bindings.json'), '{not json');
  const tree = await office.call('/api/harness/tree?floor=ample');
  assert.equal(tree.status, 503);
  const list = await (await office.call('/api/harness/projects')).json();
  assert.ok(list.projects.every((p: { status: string }) => p.status === 'error'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import type { GraphRow } from '../src/shared/cleanline.js';
import { buildOutputs, listMerged, outputsBoard, type GhMergedPr } from '../src/server/cleanline/outputs.js';
import { outputsRoutes } from '../src/server/http/routes/outputs.js';
import { routes } from '../src/server/http/routes/index.js';
import type { Runner } from '../src/server/status/git.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const row = (sha: string, subject: string, daysAgo: number, pr?: number): GraphRow =>
  ({ sha, parents: [], subject, author: 'pletor', time: Math.floor((NOW - daysAgo * 86_400_000) / 1000), refs: [], main: true, ...(pr ? { pr } : {}), lane: 0, through: [], merging: [], fromAbove: false, toParents: [], cut: false });
const line = (graph: GraphRow[], url: string | null = 'https://github.com/Pletor/agent-office') =>
  ({ repo: { id: 'floor' as const, dir: '/x', label: 'agent-office', remote: 'fork/main', ...(url ? { url } : {}) }, graph });

const gh = (n: number, daysAgo: number, body?: string): GhMergedPr => ({
  number: n, title: `PR ${n}`, url: `https://github.com/Pletor/agent-office/pull/${n}`, body: body ?? null,
  mergedAt: new Date(NOW - daysAgo * 86_400_000).toISOString(), author: { login: 'pletor' },
  commits: [{ oid: `${n}`.padEnd(40, 'a'), messageHeadline: `commit of ${n}` }], mergeCommit: { oid: `${n}`.padEnd(40, 'f') },
});

test('listMerged asks the GitHub search for PRs merged into main since the day, with fixed arguments', async () => {
  const calls: string[][] = [];
  const node = { number: 5, title: 'x', body: '## Výstup', mergedAt: '2026-10-30T10:00:00Z', commits: { nodes: [{ commit: { oid: 'abc', messageHeadline: 'one' } }, null] } };
  const run: Runner = async (cmd, args) => { calls.push([cmd, ...args]); return JSON.stringify({ data: { search: { nodes: [node, {}, null] } } }); };
  const rows = await listMerged(run, '/x', 'Pletor/agent-office', 'main', new Date('2026-10-24T12:00:00Z'));
  assert.equal(rows?.length, 1);
  assert.deepEqual(rows![0].commits![0], { oid: 'abc', messageHeadline: 'one' });
  assert.deepEqual(calls[0].slice(0, 4), ['gh', 'api', 'graphql', '-f']);
  assert.equal(calls[0][5], '-f');
  assert.equal(calls[0][6], 'q=repo:Pletor/agent-office is:pr is:merged base:main merged:>=2026-10-24');
  assert.equal(await listMerged(async () => { throw new Error('no gh'); }, '/x', 'a/b', 'main', new Date()), undefined);
  assert.equal(await listMerged(async () => '{"errors":[]}', '/x', 'a/b', 'main', new Date()), undefined);
});

test('the board: PRs with and without outputs, newest first, older than 7 days left out', () => {
  const b = buildOutputs(line([]), [gh(3, 2, '## Výstup\nArtefakt: https://claude.ai/artifact/1'), gh(4, 1, 'no section'), gh(1, 9, '## Výstup\nArtefakt: https://claude.ai/a')], NOW);
  assert.deepEqual(b.prs.map((p) => p.number), [4, 3]);
  assert.deepEqual(b.counts, { merged: 2, with: 1, without: 1 });
  assert.equal(b.prs[1].outputs?.artifacts[0], 'https://claude.ai/artifact/1');
  assert.equal(b.prs[0].outputs, undefined);
  assert.equal(b.prs[0].commits[0].subject, 'commit of 4');
  assert.equal(b.prs[0].mainSha, '4'.padEnd(40, 'f'));
  assert.equal(b.repo.main, 'main');
  assert.equal(b.note, undefined);
});

test('nothing slips: a squash on main gh did not name shows as "bez výstupu" with a note', () => {
  const graph = [row('a'.repeat(40), 'feat: x (#9)', 1, 9), row('b'.repeat(40), 'feat: y (#3)', 2, 3), row('c'.repeat(40), 'feat: old (#2)', 8, 2), row('d'.repeat(40), 'chore: no pr', 1)];
  const b = buildOutputs(line(graph), [gh(3, 2, '## Výstup\nPo: ![](https://github.com/a.png)')], NOW);
  assert.deepEqual(b.prs.map((p) => p.number), [9, 3]);
  assert.equal(b.prs[0].title, 'feat: x');
  assert.equal(b.prs[0].url, 'https://github.com/Pletor/agent-office/pull/9');
  assert.match(b.prs[0].note!, /nešlo/);
  assert.deepEqual(b.counts, { merged: 2, with: 1, without: 1 });
  const offline = buildOutputs(line(graph), undefined, NOW);
  assert.equal(offline.counts.merged, 2);
  assert.match(offline.note!, /gh/);
});

test('outputsBoard reads Čistá linie data and gh once per 15 s per repository', async () => {
  let ghCalls = 0;
  const run: Runner = async () => {
    ghCalls++;
    const p = gh(7, 1, '## Výstup\nDiagram: ![](https://raw.githubusercontent.com/o/r/s/d.svg)');
    return JSON.stringify({ data: { search: { nodes: [{ ...p, commits: { nodes: p.commits!.map((c) => ({ commit: c })) } }] } } });
  };
  const t = { id: 'floor' as const, dir: '/tmp/outputs-cache-test', label: 'x' };
  const deps = { run, live: [], now: () => NOW, line: async () => line([]) };
  const a = await outputsBoard(t, deps);
  const b = await outputsBoard(t, deps);
  assert.equal(ghCalls, 1);
  assert.equal(a, b);
  assert.deepEqual(a.prs[0].outputs?.diagrams, [{ url: 'https://raw.githubusercontent.com/o/r/s/d.svg', image: true }]);
  await outputsBoard(t, deps, true);
  assert.equal(ghCalls, 2, 'refresh=1 goes past the cache');
  const noGithub = await outputsBoard({ ...t, dir: '/tmp/outputs-nogh' }, { ...deps, line: async () => line([], null) });
  assert.equal(ghCalls, 2, 'no GitHub remote: gh is not asked');
  assert.match(noGithub.note!, /GitHub/);
});

test('the route is signed-in, GET only, and 404s an unknown floor', async () => {
  const r = outputsRoutes.read;
  assert.equal(r.auth, 'session');
  assert.ok(routes.includes(r));
  const res = () => {
    const out = { status: 0, body: '' };
    return { out, writeHead(s: number) { out.status = s; return this; }, end(b: string) { out.body = b; }, setHeader() {} };
  };
  const ctx = { floors: new Map() } as never;
  const post = res();
  await r.handle(ctx, { req: { method: 'POST' }, res: post, url: new URL('http://x/api/cleanline/outputs'), path: '/api/cleanline/outputs', session: {} } as never);
  assert.equal(post.out.status, 405);
  const get = res();
  await r.handle(ctx, { req: { method: 'GET' }, res: get, url: new URL('http://x/api/cleanline/outputs?floor=nope'), path: '/api/cleanline/outputs', session: {} } as never);
  assert.equal(get.out.status, 404);
});

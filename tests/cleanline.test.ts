import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, prOfSubject, refsOf, topoOrder, type GraphCommit } from '../src/shared/cleanline.js';
import { parseLog } from '../src/server/cleanline/graph.js';
import { buildQueue, mergeRefusal, queueItem, type OpenPr } from '../src/server/cleanline/queue.js';
import { driftFlags, healthFlags, type LineState, type RefInfo, type WtInfo } from '../src/server/cleanline/health.js';
import { cleanupPlan, removeWorktree, runCleanup, type Disk } from '../src/server/cleanline/cleanup.js';
import { runningReasons } from '../src/server/status/rules.js';

let clock = 1000;
const c = (sha: string, parents: string[], main = true, subject = sha): GraphCommit => ({ sha, parents, subject, author: 'a', time: clock--, refs: [], main });

test('a linear main is one lane', () => {
  clock = 1000;
  const { rows, lanes } = layoutGraph([c('c3', ['c2']), c('c2', ['c1']), c('c1', [])]);
  assert.equal(lanes, 1);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
  assert.deepEqual(rows.map((r) => r.fromAbove), [false, true, true]);
  assert.deepEqual(rows.map((r) => r.toParents), [[0], [0], []]);
});

test('a branch off an older main commit gets a side lane that converges into main; its squash is on main', () => {
  clock = 1000;
  const commits = topoOrder([
    c('b2', ['b1'], false), c('m3', ['m2'], true, 'feat: x (#7)'), c('b1', ['m1'], false), c('m2', ['m1']), c('m1', []),
  ]);
  const { rows, lanes } = layoutGraph(commits);
  const at = (s: string) => rows.find((r) => r.sha === s)!;
  assert.equal(lanes, 2);
  assert.equal(at('m3').lane, 0);
  assert.equal(at('m2').lane, 0);
  assert.equal(at('b2').lane, 1);
  assert.equal(at('b1').lane, 1);
  assert.equal(at('m1').lane, 0);
  assert.deepEqual(at('m1').merging, [1], 'the branch lane ends in its fork point');
  assert.equal(at('m3').pr, undefined, 'pr is parsed when reading the log, not in layout');
  assert.equal(prOfSubject('feat: x (#7)'), 7);
  // Children always come before parents.
  const idx = new Map(rows.map((r, i) => [r.sha, i]));
  for (const r of rows) for (const p of r.parents) assert.ok(idx.get(p)! > idx.get(r.sha)!);
});

test('a merge commit opens a lane for its second parent and joins it back', () => {
  clock = 1000;
  const { rows } = layoutGraph([c('M', ['m1', 'f2']), c('f2', ['f1']), c('f1', ['m0']), c('m1', ['m0']), c('m0', [])]);
  const at = (s: string) => rows.find((r) => r.sha === s)!;
  assert.deepEqual(at('M').toParents, [0, 1]);
  assert.equal(at('f2').lane, 1);
  assert.equal(at('f1').lane, 1);
  assert.equal(at('m1').lane, 0);
  assert.deepEqual(at('m1').through, [1]);
  assert.deepEqual(at('m0').merging, [1]);
});

test('a stacked branch (B on A on main) takes its own lanes and joins A', () => {
  clock = 1000;
  const commits = topoOrder([c('b1', ['a2'], false), c('a2', ['a1'], false), c('a1', ['m1'], false), c('m2', ['m1']), c('m1', [])]);
  const { rows } = layoutGraph(commits);
  const at = (s: string) => rows.find((r) => r.sha === s)!;
  assert.ok(at('b1').lane > 0 && at('a1').lane > 0);
  assert.equal(at('a2').lane, at('b1').lane, 'A continues the lane B came down');
  assert.equal(at('m1').lane, 0);
});

test('git log records parse into commits with refs and PR numbers; a window cut is marked', () => {
  const out = 'aaaaaaa1\x1fbbbbbbb2\x1ffeat: board (#12)\x1fMartin\x1f1700000000\x1fHEAD -> main, fork/main, tag: v1\x1e\nbbbbbbb2\x1fccccccc3\x1fold\x1fM\x1f1690000000\x1f\x1e';
  const list = parseLog(out, true);
  assert.equal(list.length, 2);
  assert.equal(list[0].pr, 12);
  assert.deepEqual(list[0].refs, ['main', 'fork/main', 'v1']);
  assert.deepEqual(refsOf('HEAD, origin/HEAD'), []);
  const { rows } = layoutGraph(list);
  assert.equal(rows[1].cut, true);
});

const pr = (n: number, over: Partial<OpenPr> = {}): OpenPr => ({ number: n, title: `PR ${n}`, headRefName: `b${n}`, baseRefName: 'main', isDraft: false, reviewDecision: '', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', createdAt: `2026-10-${String(10 + n).padStart(2, '0')}T00:00:00Z`, statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }], ...over });

test('the queue puts green PRs first, oldest first, and flags stacked, behind, conflicting and draft ones', () => {
  const q = buildQueue([
    pr(5),
    pr(1, { baseRefName: 'feat/a' }),
    pr(2, { mergeStateStatus: 'BEHIND' }),
    pr(3, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
    pr(4),
    pr(6, { isDraft: true }),
    pr(7, { statusCheckRollup: [{ conclusion: 'FAILURE' }] , mergeStateStatus: 'UNSTABLE' }),
    pr(8, { reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED' }),
  ]);
  assert.deepEqual(q.slice(0, 2).map((x) => [x.number, x.green]), [[4, true], [5, true]]);
  assert.equal(q[2].number, 2, 'behind is nearest to green');
  const by = (n: number) => q.find((x) => x.number === n)!;
  assert.ok(by(1).flags.includes('stacked') && !by(1).green);
  assert.ok(by(3).flags.includes('conflict'));
  assert.ok(by(6).flags.includes('draft'));
  assert.ok(by(7).flags.includes('checks-fail'));
  assert.ok(by(8).flags.includes('changes-requested'));
  assert.ok(!queueItem(pr(9, { statusCheckRollup: [{ status: 'IN_PROGRESS' }] })).green, 'running checks are not green');
  assert.ok(!queueItem(pr(9, { mergeStateStatus: 'UNKNOWN' })).green, 'GitHub must say CLEAN');
});

test('the merge guard refuses a PR that is not the head, or a head that is not green', () => {
  const q = buildQueue([pr(4), pr(5)]);
  assert.equal(mergeRefusal(q, 4), undefined);
  assert.match(mergeRefusal(q, 5)!, /není na řadě/);
  const red = buildQueue([pr(4, { mergeStateStatus: 'BEHIND' })]);
  assert.match(mergeRefusal(red, 4)!, /není zelený/);
  assert.match(mergeRefusal([], 4)!, /prázdná/);
});

const ref = (name: string, over: Partial<RefInfo> = {}): RefInfo => ({ name, local: `${name}-sha`, idleH: 1, ahead: 2, localMerged: false, ...over });
const wt = (path: string, over: Partial<WtInfo> = {}): WtInfo => ({ path, dirty: 0, primary: false, idleH: 1, ...over });
const line = (over: Partial<LineState> = {}): LineState => ({ dir: '/repo', remote: 'fork/main', mainName: 'main', mainSha: 'f'.repeat(40), refs: [], worktrees: [wt('/repo', { primary: true })], protect: ['/repo'], ...over });

test('health flags stacked PRs, far-behind branches, merged leftovers, orphans, a dirty main checkout and drift', () => {
  const s = line({
    refs: [
      ref('old', { behind: 40 }),
      ref('done', { localMerged: true, remote: 'x', remoteMerged: true, pr: { number: 9, state: 'MERGED', headRefName: 'done' } }),
      ref('fresh', { ahead: 0, localMerged: true, idleH: 2 }),
    ],
    worktrees: [wt('/repo', { primary: true, dirty: 3 }), wt('/wt/done', { branch: 'done' }), wt('/wt/gone', { branch: 'gone' }), wt('/wt/fresh', { branch: 'fresh' }), wt('/wt/busy', { branch: 'done', worker: 'Ada' })],
  });
  const q = buildQueue([pr(1, { baseRefName: 'old' })]);
  const flags = healthFlags(s, q, { mainSha: 'a'.repeat(40), serverSha: 'a'.repeat(40), clientSha: 'b'.repeat(40), dev: false });
  const kinds = flags.map((f) => f.kind);
  assert.equal(flags[0].level, 'bad');
  for (const k of ['stacked', 'behind', 'merged-not-deleted', 'orphan-worktree', 'dirty-main', 'drift-client'] as const) assert.ok(kinds.includes(k), k);
  assert.ok(!flags.some((f) => f.where === '/wt/fresh'), 'a fresh empty worktree is not an orphan');
  assert.ok(!flags.some((f) => f.where === '/wt/busy'), "a live worker's worktree is not an orphan");
  assert.ok(!flags.some((f) => f.where === 'fresh'), 'a fresh empty branch is not a leftover');
  assert.equal(healthFlags(line(), [])[0].level, 'ok');
});

test('a stale client after a merge is drift even when the server is fresh', () => {
  const sha = 'a'.repeat(40);
  const flags = driftFlags({ mainSha: sha, serverSha: sha, serverBuilt: sha, clientSha: 'b'.repeat(40), dev: false });
  assert.deepEqual(flags.map((f) => [f.kind, f.level]), [['drift-client', 'bad']]);
  assert.deepEqual(driftFlags({ mainSha: sha, serverSha: sha, clientSha: sha, dev: false }), []);
  // The status wall says so too, also when the server runs from the sources.
  const reasons = runningReasons({ sha, dev: true, client: { sha: 'b'.repeat(40) } }, 'fork/main', sha);
  assert.ok(reasons.some((r) => /Klient \(dist\/public\)/.test(r.text) && r.level === 'warn'));
});

test('the cleanup plan never touches main, the checked-out branch, dirty or live worktrees, or open PRs', () => {
  const merged = (name: string, over: Partial<RefInfo> = {}) => ref(name, { localMerged: true, remote: `${name}-r`, remoteMerged: true, pr: { number: 1, state: 'MERGED', headRefName: name }, ...over });
  const s = line({
    current: 'cur',
    refs: [
      merged('ok'), merged('cur'), merged('live', { worker: 'Ada' }), merged('held'), merged('going'),
      ref('open', { localMerged: true, pr: { number: 2, state: 'OPEN', headRefName: 'open' } }),
      ref('wip'),
    ],
    worktrees: [
      wt('/repo', { primary: true, branch: 'cur', dirty: 2 }),
      wt('/wt/held', { branch: 'held', dirty: 1 }),
      wt('/wt/going', { branch: 'going' }),
      wt('/wt/live', { branch: 'live', worker: 'Ada' }),
    ],
  });
  const plan = cleanupPlan(s);
  const keys = plan.items.map((i) => `${i.kind}:${i.name}`).sort();
  assert.deepEqual(keys, ['branch:going', 'branch:ok', 'remote-branch:going', 'remote-branch:held', 'remote-branch:ok', 'worktree:/wt/going']);
  const kept = plan.kept.map((k) => k.name);
  for (const k of ['cur', 'live', 'held', '/wt/held', 'open']) assert.ok(kept.includes(k), k);
  assert.ok(!plan.items.some((i) => i.name === 'main' || i.name === '/repo'));
});

test('cleanup runs only confirmed items still in a fresh plan, backs every branch up first, and removes a junction node_modules before the worktree', async () => {
  const calls: string[] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    return '';
  };
  const s = line({
    refs: [ref('done', { localMerged: true, pr: { number: 3, state: 'MERGED', headRefName: 'done' } })],
    worktrees: [wt('/repo', { primary: true }), wt('/wt/done', { branch: 'done' })],
  });
  const disk: Disk = { isLink: (p) => /node_modules$/.test(p), exists: () => false, rmTree: () => assert.fail('no fallback needed') };
  const plan = cleanupPlan(s);
  const r = await runCleanup(s, [...plan.items.map((i) => i.key), 'branch:main@x', 'branch:done@stale'], { run, disk, now: new Date('2026-10-22T10:00:00Z') });
  assert.equal(r.done.length, 2);
  assert.equal(r.skipped.length, 2, 'unknown or changed keys are skipped');
  const i = (re: RegExp) => calls.findIndex((x) => re.test(x));
  assert.ok(i(/node_modules/) < i(/worktree remove/), 'junction first');
  assert.ok(i(/update-ref refs\/cleanline-backup\/20261022T100000\/done done-sha/) >= 0);
  assert.ok(i(/update-ref/) < i(/branch -D done/), 'backup before delete');
  assert.match(r.backup!, /refs\/cleanline-backup\/20261022T100000/);
});

test('a worktree git refuses for uncommitted work is never force-deleted; a long-path failure falls back to \\\\?\\ and a prune', async () => {
  let removed = '';
  const disk: Disk = { isLink: () => false, exists: () => true, rmTree: (p) => { removed = p; } };
  await assert.rejects(removeWorktree(async (_c, a) => { if (a.includes('remove')) throw new Error("fatal: '/wt' contains modified or untracked files"); return ''; }, '/repo', '/wt', disk));
  assert.equal(removed, '');
  const calls: string[] = [];
  await removeWorktree(async (_c, a) => { calls.push(a.join(' ')); if (a.includes('remove')) throw new Error('Filename too long'); return ''; }, '/repo', '/wt', disk);
  assert.equal(removed, '/wt');
  assert.ok(calls.includes('worktree prune'));
});

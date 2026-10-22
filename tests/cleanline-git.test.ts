import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLine } from '../src/server/cleanline/state.js';
import { readGraph } from '../src/server/cleanline/graph.js';
import { cleanupPlan, runCleanup } from '../src/server/cleanline/cleanup.js';
import { healthFlags } from '../src/server/cleanline/health.js';
import { execRunner } from '../src/server/status/index.js';

/** A repository with a bare remote: a squash-merged branch with a worktree, an open branch, a dirty worktree. */
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'cleanline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  const bare = path.join(root, 'remote.git');
  const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const put = (cwd: string, f: string, text: string) => writeFileSync(path.join(cwd, f), text);
  put(dir, 'a.txt', 'a\n');
  g(dir, 'add', '.');
  g(dir, 'commit', '-qm', 'init');
  g(dir, 'remote', 'add', 'fork', bare);
  // Done: a branch whose change went into main as a squash.
  g(dir, 'switch', '-qc', 'done');
  put(dir, 'b.txt', 'b\n');
  g(dir, 'add', '.');
  g(dir, 'commit', '-qm', 'b one');
  g(dir, 'switch', '-q', 'main');
  g(dir, 'merge', '--squash', '-q', 'done');
  g(dir, 'commit', '-qm', 'feat: b (#1)');
  // Open: work main doesn't have.
  g(dir, 'switch', '-qc', 'open');
  put(dir, 'c.txt', 'c\n');
  g(dir, 'add', '.');
  g(dir, 'commit', '-qm', 'c work');
  g(dir, 'switch', '-q', 'main');
  g(dir, 'push', '-q', 'fork', 'main', 'done', 'open');
  g(dir, 'fetch', '-q', 'fork');
  const wtDone = path.join(root, 'wt-done');
  const wtOpen = path.join(root, 'wt-open');
  g(dir, 'worktree', 'add', '-q', wtDone, 'done');
  g(dir, 'worktree', 'add', '-q', wtOpen, 'open');
  put(wtOpen, 'c.txt', 'changed\n');
  return { dir, wtDone, wtOpen };
}

test('a real repository: squash-merged branches are found, the graph has main and a side lane, and Uklidit removes only them', async (t) => {
  const { dir, wtDone, wtOpen } = fixture(t);
  const state = await readLine(execRunner, dir, { remote: 'fork/main', live: [], protect: [dir] });
  const done = state.refs.find((r) => r.name === 'done')!;
  assert.equal(done.localMerged, true, 'squash detected');
  assert.equal(done.remoteMerged, true);
  assert.equal(state.refs.find((r) => r.name === 'open')!.localMerged, false);
  assert.equal(state.worktrees.find((w) => w.branch === 'open')!.dirty, 1);

  const graph = await readGraph(execRunner, dir, 'refs/remotes/fork/main', ['refs/heads/open']);
  assert.equal(graph.lanes, 2);
  assert.equal(graph.rows.find((r) => r.subject === 'feat: b (#1)')!.pr, 1);
  assert.ok(graph.rows.find((r) => r.subject === 'c work')!.lane > 0);

  const flags = healthFlags(state, []);
  assert.ok(flags.some((f) => f.kind === 'merged-not-deleted' && f.where === 'done'));
  const plan = cleanupPlan(state);
  assert.deepEqual(plan.items.map((i) => `${i.kind}:${i.kind === 'worktree' ? path.basename(i.name) : i.name}`).sort(), ['branch:done', 'remote-branch:done', 'worktree:wt-done']);

  const r = await runCleanup(state, plan.items.map((i) => i.key), { run: execRunner });
  assert.equal(r.skipped.length, 0, JSON.stringify(r.skipped));
  assert.equal(existsSync(wtDone), false);
  assert.equal(existsSync(wtOpen), true, 'the open, dirty worktree stays');
  const refs = execFileSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: dir, encoding: 'utf8' });
  assert.doesNotMatch(refs, /refs\/heads\/done\n/);
  assert.doesNotMatch(refs, /refs\/remotes\/fork\/done\n/);
  assert.match(refs, /refs\/cleanline-backup\/\d{8}T\d{6}\/done\n/);
  assert.match(refs, /refs\/cleanline-backup\/\d{8}T\d{6}\/remote\/done\n/);
  assert.match(refs, /refs\/heads\/open\n/);
});

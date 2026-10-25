import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveArgs } from '../src/server/opora/conflict-resolver.js';
import { bisect, ciState, MergeGuard } from '../src/server/opora/merge-guard.js';
import { isOporaPr, NEEDS_HUMAN, PrUpkeep, type OporaPr } from '../src/server/opora/pr-upkeep.js';
import { upkeepConfig, type UpkeepConfig } from '../src/server/opora/upkeep-config.js';
import { createOporaUpkeep, OporaUpkeep } from '../src/server/opora/upkeep-runner.js';
import { executionOf, UpkeepLedger, type UpkeepTools } from '../src/server/opora/upkeep-tools.js';
import { upkeepEvents } from '../src/server/process/opora-events.js';

const BASE = 'b'.repeat(40), HEAD = 'h'.repeat(40), NEW = 'n'.repeat(40);
const config = (over: Partial<UpkeepConfig> = {}): UpkeepConfig => ({ ...upkeepConfig({ AGENT_OFFICE_OPORA_UPKEEP: 'on', AGENT_OFFICE_OPORA_GUARD: 'on', AGENT_OFFICE_OPORA_CHECK_COMMAND: 'npm test' }), ...over });
const pr = (over: Partial<OporaPr> = {}): OporaPr => ({ number: 7, url: 'https://github.com/Pletor/shop/pull/7', title: 'Opora: Cart', body: 'x\n\nOpora-Execution: exec-1',
  headRefName: 'opora/card/exec-1', baseRefName: 'main', headRefOid: HEAD, ...over });
const quiet = () => {};

function root(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-upkeep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Fake git, gh, checks and resolver for one PR. `conflicts` lists the files each conflicted rebase step
 * leaves unmerged (the first from `rebase`, the next from each `--continue`); `resolver` edits them.
 */
function prFakes(opts: { conflicts?: string[][]; check?: boolean; resolver?: (cwd: string, prompt: string) => void; behind?: boolean; prs?: OporaPr[] } = {}) {
  const git: string[][] = [], gh: string[][] = [], resolves: string[] = [];
  const queue = [...(opts.conflicts ?? [])];
  let unmerged: string[] = [];
  let tree = '';
  const step = () => { const next = queue.shift(); unmerged = next ?? []; if (next) throw new Error('CONFLICT'); };
  const tools: UpkeepTools = {
    git: async (args, cwd) => {
      git.push(args);
      if (args[0] === 'worktree' && args[1] === 'add') { tree = args[4]!; mkdirSync(tree, { recursive: true }); }
      if (args[0] === 'rev-parse') return args[1]!.endsWith('/base') ? BASE : args[1] === 'HEAD' ? NEW : HEAD;
      if (args[0] === 'merge-base') { if (opts.behind === false) return ''; throw new Error('not ancestor'); }
      if (args[0] === 'rebase' && args[1] === BASE) step();
      if (args.includes('--continue')) step();
      if (args[0] === 'diff' && args.includes('--diff-filter=U')) return unmerged.join('\n');
      if (args[0] === 'remote') return 'git@github.com:Pletor/shop.git';
      void cwd;
      return '';
    },
    gh: async (args) => {
      gh.push(args);
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(opts.prs ?? [pr()]);
      return '';
    },
    check: async () => ({ ok: opts.check !== false, output: opts.check === false ? 'FAIL cart.test.ts' : 'ok' }),
    resolve: async ({ cwd, prompt }) => { resolves.push(prompt); opts.resolver?.(cwd, prompt); return 'kept both'; },
  };
  return { tools, git, gh, resolves, tree: () => tree };
}
const pushes = (git: string[][]) => git.filter((a) => a[0] === 'push');
const comments = (gh: string[][]) => gh.filter((a) => a[0] === 'pr' && a[1] === 'comment');

test('Opora PRs are found by branch prefix or trailer; config is off by default with bounded budgets', () => {
  assert.ok(isOporaPr({ headRefName: 'opora/c/e', body: '' }));
  assert.ok(isOporaPr({ headRefName: 'feature', body: 'text\nOpora-Execution: e-9' }));
  assert.ok(!isOporaPr({ headRefName: 'feature', body: 'mentions Opora-Execution: inline' }));
  assert.equal(executionOf('a\nOpora-Execution: exec-1\nOpora-Card: c'), 'exec-1');
  const off = upkeepConfig({});
  assert.equal(off.upkeep, false);
  assert.equal(off.guard, false);
  assert.equal(off.checkCommand, undefined);
  assert.equal(upkeepConfig({ AGENT_OFFICE_OPORA_UPKEEP_ATTEMPTS: '99' }).attemptsPerHead, 10);
  assert.equal(upkeepConfig({ AGENT_OFFICE_OPORA_GUARD_BRANCH: '../evil' }).guardBranch, 'main');
  const args = resolveArgs();
  for (const flag of ['-p', '--no-session-persistence', '--strict-mcp-config']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Edit,Write,Grep,Glob');
});

test('the disabled flag starts nothing and a pass does nothing', async t => {
  assert.equal(createOporaUpkeep(root(t), root(t), quiet, {}), undefined);
  const f = prFakes();
  const upkeep = new OporaUpkeep(config({ upkeep: false, guard: false }), root(t), root(t), f.tools, quiet, new UpkeepLedger());
  assert.deepEqual(await upkeep.tick(), { skipped: 'off' });
  assert.equal(f.git.length + f.gh.length, 0);
});

test('a pass skips cleanly without gh auth, saying so once', async t => {
  const said: string[] = [];
  const f = prFakes();
  f.tools.gh = async (args) => { if (args[0] === 'auth') throw new Error('not logged in'); return '[]'; };
  const upkeep = new OporaUpkeep(config(), root(t), root(t), f.tools, (m) => said.push(m), new UpkeepLedger());
  assert.match((await upkeep.tick()).skipped ?? '', /gh isn't signed in/);
  await upkeep.tick();
  assert.equal(said.length, 1);
});

test('a PR behind its base is rebased cleanly, checked and pushed with a lease on the head it read', async t => {
  const f = prFakes();
  const up = new PrUpkeep(config(), f.tools, new UpkeepLedger(), quiet);
  const out = await up.pass('Pletor/shop', root(t), root(t));
  assert.deepEqual(out, [{ number: 7, state: 'rebased' }]);
  assert.deepEqual(pushes(f.git), [['push', `--force-with-lease=refs/heads/opora/card/exec-1:${HEAD}`, 'origin', 'HEAD:refs/heads/opora/card/exec-1']]);
  assert.equal(f.resolves.length, 0);
  assert.equal(comments(f.gh).length, 0);
  assert.ok(!f.git.some((a) => a.includes('merge') && a[0] === 'pr'), 'never merges');
});

test('a PR already on its base, or not Opora\'s, is left alone', async t => {
  const f = prFakes({ behind: false, prs: [pr(), pr({ number: 8, headRefName: 'feature', body: '' })] });
  const out = await new PrUpkeep(config(), f.tools, new UpkeepLedger(), quiet).pass('Pletor/shop', root(t), root(t));
  assert.deepEqual(out, [{ number: 7, state: 'current' }]);
  assert.equal(pushes(f.git).length, 0);
});

test('a textual conflict goes to a fresh resolver, then the checks gate the push and the PR is told', async t => {
  const f = prFakes({ conflicts: [['src/cart.ts'], ['src/api.ts']], resolver: (cwd, prompt) => {
    for (const file of prompt.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2))) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), 'merged\n');
    }
  } });
  const out = await new PrUpkeep(config(), f.tools, new UpkeepLedger(), quiet).pass('Pletor/shop', root(t), root(t));
  assert.deepEqual(out, [{ number: 7, state: 'resolved' }]);
  assert.equal(f.resolves.length, 2, 'one fresh run per conflicted step');
  assert.ok(f.git.some((a) => a[0] === 'add' && a.includes('src/cart.ts')));
  assert.equal(pushes(f.git).length, 1);
  assert.match(comments(f.gh)[0]!.at(-1)!, /Claude resolved textual conflicts[\s\S]*src\/cart\.ts[\s\S]*src\/api\.ts/);
});

test('a resolved conflict whose checks fail is not pushed: the PR gets a human comment and label', async t => {
  const f = prFakes({ conflicts: [['a.ts']], check: false, resolver: (cwd) => writeFileSync(path.join(cwd, 'a.ts'), 'ok\n') });
  const out = await new PrUpkeep(config(), f.tools, new UpkeepLedger(), quiet).pass('Pletor/shop', root(t), root(t));
  assert.equal(out[0]!.state, 'human');
  assert.equal(pushes(f.git).length, 0);
  assert.match(comments(f.gh)[0]!.at(-1)!, /npm test` failed twice after the rebase[\s\S]*FAIL cart\.test\.ts/);
  assert.ok(f.gh.some((a) => a[1] === 'edit' && a.includes(NEEDS_HUMAN)));
});

test('a conflict the resolver leaves markers in is aborted for a human, and that head is not tried again', async t => {
  const f = prFakes({ conflicts: [['a.ts']], resolver: (cwd) => writeFileSync(path.join(cwd, 'a.ts'), '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> pr\n') });
  const ledger = new UpkeepLedger();
  const up = new PrUpkeep(config(), f.tools, ledger, quiet);
  const out = await up.pass('Pletor/shop', root(t), root(t));
  assert.equal(out[0]!.state, 'human');
  assert.match(out[0]!.reason ?? '', /conflict markers left in a\.ts/);
  assert.ok(f.git.some((a) => a[0] === 'rebase' && a[1] === '--abort'));
  assert.equal(pushes(f.git).length, 0);
  assert.match(comments(f.gh)[0]!.at(-1)!, /Conflicted files:\n- `a\.ts`/);
  const again = await up.pass('Pletor/shop', root(t), root(t));
  assert.deepEqual(again, [{ number: 7, state: 'skipped', reason: 'waiting for a human' }]);
  assert.equal(f.resolves.length, 1);
});

test('with the LLM fallback off a conflict goes straight to a human', async t => {
  const f = prFakes({ conflicts: [['a.ts']] });
  const out = await new PrUpkeep(config({ resolve: false }), f.tools, new UpkeepLedger(), quiet).pass('Pletor/shop', root(t), root(t));
  assert.equal(out[0]!.state, 'human');
  assert.equal(f.resolves.length, 0);
});

test('ci state and bisect: the first bad commit among N', async () => {
  assert.equal(ciState([]).state, 'none');
  assert.equal(ciState([{ name: 'a', status: 'completed', conclusion: 'success' }, { name: 'b', status: 'in_progress', conclusion: null }]).state, 'pending');
  assert.deepEqual(ciState([{ name: 'test', status: 'completed', conclusion: 'failure' }]), { state: 'red', failing: ['test'] });
  const commits = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
  for (let bad = 0; bad < commits.length; bad++) {
    const probed: string[] = [];
    const found = await bisect(commits, async (sha) => { probed.push(sha); return commits.indexOf(sha) >= bad ? 'red' : 'green'; });
    assert.deepEqual(found, { index: bad });
    assert.ok(probed.length <= 3, `log2 probes, got ${probed.length}`);
  }
});

/** Fake git and gh for the guard: main at `c6`, last green `c0`, `c4` the first bad one (an Opora merge). */
function guardFakes(opts: { ci: Record<string, 'green' | 'red' | 'none'>; existing?: boolean }) {
  const shas = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((s) => s.padEnd(40, '0'));
  const git: string[][] = [], gh: string[][] = [], local: string[] = [];
  let at = '';
  const run = (state: string) => state === 'none' ? [] : [{ name: 'test', status: 'completed', conclusion: state === 'green' ? 'success' : 'failure' }];
  const tools: UpkeepTools = {
    git: async (args) => {
      git.push(args);
      if (args[0] === 'rev-parse') return shas[6]!;
      if (args[0] === 'worktree' && args[1] === 'add') at = args[5]!;
      if (args[0] === 'rev-list' && args.includes('--reverse')) return shas.slice(1).join('\n');
      if (args[0] === 'rev-list' && args.includes('--parents')) return `${args.at(-1)} ${shas[3]} ${'f'.repeat(40)}`;
      if (args[0] === 'rev-list') return [...shas].reverse().join('\n');
      if (args[0] === 'log' && args.includes('--format=%B')) return args.at(-1) === shas[4] ? 'Merge pull request #12 from opora/card/exec-4\n\nOpora-Execution: exec-4\n' : 'human change\n';
      if (args[0] === 'log') return 'Opora: Cart page (#12)';
      return '';
    },
    gh: async (args) => {
      gh.push(args);
      const m = /commits\/(\w+)\/check-runs/.exec(args[1] ?? '');
      if (m) return JSON.stringify({ check_runs: run(opts.ci[m[1]!.slice(0, 2)] ?? 'none') });
      if (/commits\/\w+\/pulls/.test(args[1] ?? '')) return '[]';
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(opts.existing ? [{ number: 99, url: 'https://github.com/Pletor/shop/pull/99' }] : []);
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/Pletor/shop/pull/50\n';
      return '';
    },
    check: async () => { local.push(at); return { ok: shas.indexOf(at) < 4, output: '' }; },
    resolve: async () => '',
  };
  return { tools, git, gh, local, shas };
}

test('a red main is bisected to the first bad Opora merge (CI results first, a local run where missing) and a revert PR is opened once', async t => {
  const f = guardFakes({ ci: { c0: 'green', c1: 'green', c2: 'green', c3: 'none', c4: 'red', c5: 'red', c6: 'red' } });
  const ledger = new UpkeepLedger(path.join(root(t), 'state.json'));
  const guard = new MergeGuard(config(), f.tools, ledger, quiet);
  const out = await guard.pass('Pletor/shop', root(t), root(t));
  assert.equal(out.state, 'reverted');
  assert.equal((out as { culprit: string }).culprit, f.shas[4]);
  assert.deepEqual(f.local, [f.shas[3]], 'only the commit CI has no result for ran locally');
  const revert = f.git.find((a) => a[0] === 'revert')!;
  assert.deepEqual(revert, ['revert', '--no-edit', '-m', '1', f.shas[4]]);
  const amend = f.git.find((a) => a[0] === 'commit')!.at(-1)!;
  assert.ok(amend.endsWith(`Opora-Revert-Of: ${f.shas[4]}\nOpora-Execution: exec-4`));
  const create = f.gh.find((a) => a[1] === 'create')!;
  assert.equal(create[create.indexOf('--head') + 1], `opora-revert/${f.shas[4]!.slice(0, 12)}`);
  const body = create[create.indexOf('--body') + 1]!;
  assert.match(body, /← first bad/);
  assert.match(body, /\| local \|/);
  assert.ok(body.endsWith(`Opora-Revert-Of: ${f.shas[4]}\nOpora-Execution: exec-4`));
  assert.ok(!f.gh.some((a) => a.includes('merge')), 'never merges');

  // Idempotent: the same red head is not bisected again, and a fresh ledger finds the PR already open.
  const creates = () => f.gh.filter((a) => a[1] === 'create').length;
  assert.equal((await guard.pass('Pletor/shop', root(t), root(t))).state, 'handled');
  const g2 = guardFakes({ ci: { c0: 'green', c1: 'green', c2: 'green', c3: 'none', c4: 'red', c5: 'red', c6: 'red' }, existing: true });
  const again = await new MergeGuard(config(), g2.tools, new UpkeepLedger(), quiet).pass('Pletor/shop', root(t), root(t));
  assert.equal(again.state, 'reused');
  assert.equal(g2.gh.filter((a) => a[1] === 'create').length, 0);
  assert.equal(creates(), 1);
});

test('a first bad commit that is not an Opora merge is reported, not reverted; green main resets', async t => {
  const f = guardFakes({ ci: { c0: 'green', c1: 'green', c2: 'red', c3: 'red', c4: 'red', c5: 'red', c6: 'red' } });
  const ledger = new UpkeepLedger();
  const out = await new MergeGuard(config(), f.tools, ledger, quiet).pass('Pletor/shop', root(t), root(t));
  assert.equal(out.state, 'not-opora');
  assert.equal(f.gh.filter((a) => a[1] === 'create').length, 0);
  const green = guardFakes({ ci: { c6: 'green' } });
  assert.equal((await new MergeGuard(config(), green.tools, ledger, quiet).pass('Pletor/shop', root(t), root(t))).state, 'green');
  assert.equal(ledger.lastGreen, green.shas[6]);
  assert.equal(ledger.handledRed, undefined);
});

// watch-wave1 F22: "needs a human" raised on a failure the next pass (or another office keeping the
// same repository) fixed a minute later, and never taken back.
test('a check that fails once and passes on its retry is pushed, with no human notice', async t => {
  const f = prFakes();
  let n = 0;
  f.tools.check = async () => ({ ok: ++n > 1, output: n > 1 ? 'ok' : 'EBUSY' });
  const out = await new PrUpkeep(config(), f.tools, new UpkeepLedger(), quiet).pass('Pletor/shop', root(t), root(t));
  assert.deepEqual(out, [{ number: 7, state: 'rebased' }]);
  assert.equal(n, 2);
  assert.equal(pushes(f.git).length, 1);
  assert.equal(comments(f.gh).length, 0);
});

test('a failure while someone else moved the head is skipped, not left to a human', async t => {
  const f = prFakes({ check: false });
  const git = f.tools.git;
  f.tools.git = async (args, cwd) => (args[0] === 'ls-remote' ? `${'f'.repeat(40)}\trefs/heads/opora/card/exec-1` : git(args, cwd));
  const out = await new PrUpkeep(config(), f.tools, new UpkeepLedger(), quiet).pass('Pletor/shop', root(t), root(t));
  assert.deepEqual(out, [{ number: 7, state: 'skipped', reason: 'its head moved while upkeep checked it' }]);
  assert.equal(comments(f.gh).length, 0);
  assert.ok(!f.gh.some((a) => a.includes(NEEDS_HUMAN)));
  // A push race (another office pushed first) is the same.
  const g = prFakes();
  const gitG = g.tools.git;
  g.tools.git = async (args, cwd) => {
    if (args[0] === 'push') throw new Error('! [rejected] HEAD -> opora/card/exec-1 (stale info)');
    return args[0] === 'ls-remote' ? `${'f'.repeat(40)}\trefs/heads/opora/card/exec-1` : gitG(args, cwd);
  };
  const raced = await new PrUpkeep(config({ attemptsPerHead: 1 }), g.tools, new UpkeepLedger(), quiet).pass('Pletor/shop', root(t), root(t));
  assert.deepEqual(raced, [{ number: 7, state: 'skipped', reason: 'its head moved while upkeep worked on it' }]);
  assert.equal(comments(g.gh).length, 0);
});

test('a later pass that finds the PR up to date takes the "needs a human" notice back: label off, comment withdrawn', async t => {
  const notice = "🛰️ Agent Office couldn't bring this pull request up to date with `main`: `npm test` failed twice after the rebase.";
  const f = prFakes({ behind: false, prs: [pr({ labels: [{ name: NEEDS_HUMAN }] })] });
  const gh = f.tools.gh;
  f.tools.gh = async (args, cwd) => {
    if (args[0] === 'api' && args.includes('--paginate')) { f.gh.push(args); return [JSON.stringify({ id: 41, body: notice }), JSON.stringify({ id: 42, body: 'other comment' })].join('\n'); }
    return gh(args, cwd);
  };
  const said: string[] = [];
  const out = await new PrUpkeep(config(), f.tools, new UpkeepLedger(), (m) => said.push(m)).pass('Pletor/shop', root(t), root(t));
  assert.deepEqual(out, [{ number: 7, state: 'current', cleared: true }]);
  assert.ok(f.gh.some((a) => a[1] === 'edit' && a.includes('--remove-label') && a.includes(NEEDS_HUMAN)));
  const patches = f.gh.filter((a) => a[0] === 'api' && a.includes('PATCH'));
  assert.equal(patches.length, 1);
  assert.equal(patches[0][3], 'repos/Pletor/shop/issues/comments/41');
  assert.match(patches[0].at(-1)!, /^body=> ✅ \*\*No longer needs a human\.\*\*[\s\S]*<details><summary>The original notice<\/summary>[\s\S]*failed twice after the rebase/);
  assert.match(said.join('\n'), /no longer needs a human/);
  // The wall gets the withdrawal next to the pass.
  const events = upkeepEvents({ upkeep: out });
  assert.deepEqual(events.map((e) => [e.state, e.title]), [['ok', 'PR #7: člověk už není potřeba']]);
  // Without the notice, a current PR stays quiet.
  const g = prFakes({ behind: false });
  assert.deepEqual(await new PrUpkeep(config(), g.tools, new UpkeepLedger(), quiet).pass('Pletor/shop', root(t), root(t)), [{ number: 7, state: 'current' }]);
  assert.ok(!g.gh.some((a) => a.includes('--remove-label')));
});

test('a notice this office raised on an older head is taken back when a rebase succeeds later', async t => {
  const ledger = new UpkeepLedger();
  const old = ledger.pr(7, 'o'.repeat(40));
  old.human = true;
  const f = prFakes();
  const out = await new PrUpkeep(config(), f.tools, ledger, quiet).pass('Pletor/shop', root(t), root(t));
  assert.deepEqual(out, [{ number: 7, state: 'rebased', cleared: true }]);
  assert.ok(f.gh.some((a) => a.includes('--remove-label')));
});

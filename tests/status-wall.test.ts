// 🚦 The status wall's rules (src/server/status/): green, amber and red from what git, gh and Opora
// say, with every command answered by a fake runner instead of a real repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { githubRepo, parseWorktrees, remoteMain, repoFacts, type LiveWork, type Runner } from '../src/server/status/git.ts';
import { oporaRunning } from '../src/server/status/instance.ts';
import { lightOf, oporaRunReasons, panel, repoReasons, runningReasons, type PrFact } from '../src/server/status/rules.ts';
import { OporaError, type OporaClient } from '../src/server/opora/client.ts';

const MAIN = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const REPO = '/repo';

interface Scene {
  /** Local main against fork/main: ahead, behind. */
  main?: [number, number];
  /** Extra worktrees: their folder, branch and how many tracked files they've changed. */
  worktrees?: { path: string; branch: string; dirty: number }[];
  /** Tracked files changed in the primary checkout. */
  mainDirty?: number;
  /** Branches (local), each with its commits not in main and the tree a merge into main would make. */
  branches?: { name: string; ahead: number; mergeTree?: string }[];
  prs?: PrFact[];
}

/** A runner that answers git (and gh) the way a repository in `scene` would. */
function fakeRepo(scene: Scene): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = async (cmd, args, cwd) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(`${cwd}: ${line}`);
    if (cmd === 'gh') return JSON.stringify(scene.prs ?? []);
    const [sub, ...rest] = args;
    switch (sub) {
      case 'remote':
        return 'fork\norigin';
      case 'fetch':
        return '';
      case 'rev-parse':
        if (rest.includes('refs/remotes/fork/main') || rest.includes('refs/heads/main')) return MAIN;
        if (rest[0] === 'refs/remotes/fork/main^{tree}') return TREE;
        throw new Error(`unknown rev ${rest.join(' ')}`);
      case 'rev-list':
        if (rest[0] === '--left-right') return (scene.main ?? [0, 0]).join('\t');
        if (rest[0] === '--count') {
          const ref = rest[1].split('..')[1].replace('refs/heads/', '');
          return String(scene.branches?.find((b) => b.name === ref)?.ahead ?? 0);
        }
        break;
      case 'worktree':
        return [`worktree ${REPO}\nHEAD ${MAIN}\nbranch refs/heads/main`, ...(scene.worktrees ?? []).map((w) => `worktree ${w.path}\nHEAD ${OLD}\nbranch refs/heads/${w.branch}`)].join('\n\n');
      case 'status': {
        const n = cwd === REPO ? (scene.mainDirty ?? 0) : (scene.worktrees?.find((w) => w.path === cwd)?.dirty ?? 0);
        return Array.from({ length: n }, (_, i) => ` M src/file${i}.ts`).join('\n');
      }
      case 'for-each-ref':
        return ['refs/heads/main', ...(scene.branches ?? []).map((b) => `refs/heads/${b.name}`), 'refs/remotes/fork/HEAD', 'refs/remotes/fork/main'].join('\n');
      case 'merge-tree': {
        const ref = rest[2].replace('refs/heads/', '');
        return `${scene.branches?.find((b) => b.name === ref)?.mergeTree ?? 'd'.repeat(40)}\n`;
      }
    }
    throw new Error(`unexpected: ${line}`);
  };
  return { run, calls };
}

async function officeLight(scene: Scene, live: LiveWork[] = [], running = { sha: MAIN, dev: false, built: { sha: MAIN }, disk: { sha: MAIN } }) {
  const { run } = fakeRepo(scene);
  const facts = await repoFacts(run, REPO, { remote: 'fork/main', live, prs: scene.prs });
  const reasons = [...runningReasons(running, facts.remote, facts.remoteSha), ...repoReasons(facts)];
  return { facts, reasons, panel: panel('office', 'Kancelář', reasons) };
}

test('green when all the work is in main and that is what runs', async () => {
  const { panel: p, reasons } = await officeLight({ branches: [{ name: 'done', ahead: 0 }] });
  assert.equal(p.light, 'green', JSON.stringify(reasons));
  assert.equal(p.summary, 'V pořádku');
  assert.ok(reasons.some((r) => /Všechna práce je v fork\/main/.test(r.text)));
});

test('red for a worktree with uncommitted changes and no worker in it', async () => {
  const { panel: p } = await officeLight({ worktrees: [{ path: '/elsewhere/wip', branch: 'wip', dirty: 3 }] });
  assert.equal(p.light, 'red');
  const r = p.reasons[0];
  assert.equal(r.level, 'bad');
  assert.match(r.text, /Worktree bez workera má neuložené změny \(3 soubory\)/);
  assert.equal(r.where, '/elsewhere/wip');
  assert.ok(r.fix);
});

test('amber, not red, for the same worktree while a seated worker is in it', async () => {
  const { panel: p } = await officeLight({ worktrees: [{ path: '/repo/.agent-office/worktrees/bolt-1', branch: 'office/bolt-1', dirty: 2 }] }, [{ name: 'Bolt', path: '/repo/.agent-office/worktrees/bolt-1', branch: 'office/bolt-1' }]);
  assert.equal(p.light, 'amber');
  assert.match(p.reasons[0].text, /Bolt má rozpracované změny/);
});

test('red for an unpushed local main, and for uncommitted changes in the main checkout', async () => {
  const unpushed = await officeLight({ main: [2, 0] });
  assert.equal(unpushed.panel.light, 'red');
  assert.match(unpushed.panel.reasons[0].text, /Místní main má 2 commity neodeslané na fork\/main/);
  assert.match(unpushed.panel.reasons[0].fix ?? '', /git push fork main/);
  const dirty = await officeLight({ mainDirty: 1 });
  assert.equal(dirty.panel.light, 'red');
  assert.match(dirty.panel.reasons[0].text, /Hlavní checkout má neuložené změny \(1 soubor\)/);
});

test('red for a branch ahead of main with no PR, or a closed one', async () => {
  const none = await officeLight({ branches: [{ name: 'lost', ahead: 4 }] });
  assert.equal(none.panel.light, 'red');
  assert.match(none.panel.reasons[0].text, /Větev má 4 commity mimo main a žádný PR/);
  assert.equal(none.panel.reasons[0].fix, 'otevři PR');
  const closed = await officeLight({ branches: [{ name: 'gave-up', ahead: 1 }], prs: [{ number: 9, state: 'CLOSED', headRefName: 'gave-up', url: 'https://github.com/o/r/pull/9' }] });
  assert.equal(closed.panel.light, 'red');
  assert.match(closed.panel.reasons[0].text, /PR #9 je zavřený bez merge/);
});

test('amber for an open PR, and for a seated worker’s branch', async () => {
  const open = await officeLight({ branches: [{ name: 'feature', ahead: 2 }], prs: [{ number: 7, state: 'OPEN', headRefName: 'feature', url: 'https://github.com/o/r/pull/7' }] });
  assert.equal(open.panel.light, 'amber');
  assert.equal(open.panel.reasons[0].text, 'PR #7 je otevřený');
  assert.equal(open.panel.reasons[0].fix, 'dokonči a mergni PR #7');
  assert.equal(open.panel.reasons[0].url, 'https://github.com/o/r/pull/7');
  const seated = await officeLight({ branches: [{ name: 'office/nibble-1', ahead: 3 }] }, [{ name: 'Nibble', branch: 'office/nibble-1' }]);
  assert.equal(seated.panel.light, 'amber');
  assert.match(seated.panel.reasons[0].text, /Rozpracováno: Nibble/);
});

test('an open draft PR is parked work: green, with the drafts counted in the all-in-main line', async () => {
  const draft = await officeLight({ branches: [{ name: 'h07', ahead: 2 }], prs: [{ number: 12, state: 'OPEN', isDraft: true, headRefName: 'h07', url: 'https://github.com/o/r/pull/12' }] });
  assert.equal(draft.panel.light, 'green', JSON.stringify(draft.reasons));
  const parked = draft.reasons.find((r) => r.text === 'PR #12 je odložený (draft)');
  assert.ok(parked, JSON.stringify(draft.reasons));
  assert.equal(parked.level, 'ok');
  assert.equal(parked.fix, 'vrať ho z draftu, až na něm budete pracovat');
  assert.equal(parked.url, 'https://github.com/o/r/pull/12');
  assert.ok(draft.reasons.some((r) => /^Všechna práce je v fork\/main \(a{7}\) \(odloženo: 1 draft PR\)$/.test(r.text)), JSON.stringify(draft.reasons));
  const ready = await officeLight({ branches: [{ name: 'h07', ahead: 2 }], prs: [{ number: 12, state: 'OPEN', isDraft: false, headRefName: 'h07' }] });
  assert.equal(ready.panel.light, 'amber');
  assert.equal(ready.panel.reasons[0].text, 'PR #12 je otevřený');
  assert.ok(!ready.reasons.some((r) => /Všechna práce/.test(r.text)));
  const clean = await officeLight({});
  assert.ok(clean.reasons.some((r) => /^Všechna práce je v fork\/main \(a{7}\)$/.test(r.text)), JSON.stringify(clean.reasons));
});

test('squash-merged branches count as merged: by the merged PR, or by their changes already being in main', async () => {
  // gh: the PR merged (a squash leaves no ancestry, so the branch is still "ahead").
  const byPr = await officeLight({ branches: [{ name: 'squashed', ahead: 5 }], prs: [{ number: 3, state: 'MERGED', headRefName: 'squashed' }] });
  assert.equal(byPr.panel.light, 'green', JSON.stringify(byPr.reasons));
  assert.ok(byPr.reasons.some((r) => /už v main/.test(r.text)));
  // No gh: merging it into main would change nothing.
  const byContent = await officeLight({ branches: [{ name: 'squashed', ahead: 5, mergeTree: TREE }] });
  assert.equal(byContent.facts.branches[0].inMain, true);
  assert.equal(byContent.facts.prLookup, false);
  assert.equal(byContent.panel.light, 'green', JSON.stringify(byContent.reasons));
});

test('amber "restart needed" when the running commit is behind and main is already built', () => {
  const reasons = runningReasons({ sha: OLD, dev: false, behind: true, headNow: MAIN, built: { sha: OLD }, disk: { sha: MAIN } }, 'fork/main', MAIN);
  assert.equal(lightOf(reasons), 'amber');
  assert.ok(reasons.some((r) => /Potřeba restart/.test(r.text) && r.fix === 'restartuj kancelář'), JSON.stringify(reasons));
  // Behind, but main not pulled and built yet: still amber, with the longer fix.
  const pull = runningReasons({ sha: OLD, dev: false, behind: true, headNow: OLD, built: { sha: OLD }, disk: { sha: OLD } }, 'fork/main', MAIN);
  assert.equal(lightOf(pull), 'amber');
  assert.match(pull[0].fix ?? '', /stáhni main/);
});

test('red when the running build does not match: a commit off main, or dist built from another one', () => {
  assert.equal(lightOf(runningReasons({ sha: OLD, dev: false, behind: false, built: { sha: OLD } }, 'fork/main', MAIN)), 'red');
  const wrongDist = runningReasons({ sha: MAIN, dev: false, built: { sha: OLD } }, 'fork/main', MAIN);
  assert.equal(lightOf(wrongDist), 'red');
  assert.match(wrongDist.find((r) => r.level === 'bad')!.text, /dist je sestavený z bbbbbbb/);
  assert.equal(lightOf(runningReasons({ sha: MAIN, dev: false, built: { sha: MAIN, dirty: true } }, 'fork/main', MAIN)), 'red');
  // A server-only merge after the build: the client did not change, so the deploy script rightly skipped the rebuild.
  const serverOnly = runningReasons({ sha: MAIN, dev: false, built: { sha: OLD }, builtSameClient: true, client: { sha: OLD }, clientSameCode: true }, 'fork/main', MAIN);
  assert.equal(lightOf(serverOnly), 'green', JSON.stringify(serverOnly));
  assert.ok(serverOnly.some((r) => /klient se od té doby nezměnil/.test(r.text)));
  assert.equal(lightOf(runningReasons({ sha: MAIN, dev: false, built: { sha: OLD, dirty: true }, builtSameClient: true }, 'fork/main', MAIN)), 'red');
  assert.equal(lightOf(runningReasons({ sha: MAIN, dev: false, built: { sha: MAIN }, client: { sha: OLD }, clientSameCode: false }, 'fork/main', MAIN)), 'red');
  // Under npm run dev there is no dist to match.
  assert.equal(lightOf(runningReasons({ sha: MAIN, dev: true }, 'fork/main', MAIN)), 'green');
});

test('Opora with no version endpoint is amber "verze neověřena", never green', async () => {
  const reasons = oporaRunReasons({ url: 'http://127.0.0.1:8740', up: true, identity: null }, 'origin/main', MAIN);
  assert.equal(lightOf(reasons), 'amber');
  assert.ok(reasons.some((r) => /Verze neověřena/.test(r.text)));

  // The same through the live check: health answers, /api/build-identity is a 404, and the port's process can't be told.
  const client = {
    base: 'http://127.0.0.1:8740',
    health: async () => ({ status: 'ok', product: 'Opora Canvas' }),
    buildIdentity: async () => {
      throw new OporaError(404, 'Opora said 404: Not Found');
    },
  } as unknown as OporaClient;
  const run: Runner = async () => {
    throw new Error('nothing to say');
  };
  const facts = await oporaRunning(run, client, undefined, undefined, MAIN);
  assert.equal(facts.identity, null);
  assert.equal(lightOf(oporaRunReasons(facts, 'origin/main', MAIN)), 'amber');
});

test('Opora: green when it runs the remote main, amber restart when behind, red when down', () => {
  const at = { distMtime: 2000, frontendChangedAt: 1000 };
  assert.equal(lightOf(oporaRunReasons({ url: 'u', up: true, identity: { commit: MAIN }, ...at }, 'origin/main', MAIN)), 'green');
  const behind = oporaRunReasons({ url: 'u', up: true, identity: { commit: OLD }, behind: true, ...at }, 'origin/main', MAIN);
  assert.equal(lightOf(behind), 'amber');
  assert.match(behind[1].text, /Potřeba restart/);
  assert.equal(lightOf(oporaRunReasons({ url: 'u', up: false, error: 'neodpovídá' }, 'origin/main', MAIN)), 'red');
  // A frontend older than its last change in main wants a rebuild.
  assert.equal(lightOf(oporaRunReasons({ url: 'u', up: true, identity: { commit: MAIN }, distMtime: 500, frontendChangedAt: 1000 }, 'origin/main', MAIN)), 'amber');
});

test('which remote main, the worktree list, and a GitHub remote', async () => {
  const { run } = fakeRepo({});
  assert.equal(await remoteMain(run, REPO), 'fork/main');
  assert.equal(await remoteMain(run, REPO, 'upstream/trunk'), 'upstream/trunk');
  const onlyOrigin: Runner = async (_c, args) => {
    if (args[0] === 'remote') return 'origin';
    if (args[0] === 'rev-parse') return 'origin/main';
    return '';
  };
  assert.equal(await remoteMain(onlyOrigin, REPO), 'origin/main');
  assert.deepEqual(parseWorktrees('worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\nprunable gitdir file points to non-existent location\n'), [
    { path: '/a', branch: 'main', prunable: false },
    { path: '/b', branch: undefined, prunable: true },
  ]);
  assert.equal(githubRepo('https://github.com/Pletor/agent-office.git'), 'Pletor/agent-office');
  assert.equal(githubRepo('git@github.com:Pletor/opora-control-center-canvas.git'), 'Pletor/opora-control-center-canvas');
  assert.equal(githubRepo('https://gitlab.com/x/y.git'), undefined);
});

test('the checks only read: no command but fetch changes anything, and nothing runs through a shell', async () => {
  const { run, calls } = fakeRepo({ branches: [{ name: 'x', ahead: 1 }], worktrees: [{ path: '/w', branch: 'x', dirty: 1 }] });
  await repoFacts(run, REPO, { remote: 'fork/main', fetch: true, live: [] });
  const writers = calls.filter((c) => / git (push|commit|reset|checkout|stash|branch -[dD]|worktree (add|remove|prune))/.test(c));
  assert.deepEqual(writers, []);
  assert.ok(calls.some((c) => c.endsWith('git fetch --quiet --prune fork')));
  assert.ok(!calls.some((c) => / (sh|cmd|bash) /.test(c)));
});

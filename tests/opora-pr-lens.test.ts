import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExecutionLease } from '../src/server/opora/execution-client.js';
import { PullRequestHandoff, type HandoffTools } from '../src/server/opora/pull-request-handoff.js';
import { findLensSpec, lensEvent, lensMarkdown, lensIsFresh, prLensArgv, PR_LENS_NPX, PR_LENS_RENDER, prLensCli, prLensEnabled, prLensInstructions, withLensSection } from '../src/server/opora/pr-lens.js';

const HEAD = 'c'.repeat(40);
const lease = (): ExecutionLease => ({ project: 'project', workspace: 'work', nodeId: 'card-0123456789abcdef', executionId: 'execution-1',
  token: 'PRIVATE-token', epoch: 7, acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64), assignment: { contextVersion: 'context' },
  state: 'running', serverNow: 100, expiresAt: 1000 });

function directory(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-lens-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'opora-executions'), { recursive: true });
  mkdirSync(path.join(dir, 'tree'), { recursive: true });
  writeFileSync(path.join(dir, 'opora-executions', 'execution-1-reported.json'), JSON.stringify({ receiptId: 'r', result: { summary: 'Cart page done' } }));
  return dir;
}

const SPEC = { kind: 'graph', provenance: { head: { sha: HEAD } }, title: 'Batch [broadcast] sends', summary: 'Sends in bulk.',
  nodes: [{ id: 'n', label: 'Sender', delta: 'added', files: [{ path: 'src/a.ts', startLine: 1, endLine: 9 }] },
    { id: 'm', label: 'Queue', delta: 'modified', files: [{ path: 'src/q.ts' }] },
    { id: 'u', label: 'Untouched', delta: 'unchanged', files: [{ path: 'src/u.ts' }] }],
  flows: [{ id: 'f', title: 'Sending a broadcast' }] };

/** The render as the CLI writes it; only the drawn spec matters to the office. */
function render(tree: string, spec: unknown = SPEC) {
  const out = path.join(tree, PR_LENS_RENDER);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'drawn.graph.json'), JSON.stringify(spec));
}

function fakes(opts: { env?: NodeJS.ProcessEnv; existing?: { number: number; url: string; state?: string }; comments?: number[]; lensStatus?: number } = {}) {
  const gh: string[][] = [], posts: { url: string; body: Record<string, unknown> }[] = [];
  const tools: HandoffTools = {
    env: opts.env ?? {},
    git: async (args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return HEAD;
      if (args[0] === 'rev-list') return '2';
      if (args[0] === 'remote') return 'git@github.com:Pletor/shop.git';
      return '';
    },
    gh: async (args) => {
      gh.push(args);
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(opts.existing ? [opts.existing] : []);
      if (args[0] === 'api' && args[1].endsWith('/comments')) return JSON.stringify(opts.comments ?? []);
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/Pletor/shop/pull/42\n';
      return '';
    },
    transport: (async (url: URL, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      const lens = String(url).endsWith('/lens'), status = lens ? opts.lensStatus ?? 200 : 200;
      return new Response(lens && status === 409 ? JSON.stringify({ error: 'Execution is no longer authoritative.', code: 'review_conflict' }) : '{}', { status });
    }) as typeof fetch,
  };
  return { tools, gh, posts };
}
const subject = (dir: string) => ({ lease: lease(), cardName: 'Cart page', dir: path.join(dir, 'tree'), baseCommit: 'd'.repeat(40), baseBranch: 'main' });
const quiet = () => {};

test('the flag is on by default and off only for off/0/false/no; the worker is told the commands and to keep .pr-lens out of git', () => {
  assert.equal(prLensEnabled({}), true);
  for (const off of ['off', '0', 'false', 'NO']) assert.equal(prLensEnabled({ AGENT_OFFICE_OPORA_PR_LENS: off }), false, off);
  const brief = prLensInstructions({ AGENT_OFFICE_PR_LENS_CLI: 'lens-bin' });
  assert.match(brief, /`lens-bin validate \.pr-lens\/graph\.json`/);
  assert.match(brief, /render \.pr-lens\/graph\.json --theme light --out \.pr-lens\/render/);
  assert.match(brief, /Never run `analyze`, `canvas` or `auth`/);
  assert.match(brief, /never `git add` it/);
});

test('the CLI is the env path, else AGENT_OFFICE_PR_LENS_HOME/node_modules/.bin, else the pinned npx; always an argument list', () => {
  assert.deepEqual(prLensArgv({ AGENT_OFFICE_PR_LENS_CLI: ' my-lens ' }, 'linux', () => true), ['my-lens']);
  assert.deepEqual(prLensArgv({ AGENT_OFFICE_PR_LENS_HOME: '/opt/lens' }, 'linux', () => true), [path.join('/opt/lens', 'node_modules', '.bin', 'pr-lens')]);
  assert.deepEqual(prLensArgv({ AGENT_OFFICE_PR_LENS_HOME: '/opt/lens' }, 'win32', () => true), [path.join('/opt/lens', 'node_modules', '.bin', 'pr-lens.cmd')]);
  assert.deepEqual(prLensArgv({ AGENT_OFFICE_PR_LENS_HOME: '/opt/lens' }, 'linux', () => false), PR_LENS_NPX.split(' '));
  assert.deepEqual(prLensArgv({}, 'linux', () => true), PR_LENS_NPX.split(' '));
  assert.equal(prLensCli({ AGENT_OFFICE_PR_LENS_CLI: '/a b/pr-lens' }, 'linux'), '"/a b/pr-lens"');
  assert.match(PR_LENS_NPX, /@coldtea\/pr-lens-cli@0\.13\.2 -p @coldtea\/pr-lens-renderer@0\.3\.2 pr-lens$/);
});

test('the spec is read from the drawn graph and must be a graph document; the summary is text with cards, files and flows', (t) => {
  const tree = path.join(directory(t), 'tree');
  assert.equal(findLensSpec(tree), undefined, 'no render: nothing');
  render(tree, { kind: 'patch' });
  assert.equal(findLensSpec(tree), undefined);
  render(tree);
  const spec = findLensSpec(tree)!;
  assert.match(spec.sha256, /^[a-f0-9]{64}$/);
  const md = lensMarkdown(spec);
  assert.ok(md.startsWith('## PR Lens\n\nNázev: `Batch [broadcast] sends`\n\nShrnutí: `Sends in bulk.`'));
  assert.match(md, /Přidáno:\n\n- `Sender` \(`src\/a\.ts`\)/);
  assert.match(md, /Změněno:\n\n- `Queue` \(`src\/q\.ts`\)/);
  assert.ok(!md.includes('Untouched'), 'unchanged cards are not listed');
  assert.match(md, /Toky: `Sending a broadcast`/);
  assert.ok(md.endsWith('Interaktivní pohled: Opora → karta → Lens'));
  assert.ok(!/!\[|<img|https?:/.test(md), 'text only');
  assert.equal(withLensSection('## Summary\n\nx\n\n---\n\nOpened by\n\nOpora-Card: c', '## PR Lens'), '## Summary\n\nx\n\n## PR Lens\n\n---\n\nOpened by\n\nOpora-Card: c');
});

test('handoff: text summary before the trailers, spec to Canvas with the lease token, no GitHub side writes, token nowhere else', async (t) => {
  const dir = directory(t);
  render(path.join(dir, 'tree'));
  const f = fakes();
  const out = await new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools).handOff(subject(dir), quiet)!;
  assert.equal(out.state, 'opened');
  assert.ok(!f.gh.some((a) => a[0] === 'api'), 'nothing is published to GitHub but the PR text');
  const body = f.gh.find((a) => a[1] === 'create')!.at(-1)!;
  assert.ok(body.includes('## PR Lens\n\nNázev: `Batch [broadcast] sends`'));
  assert.ok(body.includes('Interaktivní pohled: Opora → karta → Lens'));
  assert.ok(body.endsWith('Opora-Card: card-0123456789abcdef'), 'the trailers stay last');
  assert.ok(!body.includes('PRIVATE-token'), 'the lease token is not in the PR body');
  const lens = f.posts.find((p) => p.url.endsWith('/api/oporahub/review-jobs/lens'))!;
  assert.equal(lens.body.token, 'PRIVATE-token', 'sent like every execution post');
  assert.equal(lens.body.epoch, 7);
  assert.equal(lens.body.executionId, 'execution-1');
  const sent = lens.body.lens as Record<string, unknown>;
  assert.equal(sent.url, undefined);
  assert.equal(sent.specUrl, undefined);
  assert.match(String(sent.specSha256), /^[a-f0-9]{64}$/);
  assert.deepEqual(sent.spec, SPEC);
  assert.equal(sent.prNumber, 42);
  assert.ok(!JSON.stringify(lensEvent(lease(), sent as never, 'recorded')).includes('PRIVATE-token'), 'nor in the process event');
});

test('a spec over 64 KiB is announced by size and hash only', async (t) => {
  const dir = directory(t);
  render(path.join(dir, 'tree'), { ...SPEC, pad: 'x'.repeat(70 * 1024) });
  const f = fakes();
  await new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools).handOff(subject(dir), quiet)!;
  const sent = f.posts.find((p) => p.url.endsWith('/lens'))!.body.lens as Record<string, unknown>;
  assert.equal(sent.spec, undefined);
  assert.equal(sent.note, 'spec too large');
  assert.ok(Number(sent.specBytes) > 64 * 1024);
  assert.match(String(sent.specSha256), /^[a-f0-9]{64}$/);
});

test('a reused open PR gets one summary comment, updated in place next time; a closed PR gets none', async (t) => {
  const existing = { number: 7, url: 'https://github.com/Pletor/shop/pull/7', state: 'OPEN' };
  const dir = directory(t);
  render(path.join(dir, 'tree'));
  const f = fakes({ existing });
  const out = await new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools).handOff(subject(dir), quiet)!;
  assert.equal(out.state, 'reused');
  const comment = f.gh.find((a) => a[0] === 'pr' && a[1] === 'comment')!;
  assert.deepEqual(comment.slice(0, 5), ['pr', 'comment', '7', '--repo', 'Pletor/shop']);
  assert.match(comment.at(-1)!, /## PR Lens/);

  const again = fakes({ existing, comments: [555] });
  await new PullRequestHandoff(directory(t), 'http://127.0.0.1:8740', 'office-1', again.tools).handOff(subject(dir), quiet)!;
  assert.ok(!again.gh.some((a) => a[0] === 'pr' && a[1] === 'comment'), 'no second comment');
  const patch = again.gh.find((a) => a[0] === 'api' && a[2] === 'PATCH')!;
  assert.equal(patch[3], 'repos/Pletor/shop/issues/comments/555');
  assert.ok(patch.at(-1)!.startsWith('body=## PR Lens'));

  for (const state of ['CLOSED', 'MERGED']) {
    const done = fakes({ existing: { ...existing, state } });
    await new PullRequestHandoff(directory(t), 'http://127.0.0.1:8740', 'office-1', done.tools).handOff(subject(dir), quiet)!;
    assert.ok(!done.gh.some((a) => a[0] === 'pr' && a[1] === 'comment') && !done.gh.some((a) => a[0] === 'api'), state);
    assert.ok(done.posts.some((p) => p.url.endsWith('/lens')), `${state}: Canvas still gets the evidence`);
  }
});

test('spec text is inert in markdown: @mentions, #refs, URLs and markdown syntax sit inside code spans', (t) => {
  const tree = path.join(directory(t), 'tree');
  render(tree, { ...SPEC, title: '# Hello @org/x', summary: 'see https://evil.example and #1 **bold** `tick` ---',
    nodes: [{ id: 'a', label: '- @team #1', delta: 'added', files: [{ path: 'https://evil.example/@x' }] }], flows: [{ id: 'f', title: '1. www.evil.example' }] });
  const md = lensMarkdown(findLensSpec(tree)!);
  for (const line of md.split('\n')) {
    const outside = line.replace(/`[^`]*`/g, '');
    assert.ok(!/[@#*]|https?:|www\.|---/.test(outside.replace(/^## PR Lens$/, '')), `inert: ${line}`);
  }
  assert.ok(md.includes('`# Hello @org/x`') && md.includes('`- @team #1`') && md.includes('`1. www.evil.example`'));
  assert.ok(!md.includes('``'));
});

test('a spec from another head is stale: no inline spec, the PR says so, the event waits; a symlinked spec is ignored', async (t) => {
  const dir = directory(t);
  render(path.join(dir, 'tree'), { ...SPEC, provenance: { head: { sha: 'f'.repeat(40) } } });
  assert.equal(lensIsFresh(findLensSpec(path.join(dir, 'tree'))!, HEAD), false);
  const f = fakes();
  await new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools).handOff(subject(dir), quiet)!;
  const body = f.gh.find((a) => a[1] === 'create')!.at(-1)!;
  assert.ok(body.includes('Lens je ze starší verze') && !body.includes('Sender'));
  const sent = f.posts.find((p) => p.url.endsWith('/lens'))!.body.lens as Record<string, unknown>;
  assert.equal(sent.spec, undefined);
  assert.equal(sent.stale, true);
  assert.equal(lensEvent(lease(), sent as never, 'recorded').state, 'wait');

  const tree = path.join(directory(t), 'tree'), out = path.join(tree, PR_LENS_RENDER);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(tree, 'real.json'), JSON.stringify(SPEC));
  try { symlinkSync(path.join(tree, 'real.json'), path.join(out, 'drawn.graph.json')); } catch { return; }
  assert.equal(findLensSpec(tree), undefined);
});

test('flag off, no spec, or a Canvas without the lens endpoint: the PR goes out as before', async (t) => {
  for (const [name, setup, env] of [['off', true, { AGENT_OFFICE_OPORA_PR_LENS: 'off' }], ['missing', false, {}]] as const) {
    const dir = directory(t);
    if (setup) render(path.join(dir, 'tree'));
    const f = fakes({ env });
    const out = await new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools).handOff(subject(dir), quiet)!;
    assert.equal(out.state, 'opened', name);
    assert.ok(!f.gh.find((a) => a[1] === 'create')!.at(-1)!.includes('PR Lens'), `${name}: no section`);
    assert.ok(!f.posts.some((p) => p.url.endsWith('/lens')), `${name}: no evidence`);
  }
  const dir = directory(t);
  render(path.join(dir, 'tree'));
  const f = fakes({ lensStatus: 404 });
  const out = await new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools).handOff(subject(dir), quiet)!;
  assert.ok(out.state === 'opened' && out.link === 'linked', 'a 404 on /lens never touches the handoff');
});

test('the spec goes to Canvas after the PR is linked; a 409 is logged with its reason, shown as failed and tried once more later', async (t) => {
  const dir = directory(t);
  render(path.join(dir, 'tree'));
  const f = fakes({ lensStatus: 409 });
  const later: (() => void)[] = [];
  f.tools.later = (run) => { later.push(run); };
  const said: [string, string][] = [];
  const out = await new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools).handOff(subject(dir), (m, level) => said.push([m, level]))!;
  assert.ok(out.state === 'opened' && out.link === 'linked', 'a refused lens never touches the handoff');
  const urls = f.posts.map((p) => p.url);
  assert.ok(urls.findIndex((u) => u.endsWith('/pull-request')) < urls.findIndex((u) => u.endsWith('/lens')), 'linked first, then the lens');
  const warned = said.filter(([m, level]) => level === 'warn' && m.includes('PR Lens'));
  assert.equal(warned.length, 1);
  assert.match(warned[0][0], /conflict \(HTTP 409: Execution is no longer authoritative\.\); trying once more later/);
  assert.equal(later.length, 1, 'one retry scheduled');
  later[0]();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.posts.filter((p) => p.url.endsWith('/lens')).length, 2, 'retried once');
  assert.equal(later.length, 1, 'no second retry');
  assert.ok(said.some(([m]) => m.includes('on retry') && m.includes('conflict')));
  assert.ok(!said.some(([m]) => m.includes('PRIVATE-token')), 'the lease token is never logged');
});

test('the live-process event says when Canvas did not store the spec, and why', () => {
  const sent = { prNumber: 42, headSha: HEAD, validatedAt: 'now', specSha256: 'a'.repeat(64), specBytes: 9 };
  const failed = lensEvent(lease(), sent, 'conflict', 'HTTP 409: Execution is no longer authoritative.');
  assert.equal(failed.kind, 'pr.lens');
  assert.equal(failed.state, 'fail');
  assert.match(failed.title, /se neuložil/);
  assert.match(String(failed.detail), /Canvas: conflict \(HTTP 409: Execution is no longer authoritative\.\)/);
  assert.equal(lensEvent(lease(), sent, 'failed').state, 'fail');
  assert.equal(lensEvent(lease(), sent, 'not-deployed').state, 'info');
  assert.equal(lensEvent(lease(), sent, 'recorded').state, 'ok');
  assert.ok(String(lensEvent(lease(), sent, 'failed', 'x'.repeat(400)).detail).length <= 240);
});

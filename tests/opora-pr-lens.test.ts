import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExecutionLease } from '../src/server/opora/execution-client.js';
import { PullRequestHandoff, type HandoffTools } from '../src/server/opora/pull-request-handoff.js';
import { findLensSpec, lensEvent, lensMarkdown, PR_LENS_LOCAL_CLI, PR_LENS_NPX, PR_LENS_RENDER, prLensCli, prLensEnabled, prLensInstructions, withLensSection } from '../src/server/opora/pr-lens.js';

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

const SPEC = { kind: 'graph', title: 'Batch [broadcast] sends', summary: 'Sends in bulk.',
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

function fakes(opts: { env?: NodeJS.ProcessEnv; existing?: { number: number; url: string }; lensStatus?: number } = {}) {
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
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/Pletor/shop/pull/42\n';
      return '';
    },
    transport: (async (url: URL, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: String(url).endsWith('/lens') ? opts.lensStatus ?? 200 : 200 });
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

test('the CLI is the env override, else the pinned local install, else the pinned npx command', () => {
  assert.equal(prLensCli({ AGENT_OFFICE_PR_LENS_CLI: ' my-lens ' }, () => true), 'my-lens');
  assert.equal(prLensCli({}, (f) => f === PR_LENS_LOCAL_CLI), `& "${PR_LENS_LOCAL_CLI}"`);
  assert.equal(prLensCli({}, () => false), PR_LENS_NPX);
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
  assert.match(md, /^## PR Lens\n\n\*\*Batch broadcast sends\*\*\n\nSends in bulk\./);
  assert.match(md, /Přidáno:\n- Sender \(`src\/a\.ts`\)/);
  assert.match(md, /Změněno:\n- Queue \(`src\/q\.ts`\)/);
  assert.ok(!md.includes('Untouched'), 'unchanged cards are not listed');
  assert.match(md, /Toky: Sending a broadcast/);
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
  assert.ok(body.includes('## PR Lens\n\n**Batch broadcast sends**'));
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

test('a reused PR gets the summary as a comment', async (t) => {
  const dir = directory(t);
  render(path.join(dir, 'tree'));
  const f = fakes({ existing: { number: 7, url: 'https://github.com/Pletor/shop/pull/7' } });
  const out = await new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools).handOff(subject(dir), quiet)!;
  assert.equal(out.state, 'reused');
  const comment = f.gh.find((a) => a[0] === 'pr' && a[1] === 'comment')!;
  assert.deepEqual(comment.slice(0, 5), ['pr', 'comment', '7', '--repo', 'Pletor/shop']);
  assert.match(comment.at(-1)!, /## PR Lens/);
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

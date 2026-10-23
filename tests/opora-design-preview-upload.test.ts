import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExecutionLease } from '../src/server/opora/execution-client.js';
import { PullRequestHandoff, type HandoffTools } from '../src/server/opora/pull-request-handoff.js';
import { previewFolder } from '../src/server/opora/design-brief.js';
import { DesignPreviewAttachment, MAX_PNG_BYTES, postPreview, previewEvent, readPreview } from '../src/server/opora/design-preview-upload.js';

const HEAD = 'c'.repeat(40);
const TOKEN = 'f'.repeat(64);
const lease = (): ExecutionLease => ({ project: 'project', workspace: 'work', nodeId: 'card-1', executionId: 'execution-1',
  token: TOKEN, epoch: 7, acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64), assignment: { contextVersion: 'context' },
  state: 'running', serverNow: 100, expiresAt: 1000 });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);
const quiet = () => {};

function directory(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-preview-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'opora-executions'), { recursive: true });
  mkdirSync(path.join(dir, 'tree'), { recursive: true });
  writeFileSync(path.join(dir, 'opora-executions', 'execution-1-reported.json'), JSON.stringify({ receiptId: 'r', result: { summary: 'Cart page done' } }));
  return dir;
}

/** The worker's delivery: preview.json and PNGs in the card's folder for the head. */
function deliver(dir: string, manifest: unknown, files: Record<string, Buffer> = { 'light-mobile.png': PNG }) {
  const folder = path.join(previewFolder(dir, 'project', 'card-1'), HEAD);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'preview.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const [name, data] of Object.entries(files)) writeFileSync(path.join(folder, name), data);
  return folder;
}
const MANIFEST = { headSha: HEAD, designMdSha256: 'e'.repeat(64), screenshots: [{ file: 'light-mobile.png', label: 'light mobile', viewport: { width: 390, height: 844 }, stage: 'start' }] };

function fakes(opts: { status?: number; error?: string; throws?: string } = {}) {
  const posts: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const tools: HandoffTools = {
    env: { AGENT_OFFICE_OPORA_PR_LENS: 'off' },
    git: async (args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return HEAD;
      if (args[0] === 'rev-list') return '2';
      if (args[0] === 'remote') return 'git@github.com:Pletor/shop.git';
      if (args[0] === 'show' && args[1] === `${HEAD}:design/proposals/card-1/DESIGN.md`) return '# New direction\n';
      if (args[0] === 'show') throw new Error('fatal: path not in HEAD');
      return '';
    },
    gh: async (args) => (args[0] === 'pr' && args[1] === 'list' ? '[]' : args[0] === 'pr' && args[1] === 'create' ? 'https://github.com/Pletor/shop/pull/42\n' : ''),
    transport: (async (url: URL, init?: RequestInit) => {
      posts.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      if (!String(url).endsWith('/preview')) return new Response('{}', { status: 200 });
      if (opts.throws) throw new Error(opts.throws);
      const status = opts.status ?? 200;
      return new Response(JSON.stringify(status === 200 ? { recorded: true } : { error: opts.error ?? 'nope', code: 'review_conflict' }), { status });
    }) as typeof fetch,
    later: () => {},
  };
  return { tools, posts };
}
const subject = (dir: string) => ({ lease: lease(), cardName: 'Cart page', dir: path.join(dir, 'tree'), baseCommit: 'd'.repeat(40), baseBranch: 'main' });

test('after linking the PR the handoff posts the preview for its head with the execution credentials and Opora Origin', async (t) => {
  const dir = directory(t);
  deliver(dir, MANIFEST);
  const f = fakes();
  const said: string[] = [];
  const out = await new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools).handOff(subject(dir), m => said.push(m))!;
  assert.equal(out.state, 'opened');
  const urls = f.posts.map(p => new URL(p.url).pathname);
  assert.deepEqual(urls, ['/api/oporahub/executions/execution-1/pull-request', '/api/oporahub/review-jobs/preview'], 'preview goes after the link');
  const post = f.posts[1];
  assert.equal(post.headers.Origin, 'http://127.0.0.1:8740');
  assert.equal(post.headers['X-Opora-Actor'], 'agent; name=office-1');
  assert.deepEqual(Object.keys(post.body).sort(), ['epoch', 'executionId', 'preview', 'project', 'token', 'workspace']);
  assert.equal(post.body.token, TOKEN);
  assert.equal(post.body.epoch, 7);
  assert.deepEqual(post.body.preview, { prNumber: 42, headSha: HEAD, designMdSha256: 'e'.repeat(64),
    screenshots: [{ label: 'light mobile', viewport: { width: 390, height: 844 }, stage: 'start', dataURL: `data:image/png;base64,${PNG.toString('base64')}` }] });
  assert.ok(!said.some(m => /preview/i.test(m)), 'a stored preview is not toasted');
});

test('explore: proposedDesignMd is read from the head commit, not sent as a path', async (t) => {
  const dir = directory(t);
  deliver(dir, { ...MANIFEST, designMdSha256: null, proposedDesignMd: 'design/proposals/card-1/DESIGN.md' });
  const read = await readPreview(dir, lease(), { number: 42, headSha: HEAD }, { dir, git: fakes().tools.git });
  assert.equal(read.state, 'ready');
  if (read.state === 'ready') { assert.equal(read.preview.proposedDesignMd, '# New direction\n'); assert.equal(read.preview.designMdSha256, null); }
});

test('no preview folder or no preview.json: nothing is posted and nothing said', async (t) => {
  const dir = directory(t);
  const f = fakes();
  const said: string[] = [];
  await new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools).handOff(subject(dir), m => said.push(m))!;
  assert.ok(!f.posts.some(p => p.url.endsWith('/preview')));
  assert.ok(!said.some(m => /preview/i.test(m)));
  mkdirSync(path.join(previewFolder(dir, 'project', 'card-1'), HEAD), { recursive: true });
  assert.deepEqual(await readPreview(dir, lease(), { number: 42, headSha: HEAD }, { dir, git: f.tools.git }), { state: 'absent' });
});

test('an oversized or invalid preview is not posted but reported', async (t) => {
  const cases: [string, unknown, Record<string, Buffer>?][] = [
    ['not JSON', '{oops'],
    ['another head', { ...MANIFEST, headSha: 'd'.repeat(40) }],
    ['oversized PNG', MANIFEST, { 'light-mobile.png': Buffer.concat([PNG, Buffer.alloc(MAX_PNG_BYTES)]) }],
    ['not a PNG', MANIFEST, { 'light-mobile.png': Buffer.from('GIF89a') }],
    ['path in file', { ...MANIFEST, screenshots: [{ ...MANIFEST.screenshots[0], file: '../light-mobile.png' }] }],
    ['duplicate labels', { ...MANIFEST, screenshots: [MANIFEST.screenshots[0], MANIFEST.screenshots[0]] }],
    ['bad viewport', { ...MANIFEST, screenshots: [{ ...MANIFEST.screenshots[0], viewport: { width: 50, height: 844 } }] }],
    ['too many', { ...MANIFEST, screenshots: Array.from({ length: 9 }, (_, i) => ({ ...MANIFEST.screenshots[0], label: `l${i}` })) }],
    ['bad digest', { ...MANIFEST, designMdSha256: 'xyz' }],
    ['proposal outside the repo', { ...MANIFEST, proposedDesignMd: '../../etc/passwd' }],
    ['proposal not committed', { ...MANIFEST, proposedDesignMd: 'missing.md' }],
  ];
  for (const [name, manifest, files] of cases) {
    const dir = directory(t);
    deliver(dir, manifest, files);
    const f = fakes();
    const said: [string, string][] = [];
    const outcome = await new DesignPreviewAttachment(dir, 'http://127.0.0.1:8740', 'office-1', f.tools).report(lease(), { number: 42, headSha: HEAD }, dir, (m, l) => said.push([m, l]));
    assert.equal(outcome, 'invalid', name);
    assert.equal(f.posts.length, 0, name);
    assert.equal(said.length, 1, name);
    assert.equal(said[0][1], 'warn', name);
    assert.match(said[0][0], /Design preview for execution-1 \(PR #42\) not sent/, name);
  }
});

test('a refusal is logged with Opora\'s reason, a 409 is retried once, and the token never reaches a log line', async (t) => {
  const dir = directory(t);
  deliver(dir, MANIFEST);
  const later: (() => void)[] = [];
  const f = fakes({ status: 409, error: `Preview evidence must be for the current head (token ${TOKEN}).` });
  const said: string[] = [];
  const preview = new DesignPreviewAttachment(dir, 'http://127.0.0.1:8740', 'office-1', { ...f.tools, later: run => later.push(run) });
  assert.equal(await preview.report(lease(), { number: 42, headSha: HEAD }, dir, m => said.push(m)), 'conflict');
  assert.equal(later.length, 1);
  later[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.posts.length, 2);
  assert.match(said[0], /wasn't stored by Opora: conflict \(HTTP 409: Preview evidence must be for the current head/);
  assert.match(said[0], /trying once more later/);
  assert.match(said[1], /on retry/);
  for (const line of said) assert.ok(!line.includes(TOKEN), line);

  const down = fakes({ throws: `connect ECONNREFUSED body=${TOKEN}` });
  const reply = await postPreview('http://127.0.0.1:8740', 'office-1', down.tools.transport, lease(), { prNumber: 42, headSha: HEAD, designMdSha256: null, screenshots: [] });
  assert.equal(reply.outcome, 'failed');
  assert.ok(!reply.reason?.includes(TOKEN));
  assert.match(reply.reason ?? '', /\[redacted\]/);
});

test('the process event built from a refusal never carries the lease token', async () => {
  const down = fakes({ status: 409, error: `refused, token ${TOKEN}` });
  const reply = await postPreview('http://127.0.0.1:8740', 'office-1', down.tools.transport, lease(), { prNumber: 42, headSha: HEAD, designMdSha256: null, screenshots: [] });
  assert.equal(reply.outcome, 'conflict');
  for (const outcome of ['conflict', 'failed', 'invalid', 'recorded', 'not-deployed'] as const) {
    const event = previewEvent(lease(), { number: 42, headSha: HEAD }, outcome, `1 screenshots · Opora: ${outcome} (${reply.reason})`);
    assert.ok(!JSON.stringify(event).includes(TOKEN), outcome);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExecutionLease } from '../src/server/opora/execution-client.js';
import { PullRequestHandoff, type HandoffTools } from '../src/server/opora/pull-request-handoff.js';
import { findLensDiagram, lensGhArgs, lensUrl, PR_LENS_RENDER, prLensEnabled, prLensInstructions, withLensSection } from '../src/server/opora/pr-lens.js';

const HEAD = 'c'.repeat(40), SIDE = 'e'.repeat(40);
const SVG = 'overview-light-51845d181840d42d705fc9b982a0bf1d.svg';
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

/** A render as the CLI writes it: the manifest, the drawn document and the SVGs it names. */
function render(tree: string, opts: { svg?: string; manifest?: unknown; spec?: unknown } = {}) {
  const out = path.join(tree, PR_LENS_RENDER);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(opts.manifest ?? { schemaVersion: '0.2.0', kind: 'render-manifest', assets: [
    { id: 'retired-path-light', lens: 'architecture', view: 'retired-path', mediaType: 'image/svg+xml', path: 'retired-path-light-c174895c901878481403238b9cd85144.svg' },
    { id: 'overview-light', lens: 'architecture', view: 'overview', mediaType: 'image/svg+xml', path: SVG },
  ] }));
  writeFileSync(path.join(out, 'drawn.graph.json'), JSON.stringify(opts.spec ?? { kind: 'graph', title: 'Batch [broadcast] sends', nodes: [{ id: 'n', files: [{ path: 'src/a.ts', startLine: 1, endLine: 9 }] }] }));
  writeFileSync(path.join(out, SVG), opts.svg ?? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>');
  writeFileSync(path.join(out, 'retired-path-light-c174895c901878481403238b9cd85144.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
}

function fakes(opts: { env?: NodeJS.ProcessEnv; existing?: { number: number; url: string }; refExists?: boolean; lensStatus?: number } = {}) {
  const gh: string[][] = [], posts: { url: string; body: Record<string, unknown> }[] = [], uploads: Record<string, unknown>[] = [];
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
      if (args[0] === 'api' && args[2] === 'POST' && opts.refExists) throw new Error('Reference already exists');
      if (args[0] === 'api' && args[2] === 'PUT') {
        const { readFileSync } = await import('node:fs');
        uploads.push(JSON.parse(readFileSync(args[args.indexOf('--input') + 1], 'utf8')) as Record<string, unknown>);
        return JSON.stringify({ commit: { sha: SIDE } });
      }
      return '';
    },
    transport: (async (url: URL, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: String(url).endsWith('/lens') ? opts.lensStatus ?? 200 : 200 });
    }) as typeof fetch,
  };
  return { tools, gh, posts, uploads };
}
const subject = (dir: string) => ({ lease: lease(), cardName: 'Cart page', dir: path.join(dir, 'tree'), baseCommit: 'd'.repeat(40), baseBranch: 'main' });
const quiet = () => {};
const BRANCH = 'opora/card-0123456/execution-1';

test('the flag is on by default and off only for off/0/false/no; the worker is told the pinned, offline commands', () => {
  assert.equal(prLensEnabled({}), true);
  assert.equal(prLensEnabled({ AGENT_OFFICE_OPORA_PR_LENS: 'on' }), true);
  for (const off of ['off', '0', 'false', 'NO']) assert.equal(prLensEnabled({ AGENT_OFFICE_OPORA_PR_LENS: off }), false, off);
  const brief = prLensInstructions();
  assert.match(brief, /@coldtea\/pr-lens-cli@0\.13\.2 -p @coldtea\/pr-lens-renderer@0\.3\.2 pr-lens validate \.pr-lens\/graph\.json/);
  assert.match(brief, /render \.pr-lens\/graph\.json --theme light --out \.pr-lens\/render/);
  assert.match(brief, /Never run `analyze`, `canvas` or `auth`/);
  assert.match(brief, /read your validated spec \(\.pr-lens\/render\/drawn\.graph\.json\) instead of screenshots/);
});

test('detection picks the architecture overview from the manifest, with a clean alt text', (t) => {
  const dir = directory(t), tree = path.join(dir, 'tree');
  assert.equal(findLensDiagram(tree), undefined, 'no render: nothing');
  render(tree);
  const found = findLensDiagram(tree)!;
  assert.equal(found.file, SVG);
  assert.equal(found.alt, 'PR Lens architecture · overview: Batch broadcast sends');
  assert.match(found.validatedAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(found.spec.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(found.spec.text).nodes[0].files[0].path, 'src/a.ts');
});

test('an invalid render is not attached: wrong kind, unsafe path, script or external reference in the SVG', (t) => {
  const tree = path.join(directory(t), 'tree');
  render(tree, { manifest: { kind: 'graph', assets: [] } });
  assert.equal(findLensDiagram(tree), undefined);
  render(tree, { manifest: { kind: 'render-manifest', assets: [{ lens: 'architecture', view: 'overview', mediaType: 'image/svg+xml', path: '../../secret.svg' }] } });
  assert.equal(findLensDiagram(tree), undefined);
  render(tree, { spec: { kind: 'patch' } });
  assert.equal(findLensDiagram(tree), undefined, 'the drawn spec must be a graph document');
  for (const svg of ['<svg><script>alert(1)</script></svg>', '<svg><image href="https://evil.example/x.png"/></svg>', '<svg onload="x()"></svg>', 'not an svg']) {
    render(tree, { svg });
    assert.equal(findLensDiagram(tree), undefined, svg);
  }
});

test('the gh commands are argument lists for execFile, and the URL and body section are where Canvas and reviewers expect them', () => {
  const args = lensGhArgs('Pletor/shop', BRANCH, HEAD, SVG, '/tmp/in.json');
  assert.deepEqual(args.createRef, ['api', '-X', 'POST', 'repos/Pletor/shop/git/refs', '-f', `ref=refs/heads/pr-lens/${BRANCH}`, '-f', `sha=${HEAD}`]);
  assert.deepEqual(args.moveRef, ['api', '-X', 'PATCH', `repos/Pletor/shop/git/refs/heads/pr-lens/${BRANCH}`, '-f', `sha=${HEAD}`, '-F', 'force=true']);
  assert.deepEqual(args.putSpec, ['api', '-X', 'PUT', 'repos/Pletor/shop/contents/.pr-lens/spec.json', '--input', '/tmp/in.json']);
  assert.deepEqual(args.put, ['api', '-X', 'PUT', `repos/Pletor/shop/contents/.pr-lens/${SVG}`, '--input', '/tmp/in.json']);
  assert.equal(lensUrl('Pletor/shop', SIDE, SVG), `https://github.com/Pletor/shop/raw/${SIDE}/.pr-lens/${SVG}`);
  assert.equal(withLensSection('## Summary\n\nx\n\n---\n\nOpened by\n\nOpora-Card: c', '## PR Lens'), '## Summary\n\nx\n\n## PR Lens\n\n---\n\nOpened by\n\nOpora-Card: c');
});

test('handoff with a valid diagram: side branch, image in the body before the trailers, evidence to Canvas', async (t) => {
  const dir = directory(t);
  render(path.join(dir, 'tree'));
  const f = fakes();
  const out = await new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools).handOff(subject(dir), quiet)!;
  assert.equal(out.state, 'opened');
  assert.ok(f.gh.some((a) => a[2] === 'POST' && a[3] === 'repos/Pletor/shop/git/refs'));
  assert.equal(f.uploads.length, 2, 'the spec, then the picture');
  assert.equal(f.uploads[0].branch, `pr-lens/${BRANCH}`);
  assert.equal(JSON.parse(Buffer.from(String(f.uploads[0].content), 'base64').toString()).kind, 'graph');
  assert.match(String(f.uploads[1].content), /^[A-Za-z0-9+/=]+$/);
  const body = f.gh.find((a) => a[1] === 'create')!.at(-1)!;
  const url = `https://github.com/Pletor/shop/raw/${SIDE}/.pr-lens/${SVG}`, specUrl = `https://github.com/Pletor/shop/raw/${SIDE}/.pr-lens/spec.json`;
  assert.ok(body.includes(`[spec](${specUrl})`));
  assert.ok(body.includes(`## PR Lens\n\n![PR Lens architecture · overview: Batch broadcast sends](${url})`));
  assert.ok(body.endsWith('Opora-Card: card-0123456789abcdef'), 'the trailers stay last');
  const lens = f.posts.find((p) => p.url.endsWith('/api/oporahub/review-jobs/lens'))!;
  const sent = lens.body.lens as Record<string, unknown>;
  assert.match(String(sent.specSha256), /^[a-f0-9]{64}$/);
  assert.deepEqual({ ...lens.body, lens: { ...sent, validatedAt: 'x', specSha256: 'h', specBytes: 1 } },
    { project: 'project', workspace: 'work', executionId: 'execution-1', lens: { url, prNumber: 42, headSha: HEAD, validatedAt: 'x', specUrl, specSha256: 'h', specBytes: 1,
      spec: { kind: 'graph', title: 'Batch [broadcast] sends', nodes: [{ id: 'n', files: [{ path: 'src/a.ts', startLine: 1, endLine: 9 }] }] } } });
  assert.deepEqual(readdirSync(path.join(dir, 'opora-executions')).filter((n) => n.includes('lens')), [], 'the upload file is removed');
});

test('a side branch that exists is moved to the head; a reused PR gets the diagram as a comment', async (t) => {
  const dir = directory(t);
  render(path.join(dir, 'tree'));
  const f = fakes({ refExists: true, existing: { number: 7, url: 'https://github.com/Pletor/shop/pull/7' } });
  const out = await new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools).handOff(subject(dir), quiet)!;
  assert.equal(out.state, 'reused');
  assert.ok(f.gh.some((a) => a[2] === 'PATCH'));
  const comment = f.gh.find((a) => a[0] === 'pr' && a[1] === 'comment')!;
  assert.deepEqual(comment.slice(0, 5), ['pr', 'comment', '7', '--repo', 'Pletor/shop']);
  assert.match(comment.at(-1)!, /## PR Lens/);
});

test('flag off, no diagram, or a Canvas without the lens endpoint: the PR goes out exactly as before', async (t) => {
  for (const [name, setup, env, lensStatus] of [
    ['off', true, { AGENT_OFFICE_OPORA_PR_LENS: 'off' }, 200],
    ['missing', false, {}, 200],
  ] as const) {
    const dir = directory(t);
    if (setup) render(path.join(dir, 'tree'));
    const f = fakes({ env, lensStatus });
    const out = await new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools).handOff(subject(dir), quiet)!;
    assert.equal(out.state, 'opened', name);
    assert.ok(!f.gh.some((a) => a[0] === 'api'), `${name}: no upload`);
    assert.ok(!f.gh.find((a) => a[1] === 'create')!.at(-1)!.includes('PR Lens'), `${name}: no section`);
    assert.ok(!f.posts.some((p) => p.url.endsWith('/lens')), `${name}: no evidence`);
  }
  const dir = directory(t);
  render(path.join(dir, 'tree'));
  const f = fakes({ lensStatus: 404 });
  const out = await new PullRequestHandoff(dir, 'http://127.0.0.1:8740', 'office-1', f.tools).handOff(subject(dir), quiet)!;
  assert.equal(out.state, 'opened');
  assert.ok(out.state === 'opened' && out.link === 'linked', 'a 404 on /lens never touches the handoff');
});

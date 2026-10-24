import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { KnownFinding, ReviewJob } from '../src/server/opora/review-client.js';
import { ReviewPoster, reviewBody, reviewMarker, STALE_PENDING_MS } from '../src/server/opora/review-github.js';
import { groupFindings, sameBug } from '../src/server/opora/review-dedupe.js';
import { patchLines } from '../src/server/opora/review-diff-lines.js';
import { parseAnswer } from '../src/server/opora/review-output.js';
import { ANSWER_ONLY, FINDER_SYSTEM, VOTER_SYSTEM, finderPrompt } from '../src/server/opora/review-prompt.js';
import { SECURITY_FINDER_SYSTEM, SECURITY_VOTER_SYSTEM } from '../src/server/opora/review-kinds.js';

const HEAD = 'c'.repeat(40);
const done = (over: Partial<ReviewJob> = {}): ReviewJob => ({ reviewJobId: 'rj_1', repository: 'Pletor/shop', number: 7, baseSha: 'b'.repeat(40), headSha: HEAD,
  round: 1, sinceSha: null, phase: 'completed', ...over });
const finding = (id: string, over: Partial<KnownFinding>): KnownFinding => ({ findingId: id, fingerprint: `rv:x:${id}`, status: 'open', severity: 'nit', reviewJobId: 'rj_1', rationale: 'why', ...over });

/**
 * A fake GitHub behind `gh api`, shared by every poster like the real one: one account, so its pending
 * reviews are visible to it and it may have only one pending review per pull request; inline comments
 * on lines outside the diff refuse the whole review (422).
 */
function github(patch = '@@ -1,3 +1,4 @@\n line1\n+line2\n line3\n line4') {
  const reviews: { id: number; state: string; body: string; comments: { path: string; line: number }[] }[] = [];
  const calls: { args: string[]; input?: Record<string, unknown> }[] = [];
  let next = 100;
  /** Lets a test run code between a poster's calls (to stage a race). */
  const hooks: ((args: string[]) => Promise<void> | void)[] = [];
  const diff = new Map([['src/c.ts', patchLines(patch)]]);
  const gh = async (args: string[]) => {
    for (const h of hooks.splice(0)) await h(args);
    const at = args.indexOf('--input');
    const input = at >= 0 ? JSON.parse(readFileSync(args[at + 1], 'utf8')) : undefined;
    calls.push({ args, input });
    const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
    const url = args.find((a) => a.startsWith('repos/'))!;
    if (url.endsWith('/files')) return `${JSON.stringify({ filename: 'src/c.ts', patch })}\n${JSON.stringify({ filename: 'img.png' })}\n`;
    const id = Number(/reviews\/(\d+)/.exec(url)?.[1]);
    if (method === 'GET') {
      const marker = /contains\((".*?")\)/.exec(args.at(-1)!)![1];
      return reviews.filter((r) => r.body.includes(JSON.parse(marker))).map((r) => JSON.stringify({ id: r.id, state: r.state, body: r.body })).join('\n');
    }
    if (method === 'POST' && url.endsWith('/events')) { reviews.find((r) => r.id === id)!.state = 'COMMENTED'; return '{}'; }
    if (method === 'POST') {
      if (reviews.some((r) => r.state === 'PENDING')) throw new Error('gh: Unprocessable Entity (HTTP 422) User can only have one pending review per pull request');
      const comments = (input.comments ?? []) as { path: string; line: number }[];
      if (comments.some((c) => !diff.get(c.path)?.has(c.line))) throw new Error('gh: Unprocessable Entity (HTTP 422) Pull request review thread line must be part of the diff');
      const r = { id: next++, state: input.event ? 'COMMENTED' : 'PENDING', body: input.body, comments };
      reviews.push(r);
      return JSON.stringify({ id: r.id });
    }
    if (method === 'PUT') { reviews.find((r) => r.id === id)!.body = input.body; return '{}'; }
    if (method === 'DELETE') { reviews.splice(reviews.findIndex((r) => r.id === id), 1); return '{}'; }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { gh, reviews, calls, hooks };
}

function dir(t: { after(fn: () => void): void }) {
  const d = mkdtempSync(path.join(tmpdir(), 'office-review-post-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test('two offices posting the same completed round at the same moment leave exactly one GitHub review', async (t) => {
  const d = dir(t);
  const hub = github();
  const findings = [finding('rf_1', { path: 'src/c.ts', line: 2, title: 'Race on save' })];
  // Two offices with their own state files (as on ports 4600 and 4650), on one gh account.
  const a = new ReviewPoster(hub.gh, path.join(d, 'a', 'posted.json'), { lanes: new Map() });
  const b = new ReviewPoster(hub.gh, path.join(d, 'b', 'posted.json'), { lanes: new Map() });
  const outcomes = await Promise.all([a.post(done(), findings), b.post(done(), findings)]);
  assert.equal(hub.reviews.length, 1, 'one review on GitHub');
  assert.equal(hub.reviews[0].state, 'COMMENTED');
  assert.deepEqual(outcomes.sort(), ['busy', 'posted']);
  // The office that waited sees the submitted review on its next pass and leaves it alone (same body).
  for (const p of [a, b]) assert.equal(await p.post(done(), findings), 'unchanged');
  assert.equal(hub.reviews.length, 1);
  assert.ok(!hub.calls.some((c) => JSON.stringify(c.input ?? {}).match(/APPROVE|REQUEST_CHANGES/)));
});

test('the second office checking between the first one\'s open and submit waits instead of posting', async (t) => {
  const d = dir(t);
  const hub = github();
  const findings = [finding('rf_1', { path: 'src/c.ts', line: 2, title: 'Race on save' })];
  const a = new ReviewPoster(hub.gh, path.join(d, 'a.json'), { lanes: new Map() });
  const b = new ReviewPoster(hub.gh, path.join(d, 'b.json'), { lanes: new Map() });
  let second: Promise<string> | undefined;
  // Right before A submits its pending review, B runs a whole pass.
  const waitForSubmit = async (args: string[]) => { if (args.some((x) => x.endsWith('/events'))) await (second = b.post(done(), findings)); else hub.hooks.push(waitForSubmit); };
  hub.hooks.push(waitForSubmit);
  assert.equal(await a.post(done(), findings), 'posted');
  assert.equal(await second, 'busy');
  assert.equal(hub.reviews.length, 1);
  assert.equal(await b.post(done(), findings), 'unchanged');
});

test('a round already posted is updated in place, also by another office and when it already has duplicates', async (t) => {
  const d = dir(t);
  const hub = github();
  const findings = [finding('rf_1', { path: 'src/c.ts', line: 2, title: 'Race on save' })];
  const a = new ReviewPoster(hub.gh, path.join(d, 'a.json'));
  assert.equal(await a.post(done(), findings), 'posted');
  // Two reviews from before this fix: the oldest one is kept up to date, no third one appears.
  hub.reviews.push({ id: 999, state: 'COMMENTED', body: hub.reviews[0].body, comments: [] });
  findings[0].status = 'fixed';
  const b = new ReviewPoster(hub.gh, path.join(d, 'b.json'));
  assert.equal(await b.post(done(), findings), 'updated');
  assert.equal(hub.reviews.length, 2);
  assert.match(hub.reviews[0].body, /\(fixed\)/);
  const put = hub.calls.filter((c) => c.args.includes('PUT'));
  assert.equal(put.length, 1);
  assert.ok(put[0].args.some((x) => x.endsWith(`/reviews/${hub.reviews[0].id}`)));
  assert.equal(await b.post(done(), findings), 'unchanged');
});

test('a pending review its poster never submitted is submitted after a while, not duplicated', async (t) => {
  const d = dir(t);
  const hub = github();
  const findings = [finding('rf_1', { title: 'No line' })];
  hub.reviews.push({ id: 50, state: 'PENDING', body: `${reviewMarker('rj_1')}\nold`, comments: [] });
  let now = 1_000;
  const p = new ReviewPoster(hub.gh, path.join(d, 'p.json'), { now: () => now });
  assert.equal(await p.post(done(), findings), 'busy');
  now += STALE_PENDING_MS;
  assert.equal(await p.post(done(), findings), 'posted');
  assert.deepEqual(hub.reviews.map((r) => [r.id, r.state]), [[50, 'COMMENTED']]);
});

test('inline comments: only lines inside the diff get one, the rest are logged and stay in the body; a refusal falls back to the body alone', async (t) => {
  const d = dir(t);
  const hub = github();
  const logs: string[] = [];
  const findings = [
    finding('rf_in', { severity: 'important', path: 'src/c.ts', line: 2, title: 'Null deref of user' }),
    finding('rf_out', { path: 'src/other.ts', line: 174, title: 'Classifier sees hidden text' }),
  ];
  const p = new ReviewPoster(hub.gh, path.join(d, 'p.json'), { log: (m) => logs.push(m) });
  assert.equal(await p.post(done(), findings), 'posted');
  assert.deepEqual(hub.reviews[0].comments.map((c) => [c.path, c.line]), [['src/c.ts', 2]]);
  assert.match(hub.reviews[0].body, /`rf_out` `src\/other\.ts:174`/);
  assert.ok(logs.some((m) => /1 finding\(s\) .* outside the pull request's diff \(src\/other\.ts:174\)/.test(m)));

  // The diff can't be read, and GitHub refuses the comments: the review still goes out once, with the body alone, and says why.
  const hub2 = github();
  const gh2 = async (args: string[]) => { if (args.some((a) => a.endsWith('/files'))) throw new Error('rate limited'); return hub2.gh(args); };
  const logs2: string[] = [];
  const p2 = new ReviewPoster(gh2, path.join(d, 'p2.json'), { log: (m) => logs2.push(m) });
  assert.equal(await p2.post(done(), findings), 'posted');
  assert.equal(hub2.reviews.length, 1);
  assert.deepEqual(hub2.reviews[0].comments, []);
  assert.ok(logs2.some((m) => /refused the inline comments .* body only/.test(m)));
});

test('the diff\'s commentable lines are the new side\'s added and context lines inside hunks', () => {
  assert.deepEqual([...patchLines('@@ -10,3 +20,4 @@ fn\n ctx\n-old\n+new\n+new2\n ctx2\n\\ No newline at end of file\n@@ -50 +60 @@\n+x')], [20, 21, 22, 23, 60]);
});

test('the same bug from several finders is shown once, listing the others; different bugs stay apart', () => {
  const findings = [
    finding('rf_a', { path: 'docs/gaps.md', line: 15, title: 'Summary counts (🔀 9 · ❌ 17) don\'t match the gap table, which has 🔀 7 and ❌ 19' }),
    finding('rf_b', { path: 'docs/gaps.md', line: 15, title: 'Summary counts (🔀 9 · ❌ 17) disagree with the gap table, which shows 🔀 7 and ❌ 19' }),
    finding('rf_c', { path: 'docs/gaps.md', line: 15, title: 'Summary count for chapters 3.3–3.40 says 9 \'renamed\' and 17 \'missing\', but the table has 7 and 19' }),
    finding('rf_d', { path: 'svc.py', line: 556, title: 'Concurrent mapping saves compute the same next_version and the loser fails with an unhandled RuntimeError (500)' }),
    finding('rf_e', { path: 'svc.py', line: 560, title: 'Concurrent mapping saves can pick the same version number, and the second save fails with a 500' }),
    finding('rf_f', { path: 'svc.py', line: 570, title: 'Two saves at the same time can pick the same mapping version number and the losing save fails with a 500 error' }),
    finding('rf_g', { path: 'svc.py', line: 236, title: 'Dataset records already running when a mapping is saved are skipped, so they keep the old mapping with no follow-up rerun' }),
    finding('rf_h', { path: 'svc.py', line: 238, title: 'Records already being processed when a mapping is saved are skipped and never re-run, so they keep the old mapping' }),
    finding('rf_i', { path: 'html.py', line: 240, title: 'Hidden HTML, PPTX and DOCX content now reaches the structure and classification phases, which only filter by role, not attributes.hidden' }),
    finding('rf_j', { path: 'html.py', line: 251, title: '_take_hidden decomposes a hidden ancestor, then still uses already-collected descendant nodes that were freed' }),
    finding('rf_k', { path: 'svc.py', line: 900, title: 'Concurrent mapping saves compute the same next_version' }),
    finding('rf_l', { path: 'docs/gaps.md', line: 15, status: 'fixed', title: 'Summary counts don\'t match the gap table' }),
  ];
  const groups = groupFindings(findings);
  assert.deepEqual(groups.map((g) => [g.lead.findingId, ...g.also.map((f) => f.findingId)]),
    [['rf_a', 'rf_b', 'rf_c'], ['rf_d', 'rf_e', 'rf_f'], ['rf_g', 'rf_h'], ['rf_i'], ['rf_j'], ['rf_k'], ['rf_l']]);
  assert.ok(!sameBug(findings[0], findings[3]));
  const body = reviewBody(done(), findings.map((f) => ({ ...f, severity: f.findingId === 'rf_c' ? 'important' : f.severity })));
  // The worst severity leads its cluster; the others are named under it, not listed again.
  assert.match(body, /- \*\*\[important\]\*\* `rf_c` `docs\/gaps\.md:15`[^\n]*\n {2}Reported by 3 finders; also `rf_a` \(`docs\/gaps\.md:15`\), `rf_b`/);
  assert.equal(body.split('\n').filter((l) => l.startsWith('- ')).length, 7);
});

test('the reviewer prompts ask for the bare JSON object, and the parser keeps refusing prose around it', () => {
  for (const system of [FINDER_SYSTEM, VOTER_SYSTEM, SECURITY_FINDER_SYSTEM, SECURITY_VOTER_SYSTEM]) assert.ok(system.endsWith(ANSWER_ONLY));
  const a = { reviewJobId: 'rj_1', taskId: 't', role: 'finder' as const, slot: 0, token: 'f'.repeat(64), epoch: 1, expiresAt: 1, serverNow: 1, job: done({ phase: 'find' }), knownFindings: [] };
  assert.match(finderPrompt(a, { diff: '', files: [], base: 'b'.repeat(40), incremental: false }), /first character "\{", the last "\}"\.$/);
  assert.deepEqual(parseAnswer('```json\n{"findings":[]}\n```'), { findings: [] });
  assert.throws(() => parseAnswer('Here is my review:\n```json\n{"findings":[]}\n```'));
});

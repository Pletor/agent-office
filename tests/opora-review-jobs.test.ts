import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReviewJobClient, type KnownFinding, type ReviewAssignment, type ReviewJob } from '../src/server/opora/review-client.js';
import { ReviewBudget, reviewConfig } from '../src/server/opora/review-config.js';
import { checkFinder, checkVoter, findingFingerprint, parseAnswer } from '../src/server/opora/review-output.js';
import { claudeReviewArgs, type ReviewRun } from '../src/server/opora/review-agent.js';
import { runSlot, submitRequestId } from '../src/server/opora/review-slot.js';
import { ReviewPoster, reviewMarker } from '../src/server/opora/review-github.js';
import { ReviewJobRunner } from '../src/server/opora/review-runner.js';
import type { Checkout } from '../src/server/opora/review-checkout.js';

const HEAD = 'c'.repeat(40), BASE = 'b'.repeat(40), TOKEN = 'f'.repeat(64);
const scope = { project: 'shop', workspace: 'work' };
const job = (over: Partial<ReviewJob> = {}): ReviewJob => ({ reviewJobId: 'rj_1', executionId: 'ex_1', cardId: 'card', repository: 'Pletor/shop', number: 7,
  baseSha: BASE, headSha: HEAD, round: 1, sinceSha: null, phase: 'find', ...over });
const known: KnownFinding[] = [
  { findingId: 'rf_open', fingerprint: 'rv:null-deref:aaaaaaaaaaaaaaaaaaaaaaaa', status: 'open', severity: 'important', path: 'src/a.ts', line: 3, title: 'Old bug', rationale: 'x' },
  { findingId: 'rf_fixed', fingerprint: findingFingerprint('src/b.ts', 'Already fixed bug', 'off-by-one'), status: 'fixed', severity: 'nit' },
];
const assignment = (role: 'finder' | 'voter', over: Partial<ReviewAssignment> = {}): ReviewAssignment => ({
  reviewJobId: 'rj_1', taskId: `rt_${role}_0`, role, slot: 0, token: TOKEN, epoch: 2, expiresAt: 2000, serverNow: 1000,
  job: job({ phase: role === 'finder' ? 'find' : 'vote' }), knownFindings: known,
  ...(role === 'voter' ? { candidates: [
    { candidateId: 'rc_1', kind: 'finding', fingerprint: 'rv:x:1', path: 'src/c.ts', line: 9, severity: 'important', title: 'Race', rationale: 'r', finders: [0] },
    { candidateId: 'rc_2', kind: 'fix', findingId: 'rf_open', rationale: 'fixed', finders: [1] },
  ] } : {}), ...over });

/** A fake Canvas: records every call, answers from `answers` by path suffix (a function, an object or a status). */
function canvas(answers: Record<string, unknown> = {}) {
  const calls: { path: string; body: Record<string, unknown> | undefined; actor: string | null }[] = [];
  const transport = (async (url: URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: u.pathname, body, actor: new Headers(init?.headers).get('X-Opora-Actor') });
    const key = Object.keys(answers).find((k) => u.pathname.endsWith(k)) ?? '';
    let a = answers[key];
    if (typeof a === 'function') a = (a as (b: unknown) => unknown)(body);
    if (typeof a === 'number') return new Response(JSON.stringify({ code: a === 409 ? 'review_jobs_disabled' : 'x' }), { status: a });
    return new Response(JSON.stringify(a ?? {}), { status: 200 });
  }) as typeof fetch;
  return { client: new ReviewJobClient('http://127.0.0.1:8740', 'office-f-review', transport), calls };
}
const receipt = (b: { requestId?: string }) => ({ reviewJobId: 'rj_1', taskId: 'rt_finder_0', role: 'finder', state: 'submitted', phase: 'vote', serverNow: 1, requestId: b?.requestId });
const fakeCheckout = (cleaned: string[]) => async (a: ReviewAssignment): Promise<Checkout> => ({
  dir: `/tmp/${a.taskId}`, base: BASE, diff: 'diff --git a/src/c.ts b/src/c.ts\n+bad()', files: ['src/c.ts'], incremental: false, cleanup: async () => { cleaned.push(a.taskId); } });
const quiet = () => {};

test('config is off by default; limits clamp; the budget holds parallel and hourly caps', () => {
  assert.equal(reviewConfig({}).enabled, false);
  const c = reviewConfig({ AGENT_OFFICE_OPORA_REVIEWS: 'on', AGENT_OFFICE_OPORA_REVIEW_PARALLEL: '99', AGENT_OFFICE_OPORA_REVIEW_PER_HOUR: '3', AGENT_OFFICE_OPORA_REVIEW_POST: 'off' });
  assert.deepEqual([c.enabled, c.maxParallel, c.maxPerHour, c.post], [true, 8, 3, false]);
  let now = 0;
  const b = new ReviewBudget({ maxParallel: 2, maxPerHour: 3 }, () => now);
  assert.equal(b.blocked(2), 'parallel');
  b.started(); b.started(); b.started();
  assert.equal(b.blocked(0), 'hourly');
  now = 3_600_001;
  assert.equal(b.blocked(0), undefined);
});

test('finder output: validated in code, fingerprint computed deterministically, known findings dropped, fixed only for open ones', () => {
  assert.equal(findingFingerprint('src/c.ts', 'Null deref of `user`!', 'Null-Deref'), findingFingerprint('src/c.ts', 'null deref of user', 'null-deref'));
  assert.match(findingFingerprint('src/c.ts', 'x', 'y'), /^[A-Za-z0-9_.:/#@-]{8,160}$/);
  const ok = checkFinder({ findings: [
    { path: './src/c.ts', line: 9, severity: 'nit', bugClass: 'race', title: 'Race on save', rationale: 'two writers' },
    { path: 'src/c.ts', line: 10, severity: 'important', bugClass: 'race', title: 'race on SAVE', rationale: 'same bug, worse' },
    { path: 'src/b.ts', severity: 'nit', bugClass: 'off-by-one', title: 'Already fixed bug', rationale: 'known' },
  ], fixed: [{ findingId: 'rf_open', rationale: 'guarded now' }] }, known);
  assert.ok(ok.ok);
  assert.equal(ok.value.findings.length, 1);
  assert.deepEqual({ ...ok.value.findings[0], fingerprint: undefined }, { path: 'src/c.ts', line: 10, severity: 'important', fingerprint: undefined, title: 'race on SAVE', rationale: 'same bug, worse' });
  assert.deepEqual(ok.value.fixed, [{ findingId: 'rf_open', rationale: 'guarded now' }]);
  const bad = checkFinder({ findings: [{ path: '/etc/passwd', severity: 'fatal', title: '', rationale: 'r' }], fixed: [{ findingId: 'rf_fixed', rationale: 'r' }] }, known);
  assert.ok(!bad.ok);
  assert.ok(bad.errors.some((e) => e.includes('path')) && bad.errors.some((e) => e.includes('severity')) && bad.errors.some((e) => e.includes('open known')));
  assert.throws(() => parseAnswer('Here you go: {"findings":[]}'));
  assert.deepEqual(parseAnswer('```json\n{"findings":[]}\n```'), { findings: [] });
});

test('voter output must cover every candidate exactly once', () => {
  const cands = assignment('voter').candidates!;
  assert.ok(!checkVoter({ votes: [{ candidateId: 'rc_1', verdict: 'confirm' }] }, cands).ok);
  assert.ok(!checkVoter({ votes: [{ candidateId: 'rc_1', verdict: 'confirm' }, { candidateId: 'rc_1', verdict: 'reject' }, { candidateId: 'rc_2', verdict: 'reject' }] }, cands).ok);
  assert.ok(!checkVoter({ votes: [{ candidateId: 'rc_1', verdict: 'maybe' }, { candidateId: 'rc_2', verdict: 'reject' }] }, cands).ok);
  const ok = checkVoter({ votes: [{ candidateId: 'rc_2', verdict: 'reject', rationale: '' }, { candidateId: 'rc_1', verdict: 'confirm', rationale: 'line 9 races' }] }, cands);
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.votes.map((v) => v.candidateId), ['rc_1', 'rc_2']);
});

test('claim → finder → submit: one fresh run, the token never in the prompt, deterministic request id, checkout cleaned', async () => {
  const { client, calls } = canvas({ '/submit': receipt });
  const runs: ReviewRun[] = [];
  const cleaned: string[] = [];
  const a = assignment('finder');
  const outcome = await runSlot(scope, a, { client, ttlSeconds: 600, log: quiet, checkout: fakeCheckout(cleaned),
    agent: async (run) => { runs.push(run); return JSON.stringify({ findings: [{ path: 'src/c.ts', line: 1, severity: 'important', bugClass: 'injection', title: 'SQL injection', rationale: 'concatenated' }], fixed: [] }); } });
  assert.equal(outcome, 'submitted');
  assert.equal(runs.length, 1);
  assert.ok(!runs[0].prompt.includes(TOKEN) && !runs[0].system.includes(TOKEN));
  assert.match(runs[0].prompt, /<<<DATA[\s\S]*\+bad\(\)[\s\S]*DATA>>>/);
  assert.equal(runs[0].cwd, '/tmp/rt_finder_0');
  const submit = calls.find((c) => c.path.endsWith('/rj_1/tasks/rt_finder_0/submit'))!;
  assert.deepEqual(Object.keys(submit.body!).sort(), ['epoch', 'project', 'requestId', 'submission', 'token', 'workspace']);
  assert.equal(submit.body!.requestId, submitRequestId(a));
  assert.equal(submitRequestId(a), submitRequestId({ ...a }));
  assert.match(String(submit.body!.requestId), /^[A-Za-z0-9_-]{1,80}$/);
  assert.equal(submit.actor, 'agent; name=office-f-review');
  const sub = submit.body!.submission as { findings: { fingerprint: string }[] };
  assert.equal(sub.findings[0].fingerprint, findingFingerprint('src/c.ts', 'SQL injection', 'injection'));
  assert.deepEqual(cleaned, ['rt_finder_0']);
});

test('voter slot covers every candidate; an invalid answer gets one fresh repair run, then the slot is released', async () => {
  const { client, calls } = canvas({ '/submit': () => ({ ...receipt({}), taskId: 'rt_voter_0' }), '/release': { state: 'open' } });
  const runs: ReviewRun[] = [];
  const answers = ['{"votes":[{"candidateId":"rc_1","verdict":"confirm"}]}', '{"votes":[{"candidateId":"rc_1","verdict":"confirm"},{"candidateId":"rc_2","verdict":"reject","rationale":"not fixed"}]}'];
  const ok = await runSlot(scope, assignment('voter'), { client, ttlSeconds: 600, log: quiet, checkout: fakeCheckout([]), agent: async (r) => { runs.push(r); return answers[runs.length - 1]; } });
  assert.equal(ok, 'submitted');
  assert.equal(runs.length, 2);
  assert.match(runs[1].prompt, /no vote on candidate rc_2/);
  const votes = (calls.find((c) => c.path.endsWith('/submit'))!.body!.submission as { votes: { candidateId: string }[] }).votes;
  assert.deepEqual(votes.map((v) => v.candidateId), ['rc_1', 'rc_2']);

  const again = canvas({ '/release': { state: 'open' } });
  let n = 0;
  const released = await runSlot(scope, assignment('voter'), { client: again.client, ttlSeconds: 600, log: quiet, checkout: fakeCheckout([]), agent: async () => { n++; return 'not json'; } });
  assert.equal(released, 'released');
  assert.equal(n, 2);
  assert.ok(again.calls.some((c) => c.path.endsWith('/release')) && !again.calls.some((c) => c.path.endsWith('/submit')));
});

test('heartbeats run while the model works; a lost lease aborts it without submitting or releasing', async () => {
  const live = canvas({ '/heartbeat': { epoch: 2, expiresAt: 3000 }, '/submit': receipt });
  const out = await runSlot(scope, assignment('finder'), { client: live.client, ttlSeconds: 600, heartbeatMs: 5, log: quiet, checkout: fakeCheckout([]),
    agent: async () => { await new Promise((r) => setTimeout(r, 40)); return '{"findings":[]}'; } });
  assert.equal(out, 'submitted');
  assert.ok(live.calls.filter((c) => c.path.endsWith('/heartbeat')).length >= 2);
  assert.equal(live.calls.find((c) => c.path.endsWith('/heartbeat'))!.body!.ttlSeconds, 600);

  const gone = canvas({ '/heartbeat': 409 });
  const lost = await runSlot(scope, assignment('finder'), { client: gone.client, ttlSeconds: 600, heartbeatMs: 5, log: quiet, checkout: fakeCheckout([]),
    agent: (r) => new Promise((_, reject) => r.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  assert.equal(lost, 'lost');
  assert.ok(!gone.calls.some((c) => c.path.endsWith('/submit') || c.path.endsWith('/release')));
});

function runnerWith(answers: Record<string, unknown>, over: { now?: () => number; gh?: (args: string[]) => Promise<string>; parallel?: number; post?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-review-'));
  const fake = canvas(answers);
  const runs: ReviewRun[] = [];
  const logs: string[] = [];
  const config = { ...reviewConfig({ AGENT_OFFICE_OPORA_REVIEWS: 'on' }), maxParallel: over.parallel ?? 2, post: over.post ?? false };
  const runner = new ReviewJobRunner(config, dir, dir, {
    client: fake.client, now: over.now ?? Date.now, gh: over.gh ?? (async () => ''),
    git: async () => { throw new Error('no git in this test'); },
    agent: async (r) => { runs.push(r); return '{"findings":[]}'; },
  }, (m) => logs.push(m));
  // The checkout is git's; this test swaps in the fake one.
  (runner as unknown as { checkout: (a: ReviewAssignment) => Promise<Checkout> }).checkout = fakeCheckout([]);
  return { runner, runs, logs, dir, ...fake };
}

test('the runner claims up to its parallel limit, each slot in its own fresh run, and stops when Canvas has nothing', async (t) => {
  let n = 0;
  const { runner, runs, calls, dir } = runnerWith({
    '/claim': () => (n++ < 3 ? { task: { ...assignment('finder'), taskId: `rt_${n}`, slot: n } } : { task: null }),
    '/submit': (b: { requestId: string }) => ({ ...receipt(b), taskId: calls.at(-1)!.path.split('/')[6] }),
  }, { parallel: 2 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await runner.tick(scope);
  assert.equal(calls.filter((c) => c.path.endsWith('/claim')).length, 2);
  const claim = calls.find((c) => c.path.endsWith('/claim'))!.body!;
  assert.deepEqual(Object.keys(claim).sort(), ['project', 'requestId', 'ttlSeconds', 'workspace']);
  await runner.idle();
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0], runs[1]);
  assert.notEqual(runs[0].cwd, runs[1].cwd);
  assert.equal(calls.filter((c) => c.path.endsWith('/submit')).length, 2);
});

test('Canvas with review jobs off (409) makes the runner back off quietly, then ask again', async (t) => {
  let now = 1_000;
  const { runner, calls, logs, dir } = runnerWith({ '/claim': 409 }, { now: () => now });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await runner.tick(scope);
  await runner.tick(scope);
  assert.equal(calls.filter((c) => c.path.endsWith('/claim')).length, 1);
  assert.equal(logs.length, 1);
  now += 11 * 60_000;
  await runner.tick(scope);
  assert.equal(calls.filter((c) => c.path.endsWith('/claim')).length, 2);
  assert.equal(logs.length, 1, 'still quiet');
});

test('a completed job is posted once as a COMMENT review with inline comments; a second pass updates or skips, never duplicates', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-review-gh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls: { args: string[]; input?: Record<string, unknown> }[] = [];
  const { readFileSync } = await import('node:fs');
  let reviews: { id: number; body: string }[] = [];
  const gh = async (args: string[]) => {
    const at = args.indexOf('--input');
    const input = at >= 0 ? JSON.parse(readFileSync(args[at + 1], 'utf8')) : undefined;
    calls.push({ args, input });
    if (args.includes('--jq')) return reviews.filter((r) => r.body.includes(reviewMarker('rj_1'))).map((r) => r.id).join('\n');
    if (args.includes('POST')) { reviews.push({ id: 55, body: input.body }); return '{"id":55}'; }
    return '{}';
  };
  const done = job({ phase: 'completed' });
  const findings: KnownFinding[] = [
    { findingId: 'rf_9', fingerprint: 'rv:race:1', status: 'open', severity: 'important', reviewJobId: 'rj_1', path: 'src/c.ts', line: 9, title: 'Race on save @owner', rationale: 'two writers <!-- x -->' },
    { findingId: 'rf_8', fingerprint: 'rv:nit:1', status: 'open', severity: 'nit', reviewJobId: 'rj_1', path: 'src/d.ts', title: 'No line', rationale: 'r' },
    { findingId: 'rf_old', fingerprint: 'rv:old:1', status: 'open', severity: 'important', reviewJobId: 'rj_0', title: 'Older round', rationale: 'r' },
  ];
  const poster = new ReviewPoster(gh, path.join(dir, 'posted.json'));
  assert.equal(await poster.post(done, findings), 'posted');
  const post = calls.find((c) => c.args.includes('POST'))!;
  assert.equal(post.input!.event, 'COMMENT');
  assert.equal(post.input!.commit_id, HEAD);
  const body = String(post.input!.body);
  assert.ok(body.startsWith(reviewMarker('rj_1')));
  assert.match(body, /\*\*\[important\]\*\* `rf_9`/);
  assert.match(body, /\*\*\[nit\]\*\* `rf_8`/);
  assert.ok(!body.includes('rf_old') && !body.includes('<!-- x') && !body.includes('@owner'));
  assert.deepEqual((post.input!.comments as { path: string; line: number }[]).map((c) => [c.path, c.line]), [['src/c.ts', 9]]);
  assert.ok(!calls.some((c) => c.args.some((a) => /APPROVE|REQUEST_CHANGES|merge/i.test(a)) || JSON.stringify(c.input ?? {}).match(/APPROVE|REQUEST_CHANGES/)));

  assert.equal(await poster.post(done, findings), 'unchanged');
  // Lost local state (or another office): the marker finds the review, which is updated in place.
  const other = new ReviewPoster(gh, path.join(dir, 'other.json'));
  findings[0].status = 'fixed';
  assert.equal(await other.post(done, findings), 'updated');
  assert.equal(reviews.length, 1);
  assert.ok(calls.at(-1)!.args.includes('PUT') && calls.at(-1)!.args.some((a) => a.endsWith('/reviews/55')));
  await assert.rejects(poster.post(job({ phase: 'vote' }), findings));
});

test('the runner posts completed jobs from the listing', async (t) => {
  const posted: string[][] = [];
  const { runner, dir } = runnerWith({ '/claim': { task: null }, '/review-jobs': { enabled: true, jobs: [job({ phase: 'completed' }), job({ reviewJobId: 'rj_2', phase: 'vote' })], findings: [] } },
    { post: true, gh: async (args) => { posted.push(args); return args.includes('POST') ? '{"id":1}' : ''; } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await runner.tick(scope);
  assert.equal(posted.filter((a) => a.includes('POST')).length, 1);
  assert.ok(posted.every((a) => !a.join(' ').includes('rj_2')));
});

test('every slot runs claude as a fresh, read-only, session-less process', () => {
  const args = claudeReviewArgs('sys', 'opus');
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(!args.some((a) => /^--(?:continue|resume|session-id)$/.test(a) || a === '-c' || a === '-r'));
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
});

test('the checkout is a detached worktree at headSha, diffed from sinceSha in a later round, of the floor\'s own origin only, never pushed', async (t) => {
  const { prepareCheckout } = await import('../src/server/opora/review-checkout.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'office-review-co-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const SINCE = 'd'.repeat(40);
  const seen: string[][] = [];
  const git = async (args: string[]) => {
    seen.push(args);
    if (args[0] === 'remote') return 'git@github.com:Pletor/shop.git\n';
    if (args[0] === 'diff' && args.includes('--name-only')) return 'src/c.ts\n';
    if (args[0] === 'diff') return '+bad()';
    return '';
  };
  const co = await prepareCheckout(git, dir, path.join(dir, 'co'), job({ round: 2, sinceSha: SINCE }), 'rt_1-2');
  assert.deepEqual([co.base, co.incremental, co.files], [SINCE, true, ['src/c.ts']]);
  assert.ok(seen.some((a) => a.join(' ') === `worktree add --detach --force ${co.dir} ${HEAD}`));
  assert.ok(seen.some((a) => a[0] === 'diff' && a.at(-2) === SINCE && a.at(-1) === HEAD));
  await co.cleanup();
  assert.ok(seen.some((a) => a[0] === 'worktree' && a[1] === 'remove'));
  assert.ok(!seen.some((a) => ['push', 'commit', 'merge', 'reset'].includes(a[0])));
  await assert.rejects(prepareCheckout(git, dir, path.join(dir, 'co'), job({ repository: 'Someone/else' }), 'x'), /origin isn't Someone\/else/);
});

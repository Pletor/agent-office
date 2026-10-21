import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExecutionLease } from '../src/server/opora/execution-client.js';
import { executionPrompt } from '../src/server/opora/execution-prompt.js';
import { reportExecution } from '../src/server/opora/execution-worker.js';
import { ExecutionDispatch } from '../src/server/opora/execution-dispatch.js';
import type { ExecutionIntent } from '../src/server/opora/executors/types.js';
import { asMailbox, IsolatedPullRequests, patchInstructions } from '../src/server/opora/isolated-pull-request.js';
import type { IsolatedRun } from '../src/server/opora/isolated-storage.js';
import { PrUpkeep, type OporaPr } from '../src/server/opora/pr-upkeep.js';
import type { HandoffTools } from '../src/server/opora/pull-request-handoff.js';
import type { ReviewRun } from '../src/server/opora/review-agent.js';
import type { KnownFinding, ReviewAssignment, ReviewJob } from '../src/server/opora/review-client.js';
import { ReviewJobClient } from '../src/server/opora/review-client.js';
import { decide, parseCases, revertTargets, runEval, type EvalCase, type EvalOptions } from '../src/server/opora/review-eval.js';
import { dryRunAgent, main as evalMain, readVariant } from '../src/server/opora/review-eval-cli.js';
import { reviewBody } from '../src/server/opora/review-github.js';
import { reviewPrompts, SECURITY_FINDER_SYSTEM, SECURITY_VOTER_SYSTEM } from '../src/server/opora/review-kinds.js';
import { FINDER_SYSTEM, VOTER_SYSTEM } from '../src/server/opora/review-prompt.js';
import { runSlot } from '../src/server/opora/review-slot.js';
import type { Checkout } from '../src/server/opora/review-checkout.js';
import { executionScope, runSelfChecks, selfCheckCommands, SelfCheckReporter, upkeepSelfChecks, validSelfChecks, type ExecCheck } from '../src/server/opora/self-checks.js';
import { upkeepConfig } from '../src/server/opora/upkeep-config.js';
import { UpkeepLedger, type UpkeepTools } from '../src/server/opora/upkeep-tools.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const HEAD = 'c'.repeat(40), BASE = 'b'.repeat(40), REVERT = 'e'.repeat(40), PINNED = 'd'.repeat(40), TOKEN = 'f'.repeat(64);
const scope = { project: 'shop', workspace: 'work' };
const quiet = () => {};

function tmp(t: { after(fn: () => void): void }, name = 'office-sec-') {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake Canvas recording every request; `status` (or a function of the path) is its answer. */
function canvas(status: number | ((p: string) => number) = 200, body: unknown = {}) {
  const calls: { path: string; search: string; body?: Record<string, unknown>; actor: string | null }[] = [];
  const transport = (async (url: URL | string, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, search: u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined, actor: new Headers(init?.headers).get('X-Opora-Actor') });
    const s = typeof status === 'function' ? status(u.pathname) : status;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: s });
  }) as typeof fetch;
  return { transport, calls };
}

// ── a. security review prompt selection ─────────────────────────────────────────────────────────

const job = (over: Partial<ReviewJob> = {}): ReviewJob => ({ reviewJobId: 'rj_1', executionId: 'ex_1', cardId: 'card', repository: 'Pletor/shop', number: 7,
  baseSha: BASE, headSha: HEAD, round: 1, sinceSha: null, phase: 'find', ...over });
const finderTask = (over: Partial<ReviewJob> = {}): ReviewAssignment => ({ reviewJobId: 'rj_1', taskId: 'rt_f_0', role: 'finder', slot: 0, token: TOKEN, epoch: 1,
  expiresAt: 2000, serverNow: 1000, job: job(over), knownFindings: [] });
const checkout = (): Checkout => ({ dir: tmpdir(), base: BASE, diff: 'diff --git a/x b/x', files: ['src/auth.ts'], incremental: false, cleanup: async () => {} });

test('the job kind picks the prompts: code (or none) the code ones, security the security ones, anything else none', () => {
  assert.equal(reviewPrompts(undefined)?.finder, FINDER_SYSTEM);
  assert.equal(reviewPrompts('code')?.voter, VOTER_SYSTEM);
  const sec = reviewPrompts('security')!;
  assert.equal(sec.finder, SECURITY_FINDER_SYSTEM);
  assert.equal(sec.voter, SECURITY_VOTER_SYSTEM);
  assert.equal(sec.fingerprintPrefix, 'security');
  for (const topic of ['authorization', 'injection', 'secrets', 'path traversal', 'SSRF', 'deserialization', 'dependency']) assert.match(SECURITY_FINDER_SYSTEM, new RegExp(topic, 'i'), topic);
  assert.match(SECURITY_VOTER_SYSTEM, /exploitable/);
  assert.equal(reviewPrompts('performance'), undefined);
  assert.equal(reviewPrompts('security', { security: { finder: 'TRY THIS' } })?.finder, 'TRY THIS');
  assert.equal(reviewPrompts('code', { security: { finder: 'TRY THIS' } })?.finder, FINDER_SYSTEM, 'a variant applies to its own kind only');
});

test('a security slot runs the security prompt and submits security: fingerprints; an unknown kind is released unanswered', async () => {
  const f = canvas(200, { taskId: 'rt_f_0', state: 'submitted', phase: 'vote' });
  const client = new ReviewJobClient('http://canvas', 'office-review', f.transport);
  const runs: ReviewRun[] = [];
  const agent = async (run: ReviewRun) => { runs.push(run); return JSON.stringify({ findings: [{ path: 'src/auth.ts', line: 4, severity: 'important', bugClass: 'token-in-log', title: 'Token logged on login', rationale: 'Anyone reading logs gets the session token.' }], fixed: [] }); };
  const deps = { client, agent, checkout: async () => checkout(), ttlSeconds: 600, log: quiet, heartbeatMs: 60_000 };
  assert.equal(await runSlot(scope, finderTask({ kind: 'security', risk: { securityReasons: ['security_path:**/auth/**'] } }), deps), 'submitted');
  assert.equal(runs[0].system, SECURITY_FINDER_SYSTEM);
  assert.match(runs[0].prompt, /security review round 1/);
  assert.match(runs[0].prompt, /security_path:\*\*\/auth\/\*\*/);
  const submitted = f.calls.find((c) => c.path.endsWith('/submit'))!.body!.submission as { findings: { fingerprint: string }[] };
  assert.match(submitted.findings[0].fingerprint, /^security:token-in-log:[a-f0-9]{24}$/);

  const g = canvas(200, {});
  runs.length = 0;
  const out = await runSlot(scope, finderTask({ kind: 'performance' }), { ...deps, client: new ReviewJobClient('http://canvas', 'office-review', g.transport) });
  assert.equal(out, 'released');
  assert.equal(runs.length, 0, 'no model run for an unknown kind');
  assert.deepEqual(g.calls.map((c) => c.path.split('/').pop()), ['release']);
});

test('a completed security job is posted as a security review, each finding tagged security', () => {
  const findings: KnownFinding[] = [{ findingId: 'rf_1', fingerprint: 'security:ssrf:1', status: 'open', severity: 'important', reviewJobId: 'rj_1', path: 'a.ts', line: 2, title: 'SSRF' }];
  const body = reviewBody(job({ kind: 'security', phase: 'completed' }), findings);
  assert.match(body, /🔒 Opora automated security review/);
  assert.match(body, /\*\*\[security · important\]\*\* `rf_1`/);
  assert.doesNotMatch(reviewBody(job({ phase: 'completed' }), findings), /security/);
});

// ── b. self-check evidence ──────────────────────────────────────────────────────────────────────

const fakeExec = (codes: Record<string, number | null>): { exec: ExecCheck; ran: string[] } => {
  const ran: string[] = [];
  return { ran, exec: async (command) => { ran.push(command); const code = command in codes ? codes[command] : 0; return { exitCode: code, output: `line\n${'x'.repeat(5000)}\nlast ${command}` }; } };
};

test('self-check commands come from JSON or name=command lines, with Canvas names only', () => {
  assert.deepEqual(selfCheckCommands({}), []);
  assert.deepEqual(selfCheckCommands({ AGENT_OFFICE_OPORA_SELF_CHECKS: '{"tests":"npm test","build":"npm run build","Bad Name":"x"}' }),
    [{ name: 'tests', command: 'npm test' }, { name: 'build', command: 'npm run build' }]);
  assert.deepEqual(selfCheckCommands({ AGENT_OFFICE_OPORA_SELF_CHECKS: 'tests=npm test -- --a=b\nlint = npm run lint\n=nothing' }),
    [{ name: 'tests', command: 'npm test -- --a=b' }, { name: 'lint', command: 'npm run lint' }]);
});

test('self-checks follow the contract: passed iff exit 0, output cut to 4000, unrunnable is failed 127', async () => {
  const { exec } = fakeExec({ 'npm run build': 2, missing: null });
  const evidence = await runSelfChecks([{ name: 'tests', command: 'npm test' }, { name: 'build', command: 'npm run build' }, { name: 'x', command: 'missing' }], tmpdir(), HEAD, exec);
  assert.deepEqual(evidence.checks.map((c) => [c.name, c.status, c.exitCode]), [['tests', 'passed', 0], ['build', 'failed', 2], ['x', 'failed', 127]]);
  assert.ok(evidence.checks.every((c) => (c.output ?? '').length <= 4000 && c.summary === `last ${c.command}`));
  assert.ok(validSelfChecks(evidence));
  assert.equal(validSelfChecks({ ...evidence, extra: 1 }), false);
  assert.equal(validSelfChecks({ headSha: HEAD, checks: [{ name: 'tests', command: 'x', exitCode: 1, status: 'passed' }] }), false);
  assert.equal(validSelfChecks({ headSha: HEAD, checks: [{ name: 'tests', command: 'x', exitCode: null, status: 'skipped' }] }), true);
  await assert.rejects(runSelfChecks([{ name: 't', command: 'x' }], tmpdir(), 'nope', exec));
});

test('the reporter posts {project, workspace, executionId, selfChecks} once per head; 404 is not-deployed', async t => {
  const dir = tmp(t);
  const f = canvas();
  const { exec, ran } = fakeExec({});
  const reporter = new SelfCheckReporter('http://canvas', 'office-1', [{ name: 'tests', command: 'npm test' }], path.join(dir, 'ledger.json'), exec, f.transport);
  const subject = { ...scope, executionId: 'ex-1', headSha: HEAD, dir };
  assert.equal(await reporter.report(subject), 'recorded');
  assert.equal(f.calls[0].path, '/api/oporahub/review-jobs/self-checks');
  assert.equal(f.calls[0].actor, 'agent; name=office-1');
  assert.deepEqual(Object.keys(f.calls[0].body!), ['project', 'workspace', 'executionId', 'selfChecks']);
  assert.equal((f.calls[0].body!.selfChecks as { headSha: string }).headSha, HEAD);
  assert.equal(await reporter.report(subject), 'skipped', 'the same head is not run again, even by a new reporter');
  assert.equal(await new SelfCheckReporter('http://canvas', 'office-1', [{ name: 'tests', command: 'npm test' }], path.join(dir, 'ledger.json'), exec, f.transport).report(subject), 'skipped');
  assert.equal(ran.length, 1);
  const old = canvas(404);
  assert.equal(await new SelfCheckReporter('http://canvas', 'o', [{ name: 'tests', command: 'npm test' }], path.join(dir, 'l2.json'), exec, old.transport).report(subject), 'not-deployed');
});

test('PR upkeep reports evidence for the head it pushed, in the execution its PR names', async t => {
  const dir = tmp(t), NEW = '1'.repeat(40), OLD = '2'.repeat(40);
  mkdirSync(path.join(dir, 'opora-executions'), { recursive: true });
  writeFileSync(path.join(dir, 'opora-executions', 'exec-1.json'), JSON.stringify({ project: 'shop', workspace: 'feature', token: 'PRIVATE' }));
  assert.deepEqual(executionScope(dir, 'exec-1'), { project: 'shop', workspace: 'feature' });
  const reported: unknown[] = [];
  const reporter = { report: async (s: unknown) => { reported.push(s); return 'recorded'; } } as unknown as SelfCheckReporter;
  const pushed = upkeepSelfChecks(reporter, dir, () => ({ project: 'shop', workspace: 'main' }));
  const pr: OporaPr = { number: 7, url: 'u', body: 'x\n\nOpora-Execution: exec-1', headRefName: 'opora/card/exec-1', baseRefName: 'main', headRefOid: OLD };
  const tools: UpkeepTools = {
    git: async (args) => {
      if (args[0] === 'worktree' && args[1] === 'add') mkdirSync(args[4]!, { recursive: true });
      if (args[0] === 'rev-parse') return args[1]!.endsWith('/base') ? BASE : args[1] === 'HEAD' ? NEW : OLD;
      if (args[0] === 'merge-base') throw new Error('not ancestor');
      return '';
    },
    gh: async (args) => (args[1] === 'list' ? JSON.stringify([pr]) : ''),
    check: async () => ({ ok: true, output: 'ok' }),
    resolve: async () => '',
    pushed,
  };
  const config = upkeepConfig({ AGENT_OFFICE_OPORA_UPKEEP: 'on', AGENT_OFFICE_OPORA_CHECK_COMMAND: 'npm test' });
  assert.deepEqual(await new PrUpkeep(config, tools, new UpkeepLedger(), quiet).pass('Pletor/shop', dir, path.join(dir, 'trees')), [{ number: 7, state: 'rebased' }]);
  assert.equal(reported.length, 1);
  assert.deepEqual({ ...(reported[0] as object), dir: 'x' }, { project: 'shop', workspace: 'feature', executionId: 'exec-1', headSha: NEW, dir: 'x' });
  assert.equal(await pushed({ body: 'no trailer' }, NEW, dir), 'skipped');
});

const lease = (): ExecutionLease => ({ project: 'project', workspace: 'work', nodeId: 'card-0123456789abcdef', executionId: 'execution-1',
  token: 'PRIVATE-token', epoch: 7, acceptedRevision: 'a'.repeat(40), assignmentDigest: 'b'.repeat(64), assignment: { contextVersion: 'context' },
  state: 'running', serverNow: 100, expiresAt: 1000 });

function handoffFakes(opts: { head?: string; amFails?: boolean } = {}) {
  const git: string[][] = [], gh: string[][] = [], posts: { url: string; body: Record<string, unknown> }[] = [];
  const tools: HandoffTools = {
    env: {},
    git: async (args) => {
      git.push(args);
      if (args[0] === 'worktree' && args[1] === 'add') mkdirSync(args[4]!, { recursive: true });
      if (args.includes('am') && !args.includes('--abort') && opts.amFails) throw new Error('patch does not apply');
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return opts.head ?? HEAD;
      if (args[0] === 'rev-list') return '1';
      if (args[0] === 'remote') return 'git@github.com:Pletor/shop.git';
      return '';
    },
    gh: async (args) => {
      gh.push(args);
      if (args[0] === 'pr' && args[1] === 'list') return '[]';
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/Pletor/shop/pull/42\n';
      return '';
    },
    transport: (async (url: URL, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  };
  return { tools, git, gh, posts };
}

test('a card worker handoff runs the self-checks on the PR head in its worktree, after the PR is out', async t => {
  const dir = tmp(t, 'office-handoff-');
  mkdirSync(path.join(dir, 'tree'), { recursive: true });
  executionPrompt(dir, 'http://localhost:5010', 'office', lease());
  const f = handoffFakes();
  const reported: { headSha: string; dir: string; executionId: string }[] = [];
  const reporter = { report: async (s: { headSha: string; dir: string; executionId: string }) => { reported.push(s); return 'recorded'; } } as unknown as SelfCheckReporter;
  writeFileSync(path.join(dir, 'opora-executions', 'execution-1-reported.json'), JSON.stringify({ receiptId: 'r', result: { summary: 'Ready' } }));
  const dispatch = new ExecutionDispatch('http://localhost:5010', 'office', dir, () => [], () => {}, () => {}, f.tools, reporter);
  const info = { id: 'w1', worktree: { path: 'tree', branch: 'office/w1', base: PINNED, from: 'main' } } as WorkerInfo;
  assert.equal((await dispatch.handOff({ workerId: 'w1', execution: lease() }, info, dir, quiet))?.state, 'opened');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(reported.map((r) => [r.executionId, r.headSha, r.dir]), [['execution-1', HEAD, path.join(dir, 'tree')]]);
});

test('the result helper passes valid selfChecks to Canvas and leaves malformed ones out', async t => {
  const dir = tmp(t, 'office-handoff-');
  executionPrompt(dir, 'http://localhost:5010', 'office', lease());
  const sent: Record<string, unknown>[] = [];
  const transport = (async (_u: URL, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body)).result); return new Response(JSON.stringify({ receiptId: 'r', executionId: 'execution-1', state: 'reported' })); }) as typeof fetch;
  const good = { headSha: HEAD, checks: [{ name: 'tests', command: 'npm test', exitCode: 0, status: 'passed' }] };
  for (const selfChecks of [good, { headSha: 'HEAD', checks: [] }]) {
    const file = path.join(dir, 'result.json');
    writeFileSync(file, JSON.stringify({ summary: 'Ready', selfChecks }));
    await reportExecution(path.join(dir, 'opora-executions', 'execution-1.json'), file, transport);
  }
  assert.deepEqual(sent[0].selfChecks, good);
  assert.equal('selfChecks' in sent[1], false);
});

// ── c. reviewer eval runner ─────────────────────────────────────────────────────────────────────

const evalCase = (over: Partial<EvalCase> = {}): EvalCase => ({ schemaVersion: 1, caseId: 'rev_1', kind: 'revert', repository: 'Pletor/shop', number: 7,
  baseSha: BASE, headSha: HEAD, revertSha: REVERT, revertNumber: 9, findings: [{ path: 'src/cart.ts', line: 11, severity: 'important', status: 'fixed' }], ...over });
const REVERT_DIFF = ['diff --git a/src/cart.ts b/src/cart.ts', '--- a/src/cart.ts', '+++ b/src/cart.ts', '@@ -10,3 +10,0 @@', '-a', '-b', '-c',
  'diff --git a/src/new.ts b/src/new.ts', '--- a/src/new.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-x'].join('\n');

/** Fake git for checkouts and revert diffs: origin is Pletor/shop, every commit is there. */
function evalGit(calls: string[][] = []) {
  return async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'remote') return 'https://github.com/Pletor/shop.git';
    if (args[0] === 'merge-base') return BASE;
    if (args[0] === 'worktree' && args[1] === 'add') { mkdirSync(args[4]!, { recursive: true }); return ''; }
    if (args[0] === 'diff' && args.includes('--unified=0')) return REVERT_DIFF;
    if (args[0] === 'diff' && args.includes('--name-only')) return 'src/cart.ts\n';
    if (args[0] === 'diff') return 'diff --git a/src/cart.ts b/src/cart.ts\n+bug';
    return '';
  };
}
/** A fake model: finders report what `finds` says for their system prompt; voters confirm `confirm`'s titles. */
function evalAgent(finds: (system: string) => object[], confirm: (title: string) => boolean = () => true) {
  const runs: ReviewRun[] = [];
  const agent = async (run: ReviewRun) => {
    runs.push(run);
    if (run.prompt.includes('Candidates to verify')) {
      const list = JSON.parse(/Candidates to verify[^\n]*\n<<<DATA\n([\s\S]*?)\nDATA>>>/.exec(run.prompt)![1]) as { candidateId: string; title: string }[];
      return JSON.stringify({ votes: list.map((c) => ({ candidateId: c.candidateId, verdict: confirm(c.title) ? 'confirm' : 'reject' })) });
    }
    return JSON.stringify({ findings: finds(run.system), fixed: [] });
  };
  return { agent, runs };
}
const bug = { path: 'src/cart.ts', line: 11, severity: 'important', bugClass: 'off-by-one', title: 'Total skips the last item', rationale: 'Loop stops early.' };
const noise = { path: 'src/other.ts', line: 3, severity: 'nit', bugClass: 'naming', title: 'Unclear name', rationale: 'Hard to read.' };
const options = (over: Partial<EvalOptions> = {}): EvalOptions => ({ kind: 'code', finders: 2, voters: 2, requiredVotes: 2, maxCases: 10, maxRuns: 100, noiseWeight: 0.1, ...over });

test('the export parses into cases, dropping malformed lines; a revert diff gives files and reverted line ranges', () => {
  const { cases, dropped } = parseCases([JSON.stringify(evalCase()), 'not json', JSON.stringify({ ...evalCase(), caseId: 'x', headSha: 'short' }), '', JSON.stringify(evalCase())].join('\n'));
  assert.equal(cases.length, 1);
  assert.equal(dropped, 3, 'malformed, invalid sha and duplicate');
  assert.deepEqual(revertTargets(REVERT_DIFF), { files: ['src/cart.ts', 'src/new.ts'], ranges: { 'src/cart.ts': [[10, 12]], 'src/new.ts': [[1, 1]] } });
});

test('a case is replayed in fresh contexts without its recorded findings and scored on what the revert touched', async t => {
  const root = tmp(t);
  const git: string[][] = [];
  const { agent, runs } = evalAgent(() => [bug, noise], (title) => title !== 'Unclear name');
  const report = await runEval([evalCase()], options(), { git: evalGit(git), agent, repo: root, root }, { source: 'test' });
  const b = report.baseline!;
  assert.equal(b.totals.recall, 1);
  assert.equal(b.totals.lineRecall, 1);
  assert.equal(b.totals.noisy, 0, 'the voters rejected the noise');
  assert.equal(b.cases[0].rejected, 1);
  assert.equal(b.cases[0].priorKept, 1);
  assert.equal(runs.length, 4, '2 finders + 2 voters');
  assert.ok(runs.every((r) => r.system === FINDER_SYSTEM || r.system === VOTER_SYSTEM));
  assert.ok(runs.every((r) => !r.prompt.includes('"status": "fixed"')), 'recorded findings are never shown');
  assert.ok(git.some((a) => a.includes(`${REVERT}^`)), 'the revert diff is read');
  assert.equal(report.decision, undefined);
});

test('a variant is kept only when its score goes up; the budget skips cases it cannot finish', async t => {
  const root = tmp(t);
  // The variant finds the bug; the baseline finds only noise the voters confirm.
  const better = evalAgent((system) => (system === 'VARIANT' ? [bug] : [noise]));
  const up = await runEval([evalCase()], options(), { git: evalGit(), agent: better.agent, repo: root, root }, { source: 't', variant: { code: { finder: 'VARIANT' } } });
  assert.equal(up.baseline!.totals.recall, 0);
  assert.equal(up.variant!.totals.recall, 1);
  assert.equal(up.decision!.keep, true);
  const worse = evalAgent((system) => (system === 'VARIANT' ? [bug, noise] : [bug]));
  const down = await runEval([evalCase()], options(), { git: evalGit(), agent: worse.agent, repo: root, root }, { source: 't', variant: { code: { finder: 'VARIANT' } } });
  assert.equal(down.decision!.keep, false, 'same recall, more noise: dropped');
  assert.match(down.decision!.reason, /did not go up/);
  assert.equal(decide({ score: 0.5, totals: { recall: 1 } as never }, { score: 0.9, totals: { recall: 0.5 } as never }).keep, false, 'recall may never go down');

  const tight = await runEval([evalCase(), evalCase({ caseId: 'rev_2' })], options({ maxRuns: 5 }), { git: evalGit(), agent: better.agent, repo: root, root }, { source: 't' });
  assert.deepEqual(tight.baseline!.cases.map((c) => c.status), ['scored', 'skipped']);
  assert.equal(tight.budget.exhausted, true);
  assert.ok(tight.budget.used <= 5);
});

test('the CLI dry run writes a report without a model, and a variant file is read per kind', async t => {
  const dir = tmp(t);
  const cases = path.join(dir, 'cases.jsonl');
  writeFileSync(cases, JSON.stringify(evalCase({ revertSha: null, kind: 'incident', incident: { reference: 'INC-1', summary: 'src/cart.ts totals wrong' } })) + '\n');
  assert.equal(await dryRunAgent({ cwd: dir, system: '', prompt: 'x', signal: new AbortController().signal }), '{"findings":[],"fixed":[]}');
  const variant = path.join(dir, 'variant.json');
  writeFileSync(variant, JSON.stringify({ finder: 'F' }));
  assert.deepEqual(readVariant(variant), { code: { finder: 'F' }, security: { finder: 'F' } });
  const out = path.join(dir, 'report.json');
  const logs: string[] = [];
  // Not a git checkout: the case errors out cleanly and the report still lands.
  const code = await evalMain(['--cases', cases, '--dry-run', '--repo', dir, '--out', out], { log: (s) => logs.push(s), error: (s) => logs.push(s) });
  assert.equal(code, 0);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(report.caseCount, 1);
  assert.equal(report.baseline.cases.length, 1);
  assert.match(logs.join('\n'), /report:/);
});

// ── d. isolated broker auto-PR ──────────────────────────────────────────────────────────────────

const PATCH = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n';
function isolatedRun(result: Record<string, unknown>): IsolatedRun {
  const intent = { intentId: 'i'.repeat(64), repository: { url: 'https://github.com/Pletor/shop', commitSha: PINNED } } as unknown as ExecutionIntent;
  return { key: 'k'.repeat(64), input: { executorId: 'anthropic-managed-agents', cardId: 'card-0123456789abcdef', requestId: 'r' }, ...scope, base: 'http://canvas',
    stage: 'running', claim: null, lease: lease(), intent, observationHead: null, observationSequence: 0, pendingObservation: null, lastObservationSemantic: null,
    terminalPolls: 0, nextPollAt: 0, pendingResult: { report: { eventId: 'e', processedAt: '2026-10-20T10:00:00Z', result: { summary: 'Changed a', ...result }, requestId: 'q', digest: 'd' }, payload: {}, attempted: true },
    resultReceipt: { receiptId: 'receipt-1' } } as IsolatedRun;
}

test('an isolated run with a patch gets it applied at the pinned commit and the same PR handoff; a retry reuses it', async t => {
  const repo = tmp(t), dir = tmp(t);
  const f = handoffFakes();
  const prs = new IsolatedPullRequests(repo, dir, 'http://canvas', 'office-isolated', f.tools);
  const out = await prs.handOff(isolatedRun({ patch: PATCH }), quiet);
  assert.equal(out.state, 'opened');
  const add = f.git.find((a) => a[0] === 'worktree' && a[1] === 'add')!;
  assert.equal(add.at(-1), PINNED, 'the throwaway worktree is at the pinned commit');
  const am = f.git.find((a) => a.includes('am'))!;
  assert.ok(am.includes('--committer-date-is-author-date') && am.includes('user.name=Agent Office'), 'fixed identity and dates: the same patch is the same head');
  assert.deepEqual(f.git.find((a) => a[0] === 'push'), ['push', 'origin', 'HEAD:refs/heads/opora/card-0123456/execution-1']);
  const create = f.gh.find((a) => a[1] === 'create')!;
  assert.match(create[create.indexOf('--body') + 1], /Opora-Execution: execution-1/);
  assert.doesNotMatch(create[create.indexOf('--body') + 1], /diff --git/, 'the patch stays out of the PR body');
  assert.match(f.posts[0].url, /executions\/execution-1\/pull-request$/);
  assert.ok(!existsSync(path.join(dir, 'trees', 'execution-1')), 'the throwaway worktree is gone');
  const calls = f.git.length;
  assert.equal((await prs.handOff(isolatedRun({ patch: PATCH }), quiet)).state, 'opened');
  assert.equal(f.git.length, calls, 'the same patch is not applied or pushed twice');
});

test('no patch, a patch that does not apply, or AUTO_PR off opens nothing', async t => {
  const repo = tmp(t);
  const none = handoffFakes();
  assert.equal((await new IsolatedPullRequests(repo, tmp(t), 'http://canvas', 'o', none.tools).handOff(isolatedRun({}), quiet)).state, 'skipped');
  assert.equal(none.git.length, 0);
  const bad = handoffFakes({ amFails: true });
  const said: string[] = [];
  const out = await new IsolatedPullRequests(repo, tmp(t), 'http://canvas', 'o', bad.tools).handOff(isolatedRun({ patch: PATCH }), (m) => said.push(m));
  assert.equal(out.state, 'skipped');
  assert.ok(bad.git.some((a) => a[0] === 'am' && a[1] === '--abort'));
  assert.equal(bad.gh.length, 0);
  assert.match(said.join(), /doesn't apply to the pinned commit/);
  const off = handoffFakes();
  off.tools.env = { AGENT_OFFICE_OPORA_AUTO_PR: 'off' };
  assert.equal((await new IsolatedPullRequests(repo, tmp(t), 'http://canvas', 'o', off.tools).handOff(isolatedRun({ patch: PATCH }), quiet)).state, 'skipped');
  assert.equal(off.git.length, 0);
});

test('a plain diff becomes a one-commit mailbox; the remote agent is told to return a format-patch', () => {
  const mbox = asMailbox(PATCH, 'Opora card c: Changed a', '2026-10-20T10:00:00Z');
  assert.match(mbox, /^From 0{40} /);
  assert.match(mbox, /\nDate: Tue, 20 Oct 2026 10:00:00 \+0000\n/);
  assert.match(mbox, /\nSubject: \[PATCH\] Opora card c: Changed a\n/);
  assert.equal(asMailbox('From abc\nx', 's', 'd'), 'From abc\nx\n');
  assert.match(patchInstructions({ repository: { url: 'u', commitSha: PINNED } }), new RegExp(`git format-patch --stdout ${PINNED}\\.\\.HEAD`));
});

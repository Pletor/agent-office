# Canvas execution authority

An explicitly selected remote path is available through the
[isolated-execution API](opora-isolated-execution.md). It has its own registry,
private recovery journal and independent provider observations. Missing
configuration returns unavailable; the local worker path below is not its
fallback. Real provider staging evidence is still required for operational claims.

Office executes assignments accepted in Canvas OporaHub. Taking a card first reads
its accepted revision and context version, then claims an execution with a stable
request ID. Canvas must support `/api/oporahub/executions`; an older server, missing
accepted baseline, changed relevant context, or a reserved card prevents dispatch.
There is no fallback to the older card lease or live-brief protocol.

The execution retains its project, workspace, card, epoch, accepted revision and
assignment digest even when the floor changes workspace. Each worker reads a local
immutable assignment snapshot. Harness context and optional REA guidance remain,
but mutable drawing/storyboard and legacy agent-output prompts are not substituted
for the accepted assignment. External image/link bytes are not independently
verified by this snapshot.

Office renews authority and uses a separate monotonic deadline timer. Temporary
network failures can retry only before that deadline. Revocation, expiry or changed
context stops the worker with its worktree kept. The deadline is derived from the
server's numeric timestamps and request duration, so machine clock skew cannot
extend authority. An uncertain claim retries the same request; replay is revalidated
before any worker starts.

Claim and heartbeat are lean: both send `?assignment=omit`, so Canvas returns only the
authority (execution id, token, epoch, expiry, accepted revision, `assignmentDigest`,
budget, context proof) and the assignment's `contextVersion`. Right after the claim the
office reads the assignment once from `GET /api/oporahub/executions/{id}/assignment`,
with the token in the `X-Opora-Execution-Token` header (never in the URL), and takes it
only when its execution id, scope, epoch, accepted revision, `assignmentDigest`,
`contextVersion`, protocol versions and budget are exactly the claim's; otherwise the
fresh claim is released and nothing is dispatched. Each heartbeat compares the same
fields (the digest stands for the assignment) and keeps the assignment it read. A
Canvas that ignores `omit` and still sends the whole lease is checked as before. Code:
`src/server/opora/execution-client.ts`.

## Handoff and resume

Canvas puts what the work before the card left behind into the assignment as
`handoff` (Canvas's `docs/oporahub-executions.md`, "Předávka v zadání"): each
predecessor's result summary, step results, checks, decisions, pull request and PR
Lens, plus the flows into the card's area, capped at 8 kB with pointers to the rest.
The prompt carries a compact reading of it, one line per field, labelled as data
written by earlier agents and never as instructions; what doesn't fit (or Canvas left
out) is counted with a pointer to the assignment file, which keeps all of it.

The assignment read also brings live `progress`: which pinned steps this or an earlier
run of the card already reported done, and `current`, the first unfinished one. When
some are done, the prompt tells the agent to resume at `current` without redoing the
rest. Code: `src/server/opora/execution-handoff.ts`.

The deadline watchdog runs inside Office. For unbudgeted v1 executions, a hosted
terminal retained by shutdown may continue computation while Office is down.
Budgeted v2 executions request a stop on shutdown instead of retaining their
terminal, while keeping their worktrees. Canvas rejects expired/revoked result
writes in either case. A stop request or a returned stop adapter is not proof
that every descendant process exited. This is not an OS process sandbox.

On restart, old Opora terminal processes are stopped before authority is checked.
Saved executions must revalidate their original epoch before automatic resume.
Legacy saved workers without an execution, or workers whose authority has expired,
stay stopped with an explanation. Keep/review their worktree, accept the current
plan in Canvas if needed, and explicitly take the card again. Office never claims
a replacement epoch merely to resume an old worker.

The server stores capability data in `opora.json` and `opora-executions/` under the
floor data directory. These are private local files; protect that directory with
the service account's permissions (POSIX modes are not Windows ACLs). Browser
state and worker prompts exclude tokens. A separate assignment JSON contains only
task data. The prompt names a result helper that reads the capability internally;
workers must not read or publish the private bundle.

To finish, the worker commits its work in its worktree and writes a JSON result with a nonempty `summary` and optional
artifact/evidence fields (at most 64,000 UTF-8 bytes), then runs the command in its
prompt. Retry the identical file after uncertain delivery. The helper emits only
the receipt identity and verification label. A receipt is agent-reported work,
not verified checks, independent review, accepted plan changes or card completion.
It must not trigger the legacy agent-output or completion API. Cards written for
that flow still ask for it in their text ("Do karty zapsán agent-output …
done.proposed"), so the prompt says, right after naming the assignment, that any
requirement in the card text to write agent-output, propose or confirm done, or
change card state is legacy and is fulfilled by the result helper, and a plan step's
acceptance item that mentions `agent-output`, `done.proposed` or `done.confirmed`
is marked as such in the checklist. A successful result
ends Canvas authority; the next Office heartbeat stops that worker. Its authority
warning does not invalidate an already stored successful receipt.

The result may carry `decisions`: at most 20 non-empty texts or objects
`{text, why?, alternatives?, evidence?}` that Canvas stores as the card's decisions
and hands to the next cards; the helper refuses a malformed list before sending. When
the worker drew its change with [PR Lens](opora-review-evidence.md), the helper adds
`result.lens`, a reference to the validated spec (`kind: pr-lens`, its `sha256`,
`bytes`, `validatedAt` and title). Canvas fixes no schema for it, so it is a pointer:
the spec itself still goes to Canvas with the pull request, as before, and the hash ties
the two together. An agent's own `lens` field is left as it is.

## Plan steps

Canvas pins a card's accepted plan steps (`spec.steps`, Canvas's
`docs/oporahub-plan-steps.md`) in the execution's immutable `assignment.steps`. When
there are any, the prompt carries them as an ordered checklist (id, title, kind,
`dependsOn`, every acceptance condition, `files` globs) and a fixed protocol:

- work strictly step by step in that (topological) order;
- one commit per step, with the message `step <id>: <title>`;
- verify each step's acceptance (run the relevant tests) before the next one, keeping
  each check's command and outcome for that step's `evidence.checks`;
- a step whose acceptance can't be met is reported `failed` (and the rest `skipped`),
  instead of improvising around it;
- files outside the step's globs are edited only with a note saying which and why.

The result then carries `stepResults: [{stepId, status: done|failed|skipped,
evidence: {notes, checks?, commits?}}]`. The helper doesn't take the agent's word for
the commits: it reads this branch's own commits (`git log HEAD --not --remotes` in the
worker's worktree), maps each `step <id>:` message to its step, and puts exactly those
SHAs in each step's `evidence.commits` (none found: none sent). It then validates
`stepResults` as Canvas does (known, unique step ids; status; `notes` up to 4000
characters; at most 50 checks of 1-500 characters and 50 SHAs) and, if Canvas would
refuse them, says why and sends nothing, so the agent can fix the same file and run the
helper again. `selfChecks` work as before, next to `stepResults`.

Each step is also reported as soon as its commit is made, with the same helper and
bundle: `<helper> <bundle> step <id> [done|failed|skipped] [--notes <text>] [--check <text>]...`
(the prompt carries the exact command). It posts one checkpoint to
`POST /api/oporahub/executions/{id}/steps`; the commits again come from git, the notes
default to naming the step's commits, and the request id is derived from the content,
so retrying the same command replays the checkpoint and a corrected one is a new one.
A shape Canvas would refuse is refused locally with what to fix. If this run stops
early, the next run of the card starts at the first unfinished step (see
[handoff and resume](#handoff-and-resume)). Code: `src/server/opora/execution-step.ts`.

Readiness follows Canvas, not the old desktop-v3 pipeline: on each read the office also asks
`GET /api/oporahub/agent-state` which cards have a `claim` action `ready` (accepted steps, budget,
no unfinished predecessor over a `next` edge), and the 🤖 autopilot takes those as well as routed
cards. A Canvas without agent-state leaves the autopilot on routed cards only.

A card without steps (an older Canvas, or a legacy accepted spec) gets the old prompt,
and any `stepResults` in its result are left out. Code: `src/server/opora/plan-steps.ts`,
used by `execution-prompt.ts`, `execution-worker.ts`, `pull-request-body.ts` and, for the
[isolated broker](opora-isolated-execution.md), `isolated-service.ts` and `isolated-reports.ts`.

## Pull request handoff

No agent has to open the execution's pull request. Once the result helper has a
receipt, it stores the reported result (never the capability) as
`opora-executions/<executionId>-reported.json`. Office then hands the work off
from the worker's worktree, when the worker updates, when authority ends after the
result, on each 20-second poll and before the lease is released:

1. With commits ahead of the worktree's base, it pushes `HEAD` to the deterministic
   branch `opora/<first 12 characters of the card id>/<executionId>` on `origin`.
2. It reuses the pull request already open (or closed) for that branch, or opens one
   with `gh pr create`, titled `Opora: <card title>`, against the branch the worktree
   was cut from. The body has the result's summary, for a card with [plan steps](#plan-steps)
   a `## Kroky plánu` section (each step with its reported status, its checks and the PR's
   own commits for it, read from the `step <id>:` messages in `<base>..HEAD`), and the sections Canvas's PR template
   rule asks for by name: `## Testing` (the tests and checks from its
   `evidence`/`checks`/`tests`), `## Risk` and `## Revert plan` (its `risk` and `revert`,
   or defaults), and ends with
   the trailers `Opora-Execution: <executionId>`, `Opora-Revision: <acceptedRevision>`
   and `Opora-Card: <cardId>`.
3. It links the pull request with POST `/api/oporahub/executions/{executionId}/pull-request`
   `{project, workspace, token, epoch, requestId, repository, number, headRef, headSha}`,
   using the execution's credentials; `requestId` is a UUID-shaped SHA-256 of the
   execution and head commit, so a retry is the same request. 404 (Canvas without
   the endpoint) is logged and the trailers let Canvas discover the PR later; 409 is
   logged as a conflict and not retried.

Once a run of the floor has reported a result for a card, the 🤖 autopilot and the
orchestrator's hand-out leave that card alone: Canvas shows it free again while its pull
request waits for review and merge, and taking it again would do the same work twice. A
person can still take it with **▶ Take** (after accepting a changed plan, say).

What became of each head commit is kept in `<executionId>-pull-request.json`, so the
same commit is never pushed or linked twice; a later commit updates the same PR and
links again. Office never merges or approves. A failed push, PR or link is a toast
and a server log line and never changes the stored Canvas result. Without a GitHub
`origin`, without `gh auth`, or with `AGENT_OFFICE_OPORA_AUTO_PR=off`, it skips with
a toast. Implementation: `src/server/opora/pull-request-handoff.ts` and
`pull-request-body.ts`; tests: `tests/opora-pull-request.test.ts`.

Once linked, Canvas can queue automated review jobs for the pull request; the office's
[review workers](opora-review-workers.md) run them when `AGENT_OFFICE_OPORA_REVIEWS=on`.

Once open, those pull requests can be kept rebased on their base, and a red base
branch bisected to the merge that broke it and reverted by pull request, with
`AGENT_OFFICE_OPORA_UPKEEP=on` and `AGENT_OFFICE_OPORA_GUARD=on`: see
[PR upkeep and the post-merge guard](opora-pr-upkeep.md).

Implementation lives in `src/server/opora/execution-*.ts`. The generic
`workers/launch-guards.ts` registry gates initial launches, restored terminals and
resume; floor composition registers the Opora guard before `workers.start()`.
Focused tests are `tests/opora-execution.test.ts` and `tests/opora.test.ts`.

## Budget protocol v2

Canvas advertises the protocol in execution context. Unenrolled cards retain v1;
once a human configures budgets, the card requires v2 with the current budget
policy head and previous execution ID. Office never falls back to v1 after v2
failure, and uncertain delivery reuses the original request and allocation.
Another owner, release, failed spawn or restart does not refund attempts.

Each v2 execution pins its policy, allocation, attempt, repair round and fixed
server deadline. Office validates these immutable fields on renewal and restore.
The monotonic watchdog is capped at the original locally observed run deadline,
including request latency. Renewing a lease cannot buy more runtime. Saved
workers revalidate their original authority and cannot claim replacement budget.
Graceful shutdown conservatively marks budgeted runs ended after requesting stop;
it does not automatically resume them or claim another attempt on restart. An
unreleased Canvas lease can remain until release or expiry. Crash recovery of a
saved working run still requires the original allocation and deadline.

Configure or raise limits in Canvas OporaHub as a human. After accepting a new
plan revision, configure its new budget family before dispatching an enrolled
card again. Cancellation in Canvas revokes write authority immediately; Office
observes it through bounded renewal and requests worker stop. During a network
partition the last known deadline is the local stop trigger.

An observed server clock regression freezes budget authority for the whole
Canvas project. Read history and cancel affected runs in Canvas; investigate the
server clock. This release has no clock-reset API. Do not delete budget tables
or claim a different owner to recover authority.

These are authority and launch-count limits. Current CLI usage reports do not
enforce a provider dollar/token cap, and the process adapter does not prove
containment of all descendants. Do not treat a successful stop call as a hard
process-tree guarantee. Reported results still need independent review.

Development verification: `npm run typecheck`, `npm test`, `npm run build` and
`tests/size.test.ts`. On Windows the untouched baseline has unrelated shell-fixture,
symlink-permission and process-lifecycle failures; use a bounded Node test run to
compare those separately from these protocol tests.

## Context protocol v2

Set `AGENT_OFFICE_OPORA_CONTEXT_VERSION=2` before starting Office to explicitly
select sparse context validation. Leave the variable unset for existing v1 behavior.
Other values are rejected. Canvas must provide the context-v2 API; Office sends
POST `/api/oporahub/executions/context` with `contextProtocolVersion: 2`, then claims
that exact version. It never retries an unsupported or refused v2 request as v1.
Context version and budget execution version are negotiated independently, so a
sparse execution can use either unbudgeted v1 or budgeted v2 authority.

Canvas pins the original accepted revision and dependency context. A heartbeat can
advance the checked accepted head when all intermediate accepted and live changes
preserve that context. Office validates the public proof, its original revision
and bounded counts; it retains the original assignment, epoch, token and budget.
Missing proofs, context downgrades or changed origins prevent launch or renewal.
Private raw context pins and project secrets remain in Canvas and are not part of
the Office lease, worker prompt or result receipt.

Sparse dispatch skips both dynamic task preparation and prompt decoration, including
the live harness context and REA brief normally appended by those callbacks. It uses
only the immutable assignment and static protocol `opora-office-execution/2`.
The private bundle records that instruction version. Restart validates the original
bundle and assignment files before revalidating the original execution, even when
the execution has no authority budget. Missing or inconsistent files leave the
worker stopped; Office does not recapture task data or claim a replacement run.
Sparse shutdown requests a stop and keeps the worktree, with the same process-tree
limitations described above. Changing the environment setting does not downgrade
a saved sparse run.

These proofs cover Canvas's declared accepted/live dependency sources. They do not
independently verify external file or link bytes, provider usage, process isolation
or reported worker results. Focused coverage includes `tests/opora-context.test.ts`.

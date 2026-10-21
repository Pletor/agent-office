# Canvas execution authority

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

To finish, the worker writes a JSON result with a nonempty `summary` and optional
artifact/evidence fields (at most 64,000 UTF-8 bytes), then runs the command in its
prompt. Retry the identical file after uncertain delivery. The helper emits only
the receipt identity and verification label. A receipt is agent-reported work,
not verified checks, independent review, accepted plan changes or card completion.
It must not trigger the legacy agent-output or completion API. A successful result
ends Canvas authority; the next Office heartbeat stops that worker. Its authority
warning does not invalidate an already stored successful receipt.

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

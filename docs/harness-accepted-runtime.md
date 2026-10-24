# Accepted Harness kit at runtime

An Office worker reads the exact kit pinned in its currently watched Canvas execution:

```sh
node /path/to/agent-office/bin/office-harness.js --accepted-kit
```

Use the worker's existing `AGENT_OFFICE_HOOK_URL`, `AGENT_OFFICE_WORKER_ID` and
`AGENT_OFFICE_HOOK_TOKEN`. The command only works through the authenticated hook
server. There is no local-file fallback or `--task` override. The corresponding
read-only endpoint is `GET /office/harness?worker=ID&accepted-kit=1`.

The server uses its execution controller's watched assignment, never a caller's
assignment file, a browser view, a neighboring card, or today's mutable catalog.
It requires a still-valid context-protocol-2 execution. Expired, forgotten,
stopped, foreign-worker and legacy executions return 409. Wrong credentials
return 401 before execution lookup. Responses are `Cache-Control: no-store`.

The response contains `execution` (execution ID, epoch, accepted revision,
assignment digest and project/workspace/node scope), `kit`, and explicit evidence
limits. A missing target kit is `null`; an explicitly accepted empty kit retains
its empty resources array. The server validates the Canvas `harness.kit/1` wire
contract, including exact UTF-8 SHA-256, unique identities/slots, categories,
requirements and the 96 KiB complete representation limit. Ambiguous or damaged
kits fail closed. The private capability token, budget, and unrelated documents
are not returned. Reading the detached snapshot cannot mutate the watched lease.

This is a selection receipt, not execution authorization or proof of invocation.
`requires` remain declared requirements; `capabilitiesVerified`,
`invocationObserved` and `promotionAllowed` are false. The receipt is current at
the instant of reading and does not extend the execution deadline. Follow-up
preparation or invocation must recheck the live execution rather than treating a
saved receipt as authority. The accepted assignment and static execution prompt
remain unchanged.

Compatibility: without a Harness kit in the accepted Canvas specification this
endpoint returns null; it does not inject a new kit into an old accepted task.
Canvas must support accepted kits and context protocol 2 before this path can
supply resources. Removing this module/route requires no data migration: it
writes no registry, assignment, event or memory record.

See [Harness](harness.md) and [code layout](code-layout.md).


## Historical recovery

With worker hook credentials, run `office-harness --recover RESOURCE --from EXECUTION`. `EXECUTION` identifies an earlier execution of the current card; `RESOURCE` must already be in the current accepted kit. No `--task`, private bundle path, destination or token can be supplied. This command requires Canvas's optional `/api/oporahub/harness-recovery` endpoint; an older or unreachable peer fails explicitly without local fallback.

Office uses the current controller watch and the existing private execution files under the floor's `.agent-office/opora-executions`. The standard bundle validator checks destination, actor, instruction version and exact assignment. Only the internal helper reads the capability. The configured controller chooses the native destination. Office bounds the response, validates scope and source identities, content/version hashes and unchanged requirements, and requires every other resource to remain byte-for-byte unchanged. It rechecks the current watch before returning; lost authority or echoed credentials are refused with a generic error.

The returned `harness.recovery-proposal/1` is a candidate kit, with current historical evidence and `requiresAcceptance: true`, `promotionAllowed: false`. Submit it through the existing Canvas specification proposal/review flow; a newly accepted assignment and claim are required to use it. The command neither restores working files nor replaces profiles or a running snapshot. It does not certify stability, invoke tools, accept its own proposal or promote a version.

Tests exercise the real authenticated Office HTTP route and CLI, correct private-bundle binding, poisoned peer responses, JSON-escaped capability reflection, oversized replies, authority loss, and unsupported peers. Full production promotion and rollback remain separate Harness acceptance work.


## Discovery in worker sessions

A context-v2 worker whose target accepted document contains a Harness kit receives
`harness.worker/1` static guidance with its normal execution prompt. It names
`office-harness --accepted-kit`, explains declared requirements and missing adapters,
and describes optional invocation receipts and acceptance-required recovery. An explicit
empty kit gets guidance too; it does not acquire resources automatically. A neighboring
card's kit, absent target kit, or legacy context does not add the guide. A malformed
accepted target kit prevents handoff rather than emitting misleading usage guidance.

The immutable execution brief registry calls the Harness-owned module synchronously
with the accepted lease. It reads no catalog, live profile, network service or private
capability file and interpolates no resource text into the static guide. Assignment
bytes and the existing execution protocol remain unchanged. Orchestrators must include
selected resources in the accepted target specification before seating the worker;
changing a profile after acceptance does not change a running v2 task.

## Tool recommendation lifecycle

These commands require the optional native stability endpoint and Office lifecycle store
protocol 1. Missing integrations return unavailable; there is no local fallback.

```sh
office-harness --tool-status testing:plan
office-harness --promote-tool testing:plan --revision 12
office-harness --reconcile-tool testing:plan --revision 13 --fallback-plan testing:previous
```

Read the revision from status. `PLAN` names a testing resource already in the current
accepted target kit; the server resolves its exact digest, candidate, baseline and
problem. A fallback plan must also be accepted in that kit and assess the retained
previous version in the same problem. No command accepts caller-provided eligibility,
outcomes, project, task, capabilities or native credentials.

Office fetches the native assessment with the current private grant under the profile
transaction and checks the lease, exact accepted pins, fixed policy and evidence
coverage. The existing hook identity and current execution are checked again at
publication. A stale revision returns a conflict; reload status before retrying.
Transport errors or changed authority publish nothing and must not be interpreted as
a usable older stable assessment. The native verifier must be configured by its operator;
these commands neither configure it nor run an experiment.

A positive assessment supplies a `source` reference selected from its validated
native comparison reports (`verificationId` and `reportDigest`). The optional
lifecycle store can retain it with the exact active version and its predecessor
for reassessment after this session ends. Negative or incomplete evidence cannot
mint a new source reference. The reference is not proof of current eligibility;
future selection must ask the native retained-evidence endpoint again.

The optional `retained-stability` adapter performs that bounded project-scoped read
using only the saved verification ID. It validates the exact stored version and
report digest, native policy and source membership; no worker lease or credential
is sent. Recommendation integration can use it after the evaluation session ends.
Redirects, malformed or oversized responses and mismatched scope/source fail closed.

The result concerns project recommendation state only. It does not change manual
checkboxes or the running accepted kit, prove causal task benefit, or grant production
permission. New work still requires an accepted specification. Automatic consumption
of reconciled state by the recommendation selector is pending; these commands alone
do not complete the autonomous selection/use/learning loop.

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
and requests optional `office-harness --prepare-accepted` before tool use. This separate
invocation module checks the worker process using a fixed harmless probe, never accepted
resource contents. Read each resource state: prepared context means readable material,
not an activated tool. Unsupported resources or an absent command remain unavailable;
use only authorized fallbacks. Readiness grants no permissions, independent verification
or promotion, and invocation still checks current execution authority. The guide also
describes optional invocation receipts and acceptance-required recovery. An explicit
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

### Accepted Context7 documentation

With the Context7 integration installed, an accepted `mcp` resource declaring
exactly `mcp:context7` and the `harness.context7/1` descriptor can be used through
`office-harness --docs-accepted RESOURCE "public question"`. The descriptor pins
the resolved library ID; the command never substitutes today's catalog content.
The static worker guide includes this command and its reporting rules.

This adapter runs through Office. The `--prepare-accepted` worker-process report
does not attest remote Context7 availability or activate a local MCP server.
The explicit documentation lookup checks the service and rechecks the current
accepted assignment; an unavailable integration or failed lookup remains a failure.
Omit `--task`, send only public questions, and treat returned text as reference data.

When the native documentation extension is installed, include only the returned
`observation` in final `result.harnessDocumentation`, preserving its `readId` on
retries. Do not use `harnessInvocations`, which describes Node invocations. A read
does not complete the task or establish independent verification, causal benefit,
production success or promotion. Unsupported old peers do not become compatible
merely because they accept unknown JSON fields.

### Preparing equipment for the next accepted assignment

With the optional recommendation CLI, compatible Office writer and native kit
validator installed, workers can request selection provenance:

```sh
office-harness --recommend PROBLEM --kit-schema harness.kit/2
```

Add `--capability ID` only for capabilities checked in the actual runner. For a
card-specific proposal, pass `--task` with the exact namespaced Opora task ID from
the effective profile. Omitting it asks for the current default scope, not an
implicit rewrite of the running assignment. Inspect constraints, warnings and
selection reasons; `kit: null` is blocked. An unavailable integration or incompatible
peer cannot be treated as a successful v2 preparation or silently downgraded.

The orchestrator submits the returned kit with the target specification through
normal acceptance, then dispatches a new assignment. Workers use `--accepted-kit`
and `--prepare-accepted` for that assignment. Neither a recommendation nor a profile
edit replaces tools already pinned in a running task. Selection provenance explains
the proposal; independent verification and production outcomes remain separate.
This procedure is included in the static worker guide without reading live profiles
or inserting mutable catalog content into the execution handoff.

### Updating recommendation state

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
permission. New work still requires an accepted specification. The optional
recommendation module consumes freshly reconciled state; these commands alone
do not complete the autonomous selection/use/learning loop.

## Shared fixture lessons for an accepted tool

When the native shared assessor and shared-memory module are installed:

```sh
office-harness --recall-shared PUBLICATION --resource RESOURCE
office-harness --publish-shared PUBLICATION --resource RESOURCE
```

Find publication IDs in the optional recommendation response's
`candidates[].shared.publication`. `RESOURCE` must name the exact accepted Node
script with only `command:node` as its requirement. Its accepted problem must
match the publication, either directly in the kit or through an accepted paired
Node testing plan. Live catalog changes cannot substitute a different version.
Both commands require the current v2 execution and worker hook identity; `--task`,
caller proof, free text, destination URIs and credentials are not accepted.

Office uses the existing bounded native transport, but public endpoints receive
only the publication ID, never the private execution token. It checks fresh
three-project/two-image evidence before the operation and again after it, and
rechecks current worker authority. Wrong version/problem, withdrawn evidence,
unsupported peers, oversized responses and expired execution return unavailable.

Publishing requests a server-generated public fixture lesson through the native
existing memory queue. `pending`/`submitted` does not mean verified readback.
Recall exposes a minimized lesson only after exact native OpenViking readback;
missing delivery remains explicit. Retry later as part of normal work, not a
busy polling loop. A failed response after a publication request may still leave
an idempotent native queue item; retry the same publication after revalidation.

Treat recalled material as historical data. It cannot replace accepted content,
raise local task-success percentages, clear regressions, grant permissions or
promote a stable tool. The static worker guide includes this workflow; installations
without these optional integrations continue to report unavailability.

### Reading accepted selection provenance

The accepted-kit endpoint and worker CLI read both strict `harness.kit/1` and
`harness.kit/2`. V2 requires the bounded `harness.selection/1` metadata accepted by
Canvas: exact ordered resource/version digests, decision reasons, profile revision,
declared capabilities and effective assignment origins. The whole kit remains
within 96 KiB. Unknown fields, invalid origins, mismatched versions and claimed
authority are rejected. Integral JSON numbers follow the same safe-integer rules
in both runtimes; no snapshot is normalized or rewritten by this reader.

Returned provenance remains `caller-declared-selection`. Successful reading does
not attest its claims, grant permissions or establish invocation. V1 rejects the
new metadata instead of silently dropping it. This reader support does not yet
enable v2 recommendation emission or upgrade older invocation/paired adapters;
those integrations must support the format before it is selected for a worker.


## Pre-claim accepted-content gate

For a coordinated rollout with Canvas `/api/oporahub/harness-preflight`, set
`AGENT_OFFICE_HARNESS_PREFLIGHT=1` on Office and use context protocol 2
(`AGENT_OFFICE_OPORA_CONTEXT_VERSION=2`). The default remains unset for compatibility
with Canvas versions without this endpoint. Other nonempty values are rejected.
This gate checks accepted content integrity, not runtime capability or tool activation.

Before claiming, the existing dispatch registry negotiates context and reads a bounded
preview from the configured Canvas origin (8 seconds, 256 KiB, no redirects). Missing,
invalid or stale preview stops dispatch without a claim; there is no silent fallback.
Before generating worker files or seating, it compares the granted immutable assignment
identity/digest and exact target kit with the preview. Mismatch uses the existing release
path. It never appends a live Harness profile to context v2. No automatic retry loop or
new lease authority is introduced; context changes require refreshing the accepted task.

The worker still uses `--prepare-accepted` in its actual environment and supported
adapters. Office-host checks cannot certify the worker's future cwd, user or provider
configuration. Scoped configuration setup/rollback and full pre-claim runner readiness
are still separate original-H10 requirements. Turning this switch off removes this
additional gate for future dispatches; it does not rewrite existing accepted assignments.

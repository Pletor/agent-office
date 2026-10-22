# Optional isolated Opora executions

The isolated executor is a separate, explicitly selected execution path. The
existing desk workers, handout and autopilot keep their current local path.
Missing configuration makes the isolated path unavailable before a Canvas claim;
it never selects a host CLI as a fallback.

The implementation has 46 passing focused tests, a passing typecheck and build,
synthetic cross-language checks for both context versions, and a completed live
Managed Agents staging check on 2026-10-21. The live context-v2 run returned one
native Canvas receipt, confirmed provider termination and signed cumulative
usage. This bounded check does not establish an invoice guarantee or physical
termination SLA. The complete Office test suite is not green; see below.

## Operator configuration

Configure the Office server process, not the browser or worker environment:

| Variable | Required value |
|---|---|
| `ANTHROPIC_API_KEY` | Dedicated provider API credential |
| `AGENT_OFFICE_OPORA_MANAGED_GITHUB_TOKEN` | Dedicated authorization for the mounted repository |
| `AGENT_OFFICE_OPORA_MANAGED_CANVAS_URL` | Exact trusted Canvas origin; HTTPS or loopback HTTP |
| `AGENT_OFFICE_OPORA_MANAGED_AGENT_ID` | Existing Managed Agents agent |
| `AGENT_OFFICE_OPORA_MANAGED_AGENT_VERSION` | Explicit positive version, never latest |
| `AGENT_OFFICE_OPORA_MANAGED_ENVIRONMENT_ID` | Existing cloud environment with limited networking |
| `AGENT_OFFICE_OPORA_MANAGED_ENVIRONMENT_DIGEST` | SHA256 of the approved environment configuration |
| `AGENT_OFFICE_OPORA_MANAGED_CONFIGURATION_DIGEST` | SHA256 of the approved effective agent and environment configuration |
| `AGENT_OFFICE_OPORA_MANAGED_MAX_LIST_COST_CENTS` | Positive whole USD cents, written as a string |
| `AGENT_OFFICE_OPORA_OBSERVER_ID` | Matching scoped observer ID configured in Canvas |
| `AGENT_OFFICE_OPORA_OBSERVER_SECRET` | Matching independent signing secret, 32–512 UTF-8 bytes |

No credentials are borrowed from `gh auth`, a local CLI subscription or an
unrelated GitHub token. Do not put them in plans, prompts, repository files,
browser state or logs. The connected floor's Canvas origin must match the
server pin; changing the floor link cannot redirect private authority.

Canvas needs `OPORA_EXECUTION_OBSERVERS` configured on its server. Its bounded
JSON map associates each observer ID with `secret`, `project`, `workspace`,
`provider: "anthropic-managed-agents"` and `maxListCostCents`. The scope is exact;
the broker cannot choose a different project or raise the configured cap.
Worker identities and lease tokens cannot authorize observer writes.

Inspect the pinned agent's instructions, tools and permissions and the complete
environment network configuration before approving their digests. The hash
algorithm is canonical sorted JSON followed by SHA256. Environment hashing uses
`environment.config`; the combined digest uses `configurationDigest(agent,
environment.config)` from `src/server/opora/executors/managed-projection.ts`.
The effective agent fields are defined there explicitly; labels and timestamps
are not approval evidence. The provider is queried again before admission and
the actual session configuration and mounted commit are checked before work.

The local repository must have a credential-free GitHub origin and a commit
reachable through an existing origin tracking ref. Office only reads these
pins. The remote session mounts that exact commit at `/workspace/repo`; local
uncommitted files are not transferred. Provider documentation describes
[versioned sessions](https://platform.claude.com/docs/en/managed-agents/sessions)
and [repository mounts](https://platform.claude.com/docs/en/managed-agents/github).

## Explicit API entry

The feature routes are under `/api/opora/isolated-executors`, with a required
`?floor=<office-floor-id>` parameter. Requests use normal Office session auth.
POST additionally requires same-origin and the existing admin role; a shared
password session retains its existing admin semantics.

| Method and suffix | Body or result |
|---|---|
| `GET /capabilities` | Actual availability and supported guarantees |
| `GET /runs` | Redacted stored run status and observation provenance |
| `POST /start` | `{ "executorId": "anthropic-managed-agents", "cardId": "…", "requestId": "…" }` |
| `POST /stop` | `{ "intentId": "<40 lowercase hex>" }` |
| `POST /reconcile` | `{}`; reconcile original sessions, never create replacements |

POST bodies are bounded to 16 KiB and reject unknown keys. Choose a new request
ID only for a new explicit action. Repeating the same start returns the original
stored run; reusing its key for different input conflicts. A removed floor or
changed scope cannot admit new work. Errors never reflect credentials or raw
provider responses.

The card requires an accepted unchanged assignment and a Canvas budget-v2
allocation. Context v1 and v2 are negotiated separately. Private lease tokens
stay in Office. The remote prompt contains the immutable assignment and report
instructions, without a worker capability for the local Canvas API.

## Recovery, stopping and accounting

The private request store and provider journal live below the floor's
`.agent-office/isolated-executions` directory, independently of `workers.json`
and `opora.json`. They preserve the original request, lease, intent and mapping.
Corruption, an uncertain write or missing configuration fails closed; do not
delete records to make a new run appear eligible.

A session is created without work, its ID is persisted, then the original
Canvas authority is revalidated before sending the assignment. An uncertain
create is `creation_unknown`; neither restart nor request replay blindly creates
a replacement. Recovery reconciles the original mapping. Cancellation and
expiry prevent new work and request provider cleanup while keeping audit data.

An interrupt or idle session is not confirmed termination. Only a provider
readback of `terminated` establishes that fact; failures remain pending or
unknown. Exact physical termination at the local deadline is not a supported
guarantee. See [session operations](https://platform.claude.com/docs/en/managed-agents/session-operations).

The broker obtains cumulative token counts and public list cost from the provider
API and signs independent Canvas observations. A worker-supplied report is not
accounting evidence. List cost is stored as integer USD cents and is distinct
from an invoice. The provider budget prevents new model requests at its cap;
in-flight requests and tools can overshoot. An exact invoice hard cap is not
supported. See [session budgets](https://platform.claude.com/docs/en/managed-agents/budgets).

Canvas keeps immutable observations and a CAS head. Replays do not count twice;
late usage can be recorded after expiry without renewing work authority. A
global reservation prevents one provider session from being charged to two
intents. That reservation commits before project evidence; a crash can retain a
same-intent reservation. It is not a cross-database atomic transaction and is
never automatically reassigned or deleted.

Active accounting polls default to 60 seconds. Identical status and cumulative
usage do not append another record. Automatic terminal follow-ups have a durable
limit of three; explicit reconciliation can fetch later totals. Reconciliation
also performs recovery cleanup of original nonterminal mappings; it never resumes
them or creates replacement work. Records retain their observation timestamps,
so a previous status is not presented as fresh work authority.

Canvas shows provenance, observation time, termination status and list cost in
the existing OporaHub overview and execution detail. Unknown-session zero
sentinels are not proof of zero spending. Configuration alone does not prove
current provider connectivity. See the Canvas observer contract for schema
upgrade, quotas and retained-history rules.

Remote result text remains an agent's report. It is checked against the exact
intent and submitted with the original private lease; it does not automatically
verify code, finish a card, merge a PR or deploy anything.
The broker reads the latest message through the provider's `types[]` array
filter. Reports may be raw JSON or one entire `json` Markdown fence, with optional
outer whitespace. Prose, other fence languages and multiple blocks are not
extracted. The same exact identity, duplicate-key, depth and size checks apply
after removing this presentation wrapper; the original message byte limit still
applies. Raw JSON remains the requested output format.
The first write requires current floor and lease authority. After revocation or
restart, an uncertain receipt is resolved only through the existing read API;
a local attempted marker is not proof that Canvas committed a result.

## Validation limits

The focused executor, route, result and size tests pass (46 cases), as do
`npm run typecheck` and `npm run build`. The standard complete `npm test` run
exceeded 150 seconds and was stopped. A diagnostic run with a 10-second per-test
limit recorded 755 passes, 24 failures, 5 cancellations and 1 skip (785 tests).
All 29 non-success records match the recorded e93 baseline in name and critical
diagnostics after normalizing worktree paths, temporary IDs and CRLF. Timing,
stack and location were excluded. This does not establish a fully green suite.

The earlier synthetic cross-language integration uses the real Office service/routes and real
Canvas APIs, with only the external provider simulated. Both original context
versions produced one claim, provider session and native result receipt;
duplicate requests and recovery produced no replacement work. No paid provider
request was used in that earlier synthetic check.

The live staging check used published product commit `bc25ebb` and an explicitly
configured Haiku 4.5 agent in a cloud environment with limited networking,
delegation/MCP/skills/package installation disabled, and a pinned private GitHub
commit. Provider tool-result outputs corroborated the commit, Linux execution
and the permitted workspace probe. The context-v2 run produced exactly one
receipt and the exact context proof; replay and reconciliation preserved the
original session and receipt. It ended `terminated`, with 2 USD cents list cost
and 25.12 active seconds. These readings are not an invoice or universal sandbox
security proof. Agent result contents remain agent-reported.

The first live context-v1 attempt exposed the event-filter wire bug and ended
with no receipt. Its original session was terminated; list cost was 1 cent and
active time 15.71 seconds. It was not relaunched or retrospectively submitted.
Both allowed session creations are accounted for; combined list cost is 3 cents.
The query correction and whole-JSON-fence handling were independently reviewed
and regression-tested before the second attempt. No merge, production deployment
or global security change was made. The Canvas completion audit retains the
sanitized evidence and explicitly distinguishes the negative and positive runs.

## Pull requests

A run whose result carries `result.patch` (the remote agent is asked for `git format-patch --stdout <pinned>..HEAD`) gets it applied at the pinned commit in a throwaway worktree and handed off like a card worker's: branch, trailers, Canvas link and per-head idempotency. See [pull requests from the isolated broker](opora-review-evidence.md#pull-requests-from-the-isolated-broker).

## Plan steps

A card with pinned plan steps gets the same checklist and step protocol as a card worker ([plan steps](opora-execution.md#plan-steps)): one commit per step in `/workspace/repo` (`step <id>: <title>`) and `result.stepResults`. Each step's `evidence.commits` comes from git, never from the agent's claim. The patch's own commits are the remote container's, which exist nowhere else, so before the result goes to Canvas the office replays the patch exactly as the pull request will (same pinned commit, committer identity and dates, so the same SHAs) and sends each step the replayed commits whose subjects in `<pinned>..HEAD` read `step <id>:`. The pull request's `## Kroky plánu` section lists the same SHAs. With nothing replayed (no patch, `AGENT_OFFICE_OPORA_AUTO_PR=off`, no pull requests, or a patch that doesn't apply) the steps go without commits. `stepResults` Canvas would refuse (or any, for a card without steps) are left out of the result, which still goes through.

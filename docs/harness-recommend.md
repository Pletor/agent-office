# Automatic work-kit preparation

When the native peer supplies regression guardrails, an exact-version incident/revert
association excludes optional resources from automatic preparation. Explicit inherited
choices and baseline instruction/testing guidance remain selected with a warning.
An incident association must not optimize away the baseline verification policy.
Acceptance percentages stay unchanged: incident
reports do not prove tool causation, and no incident does not establish production
success. Older peers without this additive field retain unknown guardrail coverage.

An agent can assemble a problem-specific kit with one read-only command:

```sh
office-harness --recommend ts.references --task 'opora:PROJECT:WORKSPACE:CARD' --capability command:node
```

The authenticated worker command derives its floor, project and workspace from Office. Ordinary workers see project and explicitly shared resources; the active administrator-owned planner also sees permitted machine sources. The browser endpoint is `GET /api/harness/recommend?floor=F&problem=ts.references`; workers use `/office/harness?recommend=1`. Both return `harness.recommendation/1`: candidates, reasons, missing requirements, history availability, profile revision and a complete `kit` proposal. They preserve manual profile choices and accepted assignments, never claim cards, execute tools or promote new resources. When lifecycle support is installed, preparation can refresh, suspend or roll back existing recommendation state under the profile revision transaction.

Outside a worker, `node bin/office-harness.js --project PROJECT --recommend ts.references` uses the local published catalog. Native Office scope/history and persistent inheritance are unavailable and labeled accordingly. A configured worker hook never falls back to local machine discovery.

Use `office-harness --search "words" [--category CATEGORY]` to narrow catalog metadata before loading content, `--read ID` to read one resource, or `--bundle ID...` for a context pack. These also work through authenticated worker hooks. Remote bundles reuse the pinned-kit producer and its 24-resource / 96-KiB limit; they carry resource IDs and exact content digests. No source file is executed by searching, reading or bundling.

## Publish problem-matched tools

Create and test a resource in an isolated branch, then declare it in `.harness/toolbox.json`:

```json
{
  "schema": "harness.toolbox/1",
  "resources": [{
    "path": "scripts/check-types.mjs",
    "problems": ["ts.references"],
    "requires": ["command:node"],
    "priority": 20
  }]
}
```

The resource must exist in the same published source. Paths are relative and cannot escape it or refer to private machine files. Existing catalog boundaries, link checks, credential exclusions and size limits still apply. A manifest allows at most 64 distinct paths, each with 1–8 problem IDs, at most 16 distinct requirements and integer priority −100…100. Unknown fields such as `verified` are refused. Problem matching is exact; category comes from the actual catalog. Metadata changes during preparation refuse the result.

For shared access, the operator may set `AGENT_OFFICE_SHARED_HARNESS_DIR` to an intentionally published collection with the same `toolbox.json` format. Every floor and worker can read it. Personal skill folders and `AGENT_OFFICE_HARNESS_DIR` remain machine-owned and restricted. No private file is automatically published and no project outcome authority transfers between projects. Publication/review/write permissions stay with the existing repository/operator policy; automatic global promotion is disabled.

Agents may improve scripts, skills and rules through their normal code workflow. Keep implementations deterministic where possible, requirements explicit and tests tied to observable outcomes. The selector does not invent an implementation when none exists: it reports missing/unmeasured resources so the agent can prepare, test and register a suitable tool.

## Inheritance and selection

Inherited explicit assignments remain mandatory. Disabled inherited slots suppress automatic reintroduction, including checkbox overrides from the seven-level editor. `settings.harness.auto = {"value": false}` disables automatic additions; explicit resources and scalar context remain. An installed seven-level module supplies its bound Canvas path; older installations retain the existing three-level resolver. An installed but broken hierarchy module never silently falls back. Changed profiles or scope require a retry.

With automatic additions enabled, basic instruction/testing references are included unless disabled. The selector can add up to three sufficiently sampled candidates and **at most one** insufficiently measured candidate. It keeps the 24-resource / 96-KiB escaped-JSON budget. Scalar settings become a content-addressed `profile:settings` reference; they do not grant permissions or select runtime provider flags. Explicit unavailable resources or unresolved executable requirements return constraints and `kit: null` instead of silent substitutions.

Probe requirements in the actual runner before repeating `--capability ID`. These flags are caller declarations, not native attestation. A script/command/tool/hook/MCP/plugin explicitly selected without matching toolbox metadata needs its requirements declared before automatic preparation. Selecting text never proves a tool is installed, authenticated or permitted.

`proposalStatus` distinguishes `blocked`, `reference-only` and `tools-proposed`. `unresolvedCandidateRequirements` lists probes still needed for matching candidates. A reference-only proposal can contain the basic guides while every executable candidate is unavailable; it must not be presented as a complete runtime toolset.

## Measured experience

Office also reads `/api/oporahub/harness-paired-evaluations` from the same configured
peer in parallel, with a five-second deadline, no redirects or forwarded worker
credentials, and a 1-MiB response bound. The response's project/workspace, execution
identity, trial order, counts and comparison are validated; arbitrary fields are
dropped. `pairedHistory` reports unavailable evidence, receipt-window limits and
invalid/conflicting receipt counts explicitly. An older Canvas without this endpoint
returns unavailable evidence; existing proposal-only preparation still works.

For exact Node script ID/content digest/problem and `command:node` requirements,
`candidates[].pairedEvidence` exposes source receipts, plan and both version digests.
A completed comparison reporting a fixture regression excludes that optional candidate from automatic
selection and marks it `regression-review-needed`, even when net improvement is
positive. An explicit inherited choice remains selected with
`paired-fixture-regression-needs-review`; baseline instruction/testing policy stays
in force. Incomplete comparisons remain visible but cannot suppress selection: loss of execution authority or incomplete cleanup is not a completed tool comparison. No existing profile or running pinned assignment is changed.

Positive paired reports do not raise verified percentages, sample sizes, confidence
or observed-success eligibility. They remain exploratory evidence awaiting independent
review. Repeated experiments are not independent production trials. The native exact-head
review gate and independent output verification are separate requirements; this change
does not grant promotion authority. A bounded window can omit older regressions, so
an empty list or unavailable peer is not a clean bill of health.

Office reads the configured floor's native Canvas `/api/oporahub/harness-learning` endpoint with its own project/workspace, a five-second deadline and a 256-KiB response limit. Wrong scope, malformed counts, duplicate cohorts and unavailable peers become explicit unknown history. Percentages and Wilson intervals are recomputed from counts. Limited history is reported; offline data cannot assert native verification.

Only exact resource ID, content digest, configuration digest and problem match. Text, category or requirement changes start a separate cohort. Agent reports remain separate and cannot qualify observed success. The initial ranking threshold is five known outcomes, three different cards, 80% coverage and a 95% Wilson lower bound of 50%. At least four failures with an upper bound below 50% suppress automatic addition; explicit policy choices remain unchanged and visible. Priority breaks ties, never creates verification.

These are **selected-kit associations**, not proof of invocation or causal contribution. Current cohorts are project/workspace-wide; runner, production incidents and finer hierarchy cohorts are not inferred. A 100% point estimate from one run remains insufficiently measured. No threshold guarantees correctness or authorizes global promotion. Recalled OpenViking facts are historical references; inspect their native source and current outcome before reuse.

For context v2, propose the returned `kit` as `fields.harness` through normal Opora acceptance. Preparation does not modify an accepted assignment or inject live material into a seated worker. Existing `--kit` remains available for explicit preparation. Unaccepted proposals carry no execution authority.

## Verification

Run `npm run typecheck`, `npm test`, `npm run build`. Focused tests cover independent Python/TypeScript configuration identity, unknown evidence, scope/denominator validation, capability constraints, exact versions, inherited disable/auto-off, bounded exploration, metadata races and authenticated HTTP preparation. The feature makes no LLM call or OpenViking write.


## Independent fixture history and lasting quarantine

The configured native verifier contributes separate `fixtureEvidence`. Preparation matches
its accepted problem and exact script content with the Node adapter; it never adds fixture
passes to verified task-acceptance percentages. Any complete candidate failure restrains
automatic reuse, even if the baseline also fails. Explicit choices remain with a warning.

`fixtureQuarantines` contains source verification IDs from the native all-history projection.
An old failure remains effective after leaving the newest100-request window. A newer pass
does not erase it; a different content digest or problem is a different cohort. If the native
projection reports overflow or an unbound failure, or a legacy peer returns a truncated
window without the quarantine projection, automatic Node additions are restrained
with `fixture-history-incomplete`. Missing legacy support or an unavailable peer is exposed
as unavailable evidence, not a declaration of health. Existing human task outcomes and
policy choices remain separate. This is version restraint, not global publication or a
complete experiment/promotion/rollback lifecycle.

## Fresh lifecycle evidence in automatic selection

With lifecycle storage and the retained-native adapter installed, preparation reads
the managed version's saved verification reference and asks the configured native
peer for a fresh assessment. This works after the evaluation session ends; it does
not revive its authority. The existing profile CAS rechecks revision and peer binding
before publishing refreshed or suspended state. If current evidence fails, the exact
retained predecessor is considered only with its own fresh positive assessment and
compatible requirements. Transport failures publish nothing.

The response exposes `lifecycle.status`, its resulting revision and managed versions
excluded from automatic selection. Missing source/adapter or unavailable evidence
cannot use the stored stable label. Fresh stable versions are preferred within the
existing resource/capability limits; manual auto-off and explicit disables still win.
Explicitly assigned blocked versions remain visible with `lifecycle-revalidation-needed`
warnings. Content or requirement changes are different versions, never inherited proof.
Legacy installations without lifecycle storage retain their existing evidence-based
proposal behavior and explicitly report lifecycle support unavailable.

With current lifecycle storage, withdrawn exact versions stay excluded from
automatic selection after rollback and later refreshes, even when their audit
entry has aged out. Fresh eligible re-promotion can clear the exact withdrawal.

## Shared fixture evidence in automatic selection

An intentionally published `Shared harness` toolbox may opt into
`harness.toolbox/2`. Each resource retains `path`, `problems`, `requires` and
`priority`, and adds a required `publication` ID from the native server's explicit
transfer policy. Project toolboxes cannot declare publications. Version 1 remains
unchanged; version 2 is optional and older Office versions reject it. For rollback,
restore the previous manifest, rather than silently stripping its evidence policy.

For example, a shared manifest can contain:

```json
{"schema":"harness.toolbox/2","resources":[{"path":"scripts/check.mjs","problems":["ts.references"],"requires":["command:node"],"priority":0,"publication":"shared-check-v1"}]}
```

The configured Canvas peer must publish that exact catalog resource ID, content
digest and problem. Office reads `/api/oporahub/harness-verifier/eligibility/shared`
with only the publication ID, at most eight distinct publications within one
8-second deadline, with a 256-KiB response limit and no redirects or credentials.
An eligible assessment must retain the native three-project/two-pinned-image
thresholds and explicitly grant neither execution nor promotion authority.

Fresh shared evidence prioritizes one exploratory Node candidate within the
existing one-unmeasured-addition limit. It does not create local task outcomes,
raise success percentages or mark the candidate stable. Local native history must
be available and untruncated, with a complete fixture quarantine projection.
Local failures, capability limits, lifecycle withdrawals, disabled choices and
automatic-selection-off still win. Missing, withdrawn or incompatible declared
shared evidence excludes automatic addition. Explicit choices remain visible with
`shared-revalidation-needed`; missing capabilities still block kit preparation.

Each recommendation exposes normalized evidence on `candidates[].shared`, including
source references, project/image counts and the evidence digest. This is evidence
about approved fixture cases, not independent production environments or proof of
causal benefit. The target project must accept and verify its own assignment.
No private memory is pooled and this read does not publish an OpenViking lesson.

### Why each proposed resource was selected

`selection` follows the same order as `selected`. Each entry contains the exact
resource ID, content digest, configuration version digest, zero-based order and
the decision branch that actually added it: `explicit-assignment`,
`baseline-policy`, `native-stable`, `observed-outcomes`,
`shared-fixture-exploration` or `unknown-exploration`.
Explicit choices also list their effective assignment slots and scopes; overridden
bindings are excluded. Explicit selection takes precedence over baseline or
observed eligibility. A capacity-limited candidate that was not added receives
no selection entry.

Reasons explain the proposal, including an explicit choice whose missing
requirements block kit creation. They do not certify safety, grant permission or
override `constraints`/`warnings`. `selectionEvidence` explicitly marks this as
recommendation evidence. The strict accepted `harness.kit/1` stays unchanged;
persisting this rationale through acceptance and historical replay remains a
separate schema migration. Generated inherited settings are context, not an
additional selected catalog tool.

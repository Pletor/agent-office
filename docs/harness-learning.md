# Harness that learns from work

For the concise current implementation/gap map, see [Harness status](harness-status.md).

Back to [Harness](harness.md). Status: **implementation contract**, not a claim that the learning loop is deployed.

Česky: agent si podle úkolu sestaví pracovní výbavu, ověří ji a po práci vrátí doloženou zkušenost. Knihovna rozlišuje hlášení agenta, skutečně provedené kontroly a ověřený výsledek. Procenta mají počet použití, verzi, typ problému a nejistotu. Osvědčené verze doporučuje, regresní vyřazuje a zkušenosti ukládá přes existující Oporu do OpenVikingu. Tento dokument je připravené zadání, nikoli již spuštěná funkce.

This combines the original Harness H01–H24 plan with the owner's 23 October 2026 request: agents assemble their own working tools, learn from measured outcomes, develop reusable skills and deterministic scripts, and deliver resilient production code. Success means acceptance evidence and useful behavior, not a high self-reported score. No finite test history guarantees a correct future result.

## The agent's working loop

1. Read the accepted card, its acceptance conditions, technology versions and authority budget.
2. Resolve **Global → Project/repository → Page → Layer → Area → Sector → Card**. Keep the provenance of every override. An absent slot inherits, `null` disables, a binding replaces the slot. Dependencies between cards are separate from inheritance.
3. Recall relevant experiences and discover compatible resources. Filter by task fit, scope, runner capabilities and permissions before ranking. Global availability does not inject every global resource into every prompt.
4. Select a small working kit. Pin element IDs, content digests, versions, scope, selection reasons and the selection-policy version in the run snapshot. Mandatory constraints are not candidates for optimization.
5. Probe actual capabilities. Mark each as declared, prepared, verified, unavailable or unsupported. A successful catalog read is not proof that an MCP server or tool works.
6. Work within the accepted assignment. Invoke reusable skills/scripts instead of reconstructing their procedures. Fetch long references on demand by pinned ID. Record attempts and fallbacks, including failed ones.
7. Verify acceptance on the produced revision. Distinguish worker reports, executed checks, independent review, merge, deployment verification and subsequent incidents.
8. Reconcile those observations into outcomes, update recommendations, and persist scoped lessons to OpenViking through Opora. A memory-write failure does not fabricate a successful write or invalidate a completed code change.
9. Propose better versions when existing methods fail. Evaluate candidates against the incumbent in isolation; successful candidates may become recommended under the policy below. Never alter a running agent's pinned kit.

The owner can inspect or override the kit. Ordinary operation does not require ticking every tool by hand.

## Reuse and known integration gaps

The original source is the Opora page `22e31cd8-83c7-490b-a72c-dc453d45a452`, project `6fba3506fa5648f3936d244d07e93750`, workspace `726f0c550e9d4c50aae2e37f75f21d52`. Its original brief-vault fragment is `fc631eecc671459b9f93e5ab312c335e` ("Harness — úplné zadání a odsouhlasená koncepce"). Preserve that history; this contract supplements it.

| Existing work | Reuse / remaining boundary |
| --- | --- |
| main: catalog, F8 library, three-level assignments, authenticated worker CLI | Keep resource discovery and authorization; the catalog is not an execution system. |
| H01/H02, PR #22/#23 | Seven-level identity and resolver; review against current Canvas membership, not screen coordinates. |
| H03/H04, PR #24/#25 | Stable resource versions and project bindings; reuse these instead of inventing competing IDs. |
| H05 on main, H06/H07 PR #28/#30 | Fullscreen library, context selection and category editor. |
| H09/H10/H13, PR #27/#29/#31 | Pinned runs, preparation and runner adapters; these are unmerged chained branches, not deployed capabilities. |
| Office process hub and Opora durable event outbox | Reuse transport, correlation and replay. The Office in-memory ring is not a lifetime metrics database. |
| Opora memory service | Reuse role keys, project-scoped recall/write and session commit. Do not introduce a parallel OpenViking credential store. |
| Current execution context v2 | Only the accepted immutable assignment is passed. Do not append a live Harness profile around this boundary. Integrate a versioned kit through the accepted assignment protocol. |

The older branches need integration review against current main. A historical test report is not a current green check. Do not merge the whole chain without fresh compatibility, security and regression proof.

## Resource and experience identity

All categories participate: instructions, skills, hooks, rules, commands, scripts, tools, MCP, memory, plugins, permissions, testing and operations. An element has a stable ID, immutable version/content digest, category, purpose, supported problem classes, prerequisites, runner/version constraints, inputs/outputs, expected effects, verification recipe and fallback reference. Optional fields remain unknown when not observed.

An experience links the exact element version and **kit version** to project/workspace/card/execution, accepted assignment digest, problem class, technology versions, runner, scope path, timestamps and evidence references. A kit is a combination of elements; success of the combination is not proof of each member's causal contribution.

Keep three identities separate: an element, an invocation/attempt, and a task execution. A retry is another attempt in one execution, not another successful task. Deduplicate upstream events by their stable source ID, and outcomes by execution plus evidence revision. Preserve superseding observations so a late regression changes the projection without rewriting history.

Problem classes are explicit, bounded labels (for example `ts.references`, `ui.visual-regression`, `db.migration`). Agents may suggest labels, but free-form paraphrases must not fragment the denominator or let a failed run escape its cohort.

## Measured signals

Every displayed number includes scope, time window, numerator, denominator, provenance and policy version. Unknown is `null`, never zero. A percentage with no eligible observations is **unmeasured**.

| Signal | Numerator / observation | Denominator / interpretation |
| --- | --- | --- |
| Capability availability | Successful bounded probe | All eligible probes, with unavailable/unsupported reasons separate |
| Invocation reliability | Completed invocation satisfying its output contract | All started invocations; timeouts and crashes fail, skipped calls do not pretend to succeed |
| Verified task pass rate | Unique executions passing all required acceptance checks for the same produced revision | Executions with a determinate acceptance outcome; pending, cancelled and unevaluated shown separately |
| Independent review pass rate | Exact revisions with completed independent review satisfying required policy | Revisions with determinate review outcomes, not worker self-review or a PR merely opened |
| Production survival | Verified deployments without a linked qualifying incident during a declared observation window | Deployments whose full observation window elapsed; immature deployments remain pending |
| Regression rate | Qualifying incidents/rollbacks linked to the tested revision | Mature observed deployments; severity and attribution confidence remain visible |
| First-pass completion | Verified executions needing no repair round | Verified executions with a known repair history |
| Recovery effectiveness | Successful fallback after a classified failure | Executions that attempted that fallback; preserve original failure and recovery cost |
| Efficiency | Observed duration, provider tokens/cost, tool calls and context size | Report sample count and missing coverage per metric; no invented token/currency estimates |
| Human intervention | Required escalations, corrections and rejected results | Executions with recorded intervention coverage; distinguish expected approvals |
| Robustness | Passed edge/adversarial/fault-injection cases | Versioned, predeclared test-suite cases; never reuse the training examples as the only evaluation |
| Evidence coverage | Executions with complete required evidence | All eligible executions, including unsuccessful and abandoned attempts |
| Experience freshness | Age and matching technology/runner versions | Stale or incompatible experience remains visible but cannot prove current compatibility |

Latency uses elapsed monotonic time for a local attempt, explicit event timestamps for cross-service spans, and marks inconsistent/missing spans unknown. Report median and p95 only with the sample count. Provider usage is tied to execution IDs, not inferred from terminal text.

### Evidence and attribution

- **Reported:** agent says a tool helped or a task succeeded. Useful for diagnosis, excluded from verified-success numerators.
- **Observed:** trusted adapter records a probe, invocation result or check exit code. This proves that observation, not the card's complete acceptance.
- **Verified:** an authorized verifier reconciles required evidence against the exact assignment and produced revision. A successful build alone cannot become production success.
- **Production-observed:** a deployment of that revision passed smoke/health checks and completed the observation window. Merge alone is not deployment.

Workers cannot submit their own `verified=true`. Verifier identities and evidence sources are checked server-side. Invalid, forged, stale or cross-project references cannot influence a score. A correction supersedes the relevant outcome; replays cannot double-count it.

An element shown in a successful kit is labelled **associated with success**. A claim that it improves results requires a paired baseline/candidate comparison or an equivalent controlled experiment. Store assignment differences and confounders (model, effort, task difficulty, runner, versions). Compare quality before optimizing cost.

## Selection, experiments and promotion

Selection first enforces compatibility, scope, inherited requirements, resource availability and the current permission envelope. Rank the remaining alternatives within the same problem/technology cohort using observed quality, uncertainty, robustness and then measured efficiency. Return reasons and rejected-candidate reasons; do not hide them in an opaque score.

Use a 95% Wilson interval for a binomial success rate, accompanied by `successes/eligibleOutcomes` and pending counts. It describes uncertainty in that cohort, not a guarantee. Do not rank a new 1/1 resource as better than a well-tested incumbent solely because its percentage is 100%. Multiple attempts on the same assignment are correlated; deduplicate primary task metrics and retain retry metrics separately.

Initial policy candidates, to be versioned and calibrated during the pilot:

- **Experimental:** new immutable version; usable only in an isolated, bounded evaluation or an explicitly eligible task. No automatic overwrite of a stable element.
- **Project recommendation:** at least 20 determinate verified task outcomes across at least 5 distinct accepted tasks, required fault tests passed, no unresolved severe regression, and a paired comparison demonstrating the predeclared quality floor. These are minimum gates, not proof of sufficient statistical power.
- **Coverage:** at least 95% of registered eligible executions must have a reconciled determinate outcome before promotion; unresolved evidence cannot simply disappear from the cohort. Abandoned runs and cancellations retain their reasons and costs. No success credit is assigned to them.
- **Global recommendation:** project gate plus evidence across at least 3 projects and 2 relevant environments, compatibility checks and a controlled comparison. Only a sanitized, intentionally shareable element can become global. Project-private artifacts stay private.
- **Exploration:** at most 1 candidate per kit and at most 5% of eligible non-production evaluation runs, within the existing time/attempt/cost budget. An exploration budget never creates permission to spend or access data.
- **Regression response:** a verified severe regression immediately quarantines that candidate version for new selections. Keep the last compatible stable version available; retain evidence and notify the owner. Existing runs keep their snapshot and receive an explicit incident signal rather than a silent replacement.

The learning service can update recommendations within the accepted policy. It cannot approve its own code PRs, alter permissions, turn off required checks or accept a Canvas plan. New executable scripts are versioned code changes with tests and ordinary review. Learned instructions remain reference data under the user's and repository's instructions.

## Context7 and OpenViking

Context7 provides current documentation, not outcome truth. Resolve the library ID, then query the specific API/version used by the repository. Record retrieval time, library ID/version and source in the run. Documentation lookup failure has a bounded fallback to official pinned documentation; it must not be silently labelled a successful Context7 invocation. Never send secrets or private source just to resolve a public library.

Official contract: [MCP client setup and tools](https://context7.com/docs/resources/all-clients), [API and version IDs](https://context7.com/docs/api-guide). Actual activation uses the supported runner adapter and a harmless probe; credentials remain in native configuration.

OpenViking stores explanatory experience: problem, prerequisites, scoped procedure, why it worked or failed, immutable artifact references, verification evidence, caveats and a supersedes link. Failures are retained as failures so another agent can avoid them. Ranking statistics come from the evidence projection, not a language model's retelling of memory.

Reuse Opora's memory API and role/project identity. Queue durable writes through the existing event/outbox lifecycle with an idempotency key derived from execution, outcome revision and lesson digest. Track pending, sent, confirmed and failed separately; async acceptance is not successful extraction. Recovery after restart must neither lose a lesson nor credit it twice. Publish a separate sanitized global lesson; do not move private project memory into a public namespace.

Recall must return provenance and applicability. A remembered result never overrides the current accepted card, repository instructions or permission envelope. Verify stale claims against current code/docs. The absence of memory cannot prevent the agent from doing an otherwise permitted task.

## Human-readable interface

The library shows categories and the selected hierarchy context. Each resource shows purpose, compatible tasks, exact version, availability, `successes / outcomes`, percentage/interval, pending evidence, source scope and last verification. A resource with no evidence shows "Dosud neověřeno", not "0%".

The card's Harness detail shows the pinned kit, why it was selected, what the agent actually used, fallbacks, verification and the lesson written. Distinguish draft selection, saved profile and an active run snapshot. Selecting a checkbox is not an installation. Top-right ✕ and Esc immediately restore mouse-look.

## Delivery and proof

Continue H01–H24; do not duplicate their ownership. Add a learning track with these bounded outputs:

| Card | Output | Acceptance / principal files |
| --- | --- | --- |
| H25 | Audit main, old branches and execution-v2 integration seams | Reproducible compatibility matrix; `docs/harness-learning.md`, existing `tests/harness*.test.ts`, `tests/opora-context.test.ts` |
| H26 | Versioned observation contract and replayable evidence projection | Duplicate/out-of-order/stale/wrong-scope/forged-source tests; `src/shared/harness-learning*.ts`, `src/server/harness/learning/`, existing Opora outbox adapter |
| H27 | Problem-scoped recommendation and uncertainty | Missing evidence stays unknown, new versions isolated, retries cannot inflate rates; selection explanation contract and deterministic tests |
| H28 | Pinned kit through accepted assignment and real capability probes | Context-v2 remains immutable, cross-project denial, Context7 probe/fallback, no bypass around the execution protocol; coordinate Office and Canvas PRs |
| H29 | Automatic outcome reconciliation and OpenViking experience delivery | Reported vs verified distinction, exact-revision checks, failure/retry/restart/deduplication, real scoped memory roundtrip in an isolated pilot |
| H30 | Candidate evaluation, recommendation promotion and quarantine | Controlled paired evaluations, sample/coverage gates, invalid evidence rejection, severe-regression rollback, unchanged permissions |
| H31 | Category/card learning views | Headless desktop/mobile screenshots, accessible controls, real API evidence and unknown/error states, ✕/Esc mouse-look |
| H32 | Production-readiness pilot | End-to-end select→prepare→work→verify→remember→next-selection; fault injection, rollback, measured report and deployment identity |

Every implementation card has small steps with explicit file scope, dependencies and observable acceptance. Rebase a small PR from fresh Pletor main, run `npm run typecheck`, `npm test`, `npm run build` plus relevant browser checks. Compare known baseline failures by test name; never call a failing full suite green. Avoid stacking a new learning PR on the old unmerged chain.

Completion requires the complete loop exercised on at least two different problem classes and projects, failures counted, artifacts traceable, no fabricated metrics, memory outage/recovery demonstrated, and independent review plus an authorized deployment of the same tested revision. The final report states what is measured, what remains unmeasured and the limits of the pilot. Open PRs alone do not complete this goal.

## Initial authority state (23 October 2026)

Read-only OporaHub audit: the Harness workspace currently has `acceptedHead: null`, `reason: no_accepted_baseline`, no claimable execution, and 58 cards in planning. The H01–H24 implementation cards have no accepted execution steps. Prepare and review the combined plan before the human accepts its baseline; do not impersonate that action or use a legacy lease as a workaround. Draft planning, compatibility inspection and isolated validation of existing code can proceed meanwhile.

The supplemental draft is now in brief-vault `9f0b1f34594a4700b245e982bdbf1d77`, with sector `016f8488-568f-45dd-8c1e-84c7db20612b` and H25–H32 (24 steps, 7 next edges). H25 is `277a98ea-cfc0-4512-870f-dc9fabf2424e`. The canvas-plan dry run and subsequent readback confirmed that the steps were stored. None of these writes accepted the plan or claimed a card.

### Compatibility findings from the initial audit

- Baseline: Pletor main `fa9b1d9`. The H13 tip `8fb32597bef89845478b09cae11c0246801beb6c` includes 87 changed files / over 11,000 added lines relative to its common ancestor with current main. It is not a small integration patch.
- H13's `src/server/opora/bridge.ts` calls the old `client.claim` lease, then `claimAndSeat` and injects `prepared.context`. Current main uses `ExecutionDispatch` and omits `prepare()` in context v2. Port the preparation into the immutable accepted-assignment contract; do not restore the legacy path to make the old tests pass.
- H13's `harness/capabilities.ts` supports per-run MCP configuration for Claude Code; Codex and other runners explicitly have no such adapter. `mcp-probe.ts` verifies a stdio `initialize` reply. That does not verify `tools/list`, a Context7 documentation lookup, or an HTTP MCP connection. Those need their own bounded evidence before being shown as available.
- Opora's live `/api/memory/status` returned `configured` with the loopback server responding on port 1933. This establishes service health only; no learning write/recall pilot has been performed.
- Current `/api/memory/remember` requires a human-confirmed write; `MemoryService.commit_card` is the existing automatic card-session path. H29 must define an authorized service-owned lesson path with evidence and idempotency, or reuse the card lifecycle. Do not make agents send `confirmed: true` to impersonate a person.
- The current memory service does not itself implement the proposed durable lesson delivery/deduplication contract. Reuse the existing durable event infrastructure and add delivery state at its owner; do not pretend that a successful health check proves this loop exists.

### Verification of the baseline and available integrations

Baseline measurements below were taken before implementation in an isolated Windows checkout of `fa9b1d9`, with independent dependencies (`npm ci --ignore-scripts` followed by successful `npm rebuild --foreground-scripts`).

| Check | Observed result |
| --- | --- |
| `npm run typecheck` | Exit 0 |
| `npm run build` | Exit 0 (client and server) |
| `npm test` | Stalled after test 247; interrupted the owned test session, not other sessions |
| `node --import tsx --import=#tests/css --test --test-timeout=30000 tests/*.test.ts` | Exit 1: 938 tests, 898 pass, 35 fail, 4 cancelled, 1 skipped |
| `node --import tsx --import=#tests/css --test --test-timeout=30000 tests/harness*.test.ts tests/opora-context.test.ts tests/size.test.ts` | Exit 0: 26 pass, 1 skipped |
| Canvas draft | Dry run, persisted readback (including step dependencies) and headless screenshot |
| Context7 remote MCP | Read-only `initialize` and `tools/list`: HTTP 200; advertised `resolve-library-id` and `query-docs`; no runner configuration changed |
| OpenViking through Opora | Scoped role-backend/project/H25 recall: configured, 1 item, not truncated, 7,703 ms; no memory write |

The bounded full-suite failure/cancellation rows occur in clone (5), codex-usage (1), dsh (18), install (1), jukebox-routes (1), maps (3), repos (3) and workers (7). Counts include file-level timeout rows and are not 39 independent product defects. Preserve the exact failing names when comparing a later implementation; unrelated runtime fixes belong in separate changes.

Local audit artifacts are in `C:/Users/Admin/AppData/Local/Temp/harness-learning-night/`: `typecheck.log`, `build.log`, `tests.log`, `tests-bounded.log`, `baseline-failures.json`, `focused.log`, `context7-probe.json`, `memory-probe.json`, `plan.png`. These paths are audit-machine locations, not shipped product dependencies. Raw recalled memory was not copied to the report. The successful protocol probes do not prove a documentation query or an automatic verified lesson write.

### Implemented evidence replay (first H26 slice)

Run `npm run harness:replay -- observations.json` from the repository. The input is an array of normalized observations (at most 10,000, file at most 8 MiB). Example:

```json
[{"source":"fixture","id":"event-1","revision":1,"attempt":"attempt-1","execution":"execution-1","cohort":{"resource":"script:check","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runner":"codex@1","problem":"ts.references","scope":["global","project-1"]},"signal":"invocation","tier":"reported","outcome":"pass","durationMs":12}]
```

`scope` contains an ordered prefix of the seven hierarchy IDs, not display names. `digest` is the exact resource content SHA-256. `runner` must identify its version. Cohorts are isolated by every field; no cross-project or cross-version aggregation is implicit. Signals are `availability`, `invocation`, `acceptance`, `production`; tiers are `reported`, `check`, `verified`. Each signal/tier gets its own denominator. An observation can be `pass`, `fail` or `unknown`; unknown is neither success nor failure. Missing duration is `null`, an observed zero is `0`.

Replay returns counts, determinate percentage, 95% Wilson interval, determinate coverage, distinct executions and observed duration coverage/mean. Retransmitting the same event revision is idempotent. A higher revision can correct a pass to failure or retract it to unknown; delivery order does not affect the result. Conflicting revisions, changed identity and multiple source identities for one unit fail closed. Availability/invocation count an attempt; acceptance/production count an execution, so task retries cannot inflate accepted outcomes. Source adapters must reconcile competing evidence before replay. These rates describe association with results, not causal contribution; repeated executions of one task are not proof of independent task diversity.

This CLI is an **offline evaluator**, not an evidence authority. Its output is always `authority: offline-untrusted`, `promotionAllowed: false`. An input claiming `tier: verified` authenticates nothing. It neither changes profiles nor promotes tools nor writes OpenViking. Production ingestion must derive tiers from authenticated source adapters. Existing office `tool.use` events lack immutable resource versions and terminal invocation results; they must not be silently converted to success observations. The office process ring/push queue are bounded and the Opora outbox has retention, so durable projections need a transactional cursor and explicit gap handling before live learning can be claimed.

Verification of this slice: typecheck and client/server build pass; focused Harness/context/size tests pass (40 pass, one skipped), including CLI subprocess checks. `npm test` again stalls in the baseline clone tests; the bounded full run completes with 909 pass, 35 fail, four cancelled and one skipped. Its 39 failure/cancellation row names exactly match the pre-change baseline (no added or missing failure names). Full-suite health is still red. No office UI changed in this slice.

### Accepted-kit producer and native projection milestones

Agent-office PR #48 also implements `office-harness --kit PROBLEM ID ...`, the authenticated
worker/session equivalents, and the missing plugins/permissions categories. The producer
reads through existing catalog boundaries, pins exact content and SHA-256 and enforces the
same escaped-JSON budget as Opora. Ordinary workers cannot select machine-only resources.
A real CLI-produced two-resource payload passed the Canvas validator without rewriting.
See [accepted kits](harness.md#accepted-tool-kits) for usage and context-v2 deployment settings.

Canvas PR #46 adds accepted `fields.harness`, context-v2 revalidation, complete review
visibility and a durable projection registered in the existing native outbox transaction.
Reported step outcomes, unique human closure of merged work and withdrawal on reopening
remain separate. The projection survives retention and reopening the database, deduplicates
sources and rejects stale accepted lineage (including change-and-restore). It exposes scoped
counts, coverage and uncertainty through a read-only API. No second event bus is introduced.
This code is in review branches, not deployed production behavior.

Additional verification: Harness/size focused suite 38 pass/one skip; final API/kit/size subset
seven pass; typecheck and build pass. Headless desktop/mobile library state suite and both new
categories pass. The later bounded whole Office suite has 905 pass, 32 fail, six cancelled and
one skipped. It contains additional timing failures in execution/worktrees compared with the
earlier baseline; all 21 tests of those two files pass when rerun separately. The entire suite
remains red. Canvas library tests cover trust, rollback, version cohorts, retention, closure
withdrawal and protocol downgrade; 259 existing event/context/database regression tests pass.

The subsequent review milestones restore seven-level editing (Office #55) and actual bounded
Context7 MCP reads (Office #56). Both passed their full Linux build/test/pack/install workflow;
the initial Office #48 producer did too. Local Windows full-suite baseline failures remain
documented in PR evidence rather than being called green.

Office #48 now adds [problem-scoped automatic preparation](harness-recommend.md): strict
project/shared descriptors, exact content/configuration cohorts, count-derived uncertainty,
inherited policy and bounded candidate additions. It proposes a kit without changing profiles
or activating tools. Caller-declared capabilities do not become native attestation. The peer
Canvas #46 also queues immutable native outcome facts and withdrawals for existing enabled
OpenViking role credentials, with retry/lease fencing and read-only delivery status. Submitted
content is not a claim of completed indexing or extracted verified lessons. These are still
review-branch implementations, not deployed production behavior.

Observed invocation and runner identity, finer historical hierarchy cohorts, production
incident attribution, paired candidate evaluation/global promotion and the complete production
pilot remain outstanding. Native measurements remain selected-kit associations; missing
invocation/cost/runtime values are unknown and automatic promotion stays off.


### Independent fixture feedback

Preparation also reads `/api/oporahub/harness-verifier/requests` from the configured
Canvas peer. `fixtureHistory` reports availability, bounded-window coverage and unknown
records; `fixtureEvidence` identifies native verification, execution, problem and exact
plan/baseline/candidate digests. Native server observations stay separate from worker
reports and task acceptance rates. The consumer recomputes complete pair comparisons;
pending, interrupted and older records without problem binding cannot establish success.
Any independently observed candidate failure restrains automatic reuse only for the same problem and
script content with the Node adapter. Explicit assignments remain with a
`verified-fixture-regression-needs-review` or `verified-fixture-failure-needs-review` warning.
A candidate that still fails is restrained even when its baseline also fails or another case improves. Fixture improvements do not add verified
tasks, raise production success, or authorize promotion. Missing/disabled verifier history
is unknown; library preparation still works with its other evidence and policies.


Native verifier capacity is exposed as `fixtureHistory.budget` in recommendations.
Office validates the exact project/workspace and recomputes remaining capacity from
the configured ceiling and retained admission count. Disabled, unavailable and
other-scope configuration are explicit; older peers report budget unavailability.
This is a read-only snapshot, not a reservation, execution permission, five-percent
exploration-share gate, or promotion decision. Native admission remains authoritative.


### Native nonproduction allocation in recommendations

The existing `fixtureHistory.budget.exploration` snapshot is preserved when advertised by
Canvas. Office checks its fixed 5% rule (one retained experiment per nineteen eligible
completed baseline cards), nonnegative safe counts, consistency with the same admitted
counter, and exact policy digest. A malformed advertised snapshot rejects the native
fixture response; a missing field stays absent and `unavailable` stays unknown.

Agents should inspect both cumulative capacity and exploration eligibility before
scheduling. Neither field reserves a slot or authorizes execution. The backend rechecks
scope, policy, the proposed card and current retained evidence transactionally, so a
positive generic snapshot can still be refused for a particular task. These counts
measure nonproduction work allocation, not causal tool benefit or production success.
## Planner handoff to accepted equipment

The existing Opora planner/router prompt callback includes Harness guidance even
before any kit exists. When the optional v2 writer and compatible native validator
are installed, request `office-harness --recommend PROBLEM --kit-schema harness.kit/2 --task KEY`.
Use the exact namespaced card key from the linked hierarchy/effective profile.
Declare only capabilities checked in the intended worker runner; the planner's
host capabilities or model name do not establish worker readiness.

Inspect constraints, warnings and selection provenance. A null kit means blocked;
an unavailable integration must not silently downgrade the requested format. Submit
the returned kit unchanged as the target specification's `fields.harness` through
the existing proposal and acceptance flow, then dispatch a new accepted assignment.
Changing a profile alone neither equips a context-v2 card nor replaces its running kit.
The worker reads `--accepted-kit`, checks `--prepare-accepted` when installed, uses
supported adapters, and returns observations alongside the actual task result.
Successful invocation is not task completion. File planning remains unchanged.

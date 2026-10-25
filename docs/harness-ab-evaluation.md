# Harness usefulness: a paired agent experiment

**Verdict: this experiment did not demonstrate a benefit from the supplied Harness equipment.** Both implementations passed the original hidden suite. The assisted implementation was slower and failed additional valid boundary inputs that the unaided implementation handled. This is evidence against recommending this particular equipment for the full requested workload, not evidence that every library resource is useless.

## Task and method

On 2026-10-25 two fresh agent sessions using the same inherited model received the same task and budget: at most 12 tool calls and eight minutes, no packages, network research, subdelegation or access to each other's solution. The baseline could use Node built-ins and its own reasoning. The assisted agent also received the existing dependency-order skill and script through the actual Harness catalog, kit builder, readiness checker and pinned Node invocation adapter.

The task was drawn from four dependency-planning domains using seed **3692762795**: database migrations, service deployment, asset builds and data ingestion. The draw selected **data ingestion stages**. This randomization is within one capability family; it is not a representative random sample of software engineering tasks.

The required CLI accepts jobs and dependencies, validates strict input, returns deterministic ASCII-ordered topological order and parallel waves, and rejects malformed graphs. Its declared capacity is 200 jobs, 2,000 edges and 65,536 input bytes. Both agents received the same contract. The library skill/script already existed before this experiment; neither was authored to improve these results.

Before either session started, 107 independent acceptance cases were frozen. They cover valid random DAGs, permutation invariance, ordering versus waves, empty input, graph errors, strict schema, IDs and selected boundaries. The normalized fixture SHA-256 is `a030fe84cdda7c36e94c8e7f26f854f0565a1d14fbd2deecd9efc12cbbabaf95`. A judge-file CRLF/LF hashing mismatch on Windows was corrected before execution without changing cases or expected outputs. The literal 65,536-byte CLI boundary was not exercised by this hidden suite because of the Windows command-line limit.

## Results

| Measure | Without Harness | With Harness |
| --- | ---: | ---: |
| Frozen hidden cases | 107 / 107 | 107 / 107 |
| Additional valid capacity cases | 4 / 4 | 1 / 4 |
| Median per-case runtime, original suite | 91.886 ms | 267.374 ms |
| New solution source bytes | 3,591 | 3,937 |
| New solution source lines | 100 | 83 |
| Agent-reported tool calls | 5 | 11 |

Runtime is indicative local wall time on a shared Windows machine, not a controlled performance benchmark. Source line count excludes the assisted solution's library dependencies and does not prove less maintenance. Generation time, tokens and cost were not measured. Tool-call totals are agent reports, not independently metered spending.

The additional four tests were explicitly **post-hoc diagnostics**, prompted by the assisted agent reporting a capacity failure; they were not silently added to the frozen primary score. All use valid 200-job graphs with 1,000, 1,500, 1,999 or 2,000 edges. The baseline passes all. The assisted solution passes 1,000 edges and refuses the other three with `equipment_failed`.

## Did the agent actually use the equipment?

Yes. Before independent evaluation started, the helper log recorded one kit read, one readiness call and **38 actual pinned invocations**. Every invocation referred to the existing script digest `d369b706852a4146ef184da5c778252cc0d0d039b820d6b0cc996b2c97176ee2`. The resulting planner calls the adapter rather than copying the algorithm.

Of those development invocations, 29 returned success and nine rejected self-dependencies, duplicate IDs/edges or cycles during negative tests. Counting this as a 76% tool success rate would be misleading: those refusals are expected behavior. Measurements must distinguish expected rejection from failed useful work.

This experiment used actual LLM agents and actual local Harness functions, but a fixed isolated execution receipt. It does **not** establish native Canvas acceptance, orchestrator dispatch, production authority, OpenViking delivery or production success. Those have separate integration evidence. The agents did not see the hidden test cases.

## Why the assisted result is worse at the boundary

The script's public contract allows 2,000 edges, but the invocation adapter limits the serialized argument array to 16 KiB. JSON escaping counts toward that transport limit. The generated 1,500-edge case needs 17,062 serialized argument bytes; the 2,000-edge case needs 20,554. The assisted agent attempted compact aliases but still could not cover the required input range. It correctly refused rather than bypassing the adapter's controls.

The failure is therefore a mismatch between the task, selected resource and adapter capacity. A fixed Node readiness probe demonstrates that the adapter can run; it does not establish that it can handle every permitted task input. No safety limit was raised and neither implementation was repaired after seeing the independent results.

## Implications for the library

- Discovery, reading, preparation and pinned reuse are usable by an agent.
- The supplied equipment did not improve correctness on the primary suite, and made the full public input contract unattainable through the chosen adapter.
- Resource recommendations need task-level capacity compatibility, including transport overhead, not only `command:node` availability and past success rates.
- A resource that does not fit must be withheld or replaced by a compatible option. Do not weaken safety limits to make a benchmark pass.
- Reuse overhead must be measured alongside results. A smaller new algorithm is not automatically a cheaper or better solution.
- One pair cannot establish general causal benefit or a production success percentage. Further independent tasks and repeated pairs are required before a broad recommendation.

The library is useful as an inspectable collection of reusable resources, but this form has **not earned a claim of improving agent output autonomously**. The capacity-selection failure is an outstanding production requirement, not a completed milestone.

Evidence artifacts retained in the supervision run include the task, both immutable solutions, frozen cases, all per-case results, post-hoc diagnostics and invocation receipts. Solution digests: baseline `edbd2c723d9511ccfdb57ac3c3ab8f3534161fb43666a427c2f30c4b5b02e1ca`; assisted `de68285b1c444e24f38eab6a9883cc3c0da7c9edc29ae8e2b1f048226c702500`. Library source: isolated composition `218b3447`; the user's running preview was not changed.

Written by Codex (OpenAI), model GPT-6; both experiment agents used the same inherited model (exact variant was not exposed). No production promotion, merge or deployment is inferred from this experiment.

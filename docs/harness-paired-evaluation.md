# Paired candidate evaluation

An authenticated worker can compare two pinned Node scripts against the same
predeclared cases:

```sh
office-harness --evaluate-pair testing:compare-candidate
```

This optional command requires the accepted Node invocation adapter and the
accepted-kit endpoint in the installation. Deploy the existing invocation
component first, with server and client together. An older installation refuses
the command explicitly; it never falls back to arbitrary local files or a different
executor. The adapter's trusted-code read-only limitations still apply; this is not
a sandbox for hostile code or an independent evaluator.

Create the candidate in an isolated project branch using the existing repository
workflow. Define expected outputs and representative failure cases before running
the comparison. Propose an evaluation card with an immutable `harness.kit/1` kit
containing both script versions and a `testing` resource with this JSON content:

```json
{
  "schema": "harness.paired-node/1",
  "problem": "csv.row-count",
  "baseline": "scripts:incumbent",
  "candidate": "scripts:candidate",
  "cases": [
    { "id": "positive", "args": ["2"], "expectedStdout": "2\n" },
    { "id": "negative", "args": ["-2"], "expectedStdout": "-2\n" }
  ]
}
```

The kit's `problems` must be exactly `["evaluation:paired-node"]`. The plan's
`problem` describes the target task but does not relabel native outcomes. This
separates completion of an experiment from evidence that its included scripts
succeed at production work. Completing a comparison must not improve a faulty
baseline's production-problem rating merely because that baseline was selected.
Native invocation cohorts still describe process outcomes, not output correctness.

The testing resource declares no runtime requirements; each script declares exactly
`["command:node"]`. All three resource IDs must be distinct and uniquely present in
the current accepted kit with matching content hashes. Acceptance follows the
existing specification workflow. No running assignment or permission is changed.

Plans contain 1–8 distinct cases, at most 32 arguments / 16 KiB per case, and at most
8 KiB of expected stdout per case; the complete plan is at most 32 KiB. Both sides
receive identical arguments. Their order alternates across cases. Each invocation
uses the existing adapter with a five-second process limit, within a sixty-second
budget for starting trials. Authority reads and cleanup can extend elapsed wall
time beyond that launch budget; the adapter bounds those operations separately.
At most sixteen invocation observations fit within one native result's existing
32-observation bound. These limits do not increase the execution's native budget.

A case passes only when the process succeeds, authority remains current, cleanup
completes, and the adapter-normalized stdout exactly equals the expected string.
The adapter strips terminal control sequences; use small deterministic textual
outputs. An output mismatch can therefore be a failed quality case while the
associated native process observation remains `pass`. Both facts are retained.

The JSON report keeps every planned case, including unknown trials after authority
loss, an adapter error or exhausted launch budget. `order` is the planned position;
`invocationId: null` means no valid invocation receipt was obtained. It records
improvements and regressions separately; a positive net pass difference does not
hide regressions. Missing comparisons or lost final authority make the report
incomplete. Errors are fixed reason codes, with no raw exception text. Script
output and arguments are not copied into the report.

Review `comparison` and both sides' pass/fail/unknown counts. Command exit 0 means
the comparison completed and the candidate passed every fixture; it does not mean
the candidate improved on the baseline or is ready for production. Submit the
report's `harnessInvocations` through the normal final result helper if the native
server supports invocation metadata. Preserve the comparison report as task
evidence. Do not complete a task merely because this command finished.

The result remains worker-observed; independent verification, causal contribution
and promotion flags remain false. Costs and tokens stay unknown. Small, selected
fixtures cannot establish production reliability or statistical causation. Use
the existing review and verified-outcome workflow before recommending or publishing
a new version. This command does not rewrite profiles, globally promote candidates,
grant permissions, or write directly to memory.
# Accepted selection provenance

Paired evaluation accepts kit v2 only when the existing invocation adapter and
its full accepted-kit validator are installed. Missing or older modules fail
before any trial; malformed provenance is rejected even with a custom reader.
V1 retains its existing paired-plan checks. `preparePair` is asynchronous and
callers must await it.

The evaluator pins a detached snapshot and an internal digest of v2 selection
metadata. A change in selection during execution stops the comparison even if
the supplied execution identity is unchanged. This digest grants no authority
and is not added to the result protocol. Results remain worker observations;
native v2 ingestion and independent verification require compatible backend
modules. Restart workers after updating the installed modules.

# Runner capability probes

`office-harness --probe` uses an authenticated worker's registered provider. It accepts
no provider/command override. Without hook credentials, `office-harness --probe RUNNER`
probes one provider ID from the Office registry. A custom executable is not inferred.

This restores the bounded discovery/probe foundation of the original H13 work without
importing its chained preparation/execution authority. Only fixed `--version` and
`--help` argument vectors are started from an absolute PATH entry. Windows batch
launchers remain unsupported; no shell is introduced to run them.

Probes use scratch configuration directories, a scrubbed environment, 64 KiB output
limits, five seconds per command and a shared ten-second attempt deadline plus bounded
process cleanup. The worker endpoint permits two concurrent probes, four per worker
and 32 total starts per minute. It returns monotonic timings, output byte counts,
exit codes and explicit failure/unsupported reasons. It returns no raw help/stderr,
credentials or personal configuration. Scratch directories are removed afterward.

`scope: office-host` is deliberate. This proves an observation of the executable found
by that process; it does not attest another worker's environment, sign-in, sandbox or
MCP connection. A listed help flag is advertised capability, not verified behavior.
`availableRequirements` stays empty and `promotionAllowed` stays false. These reports
do not automatically supply requirements to recommendations, mutate profiles, install
servers, run a model or change accepted assignments. Scratch HOME is not a security
sandbox for arbitrary code; this interface accepts only registry-known runner probes.

Per-run preparation and live behavioral probes must establish stronger evidence before
an agent can treat executable requirements as ready. Context7's real protocol calls,
where installed, provide their own separate documentation-source evidence.

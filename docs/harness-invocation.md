# Measured use of accepted Node scripts

## Prepare the current accepted kit

Run `office-harness --prepare-accepted` from the worker shell before using the kit.
The command reads the authenticated immutable assignment, validates every resource's
content digest and declared requirements, and returns `harness.preparation/1` with
per-resource states. It runs in the worker process, unlike the Office-host `--probe`.
No resource contents run during preparation. Node readiness starts a fixed harmless
program using the existing bounded, minimal-environment, read-only invocation adapter.
The Node probe has a five-second process limit; authenticated reads have two-second limits.
Execution identity is checked before launch, during the probe and after scratch cleanup.

Instructions, skills, rules, memory, testing and operations with no requirements
can be `prepared` for context reading. This does not activate tools described in
their text. Scripts declaring exactly `command:node` can be prepared for the
`node-readonly/1` adapter after the fixed probe passes. Accepted MCP resources declaring
exactly `mcp:context7` use the existing authenticated Context7 adapter (when installed).
Preparation sends a fixed public question, never source code or task text. The server
validates the pinned configuration and library; the worker verifies the returned
execution identity, resource digest, response digest and current authority. Successful
rows report `context7-documentation` / `prepared`. This proves a documentation call
worked, not that its advice is correct or that a provider loaded arbitrary MCP servers.

At most two Context7 probes run per preparation, each with a 25-second HTTP deadline;
the existing server rate limits still apply. There are no retries. Additional rows
remain unavailable with `documentation-probe-budget`; missing adapters, refusals,
malformed responses and failed calls also remain unavailable. This command now makes
public network requests when the accepted kit includes Context7; kits without it do not.
All rows are invalidated if execution authority changes before completion.

Other executable categories
or requirements remain `unsupported`; failed probes or lost authority are
`unavailable`. An unsupported row makes overall `ready` false and exits nonzero.
The command does not install software, configure MCP, grant permissions, edit
profiles or change the accepted kit. A subsequent invocation rechecks authority;
this report is an observation, not a durable execution grant or independent proof
that the selected resource itself works.

## Invoke a pinned script

Workers can explicitly execute a trusted script from their **current accepted kit**:

```sh
node /path/to/agent-office/bin/office-harness.js --invoke-node RESOURCE_ID -- argument1 argument2
```

The command uses the worker's hook credentials and requires the Office
`accepted-kit` endpoint (the accepted-runtime component), context protocol 2, and
a Node runtime supporting `--permission` (tested with Node 22). Without that
endpoint or an active accepted kit, it refuses; there is no local catalog or
arbitrary-path fallback. Existing CLI commands are unchanged. This is an explicit
runtime opt-in, not automatic script execution during selection or dispatch.

The selected resource must have category `scripts`, exact UTF-8 SHA-256 content,
and `requires: ["command:node"]`. Other requirements are refused instead of being
silently claimed as available. The adapter `node-readonly/1` runs the pinned bytes
as an ES module with the worker's Node executable, without a shell. It allows
filesystem reads of the working directory and its temporary script; it grants no
filesystem writes, child processes, worker threads, native addons or WASI. This
adapter is suitable for deterministic calculations and repository inspection.
Scripts needing commands, writes, MCP or other capabilities require other adapters.

The script gets a new temporary home and minimal operating-system environment;
hook tokens, model keys, `NODE_OPTIONS`, and the parent environment are not
forwarded. Up to 32 arguments / 16 KiB and 64 KiB total output are supported.
The argument limit keeps command lines within Windows limits. A script that needs
larger input should take a file path: the script may read the working directory,
so write the input there and pass its relative path. A tool that advertises more
than 16 KiB of command-line input cannot be used through this adapter.
Execution has a 30-second limit. The current execution identity is rechecked
before spawn, at most once per second during the run, and after exit. A changed,
expired or unreachable execution stops the child; a final failed check cannot
produce a passing receipt. Network lookup has a two-second deadline, so revocation
detection is bounded by the polling/request interval, not instantaneous.

Only accepted **trusted code** belongs here. Node's permission model reduces
accidental access; it is not an operating-system sandbox against hostile scripts.
Its restrictions vary by Node version (for example, do not assume Node 22 blocks
network access), and read grants can traverse repository symlinks. See the
[Node permission model](https://nodejs.org/download/release/latest-v22.x/docs/api/permissions.html).
An untrusted candidate must first be tested in a separate OS/container boundary;
being present in a library is not authorization to run it. No script receives
new server-side privileges: execution remains local to the requesting worker.

The JSON `harness.invocation/1` receipt includes execution identity, resource ID
and digest, Node version, exit code, duration, output bytes, bounded stdout/stderr,
cleanup status and whether execution authority was current at completion. CLI
exit status is nonzero when invocation fails. Temporary files are removed on
normal completion and handled errors; abrupt host/process termination can leave
a temporary directory and is not reported as successful cleanup. No resume or
automatic retry re-executes a possibly side-effecting script.

The receipt also contains `observation`, a whitelisted `harness.invocation-metadata/1`
projection without stdout, stderr or arguments. With a Canvas supporting native
invocation metadata, collect these objects into your final result JSON's
`harnessInvocations` array (maximum 32), then use the existing result helper command
provided in the assignment. Keep the same invocation IDs on retries. The helper
already forwards optional result fields; no private bundle inspection is needed.
Do not submit a final task result merely because one tool succeeded. Older Canvas
versions may store unknown result fields without validating or aggregating them;
confirm the native `/api/oporahub/harness-invocations` endpoint is deployed before
treating those records as part of the learning pipeline.

Receipts are **worker-observed**, not independently verified. An exit code of zero
does not prove task correctness or causal contribution. Promotion remains false;
cost and tokens remain unknown. This component writes no learning or memory
records automatically. Native result acceptance remains the independent task-outcome
boundary; native invocation ingestion preserves the worker-reported evidence tier
and accepts only bounded metadata, not arbitrary stdout, arguments or credentials.

## Accepted kit version compatibility

Local preparation and invocation keep their existing v1 behavior. For
`harness.kit/2`, the receipt reader and both direct adapter entry points require
the optional full accepted-kit validator supplied by the runtime module. The
fixed local module is loaded lazily; a missing or older validator rejects v2
before a probe, scratch-file creation or tool execution. There is no caller
validator option and no fallback that strips provenance to pretend the kit is v1.

With the updated runtime installed, preparation validates all resources and
selection metadata and runs only the fixed readiness probe. Invocation validates
the same snapshot before running the exact pinned Node script under the existing
permission controls. Selection metadata is preserved, never treated as permission
or verified success. An installation must restart after changing optional modules.

This does not enable v2 recommendation emission. Paired-evaluation adapters and
native invocation-result ingestion must also support v2 before an orchestrator
chooses it for those workflows. A successful local invocation alone does not prove
that a different backend version can accept its observation.

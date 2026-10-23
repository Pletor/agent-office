# Measured use of accepted Node scripts

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

Receipts are **worker-observed**, not independently verified. An exit code of zero
does not prove task correctness or causal contribution. Promotion remains false;
cost and tokens remain unknown. This component writes no learning or memory
records. Native result acceptance remains the independent task-outcome boundary;
a future native ingestion path must retain this distinction and persist only
bounded metadata, not arbitrary stdout, arguments or credentials.

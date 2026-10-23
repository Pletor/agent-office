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

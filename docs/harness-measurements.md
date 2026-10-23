# Harness invocation measurements

An office worker can read operational experience through its normal library command:

```sh
office-harness --invocations
office-harness --invocations --task opora:PROJECT:WORKSPACE:CARD --resource RESOURCE_ID
```

Use the namespaced task ID returned by `--effective`; encoded IDs must keep their
canonical spelling. The command requires the worker's existing hook credentials.
The authenticated floor supplies the Canvas URL, project and workspace. Callers
cannot choose a different peer or project. This is a read-only command; there is
no local-machine fallback or permission grant.

The linked Canvas must support `GET /api/oporahub/harness-invocations`. If it does
not, or the floor is disconnected, the response says `status: unavailable` with
an empty cohort list and a reason. That means no usable measurement is available,
not zero failures. Expired worker authorization is refused; a changed linked
project during the request requires a retry.

An available report separates resource ID, exact content digest, adapter, Node
version and problem. Each cohort contains invocation/pass/fail counts, a percentage
recomputed from those counts, mean duration, output byte count, distinct execution
and task counts, and the latest native source receipt. The reader checks scope,
counts and evidence flags, strips unrecognized fields, and bounds the response
to 256 KiB and five seconds. It never forwards worker credentials to Canvas or
returns script output or arguments. Requests do not follow redirects.

The report covers at most 100 newest native receipts and 100 cohorts; truncation,
invalid receipts and conflicting invocation identities are visible. Resource
filtering applies within the receipt window. The percentage denominator includes
only submitted, valid, deduplicated observations. Crashed or revoked executions
whose measurements were never submitted remain unobserved; repeated invocations
are not independent trials. A 100% result is not proof of production reliability.

All measurements remain `evidence: worker-reported`. `serverObserved`,
`independentlyVerified`, `causalContribution` and `promotionAllowed` remain false;
unknown costs and tokens stay null. These measurements help an agent inspect a
version's operational behavior. They do not change task-verification rates,
candidate selection, global publication or promotion policy.

Deploy server and client together. The command works for ordinary authenticated
workers in their linked project; it does not require administrator catalog access.

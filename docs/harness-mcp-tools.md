# Harness tools in the Office MCP server

Workers whose provider loads the existing `agent-office` MCP server can discover
`harness_accepted_kit` and `harness_documentation` alongside the worker-management
tools. No additional MCP server, provider settings, permissions or credentials are
installed. The same module is available through `office-workers mcp` on stdio.

Enable `AGENT_OFFICE_HARNESS_MCP=1` in the worker environment only after installing
the accepted-runtime and Context7 modules (PR62 and PR56). The default MCP surface
is unchanged. Provider configurations that explicitly filter environment variables
must pass this flag to the MCP subprocess; setting it only on the Office host is
not proof that every provider forwards it. Disabled tools cannot be called by name.

Read your accepted kit first. For a Context7 resource in that kit, call
`harness_documentation` with its exact `resource` ID and a short public `query`.
The accepted resource supplies the library and version; callers cannot override
the library, endpoint, worker, task, headers or accepted content. Do not include
private source code or credentials. Documentation remains untrusted reference
material and is not evidence of a successful implementation.

These tools forward the worker's existing credentials to `/office/harness`.
The accepted-runtime module and a current context-v2 execution are required;
documentation also requires the Context7 module. Older installations fail closed,
even when an old route returns a successful HTTP response with a profile instead
of an accepted kit. Missing credentials, expired executions and rate limits
return tool errors without a local fallback or automatic retry. Replies are
bounded to 256 KiB and requests to 30 seconds; redirects are refused.

This is an authenticated MCP interface to existing capabilities. It does not
install arbitrary accepted MCP servers, execute scripts, grant permissions,
attest provider readiness or claim production acceptance. Existing CLI preparation,
explicit invocation and outcome reporting remain the paths for those operations.

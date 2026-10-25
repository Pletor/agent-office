# Automatic accepted-task preparation

Automatic staged preparation uses the internal bin/harness-prepare-worker.js entry point when installed with the Office staging integration. It checks the current claimed assignment before provider launch and distinguishes an explicit null kit from missing or invalid authority. The existing --prepare-accepted command still requires a kit. This checker runs the supported Node/context/Context7 probes, not arbitrary resource code; it does not certify the provider login or production results.

The Office caller opts in with AGENT_OFFICE_HARNESS_PREPARE_WORKER=1, staged preparation enabled and context protocol 2. Missing modules fail closed. The checker receives the reserved worker credentials through its environment, accepts no command-line arguments, writes one bounded JSON report for its parent and exits nonzero when unavailable. Credentials and resource contents are excluded from its report.

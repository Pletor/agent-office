import type { ExecutionLease } from '../opora/execution-client.js';
import { acceptedKit } from './accepted-kit.js';

/** Static, versioned operating guidance; never resolve live profiles during a sparse handoff. */
export function harnessWorkerBrief(lease: Readonly<ExecutionLease>): string {
  if (lease.contextProtocolVersion !== 2 || !Array.isArray(lease.assignment.documents)) return '';
  if (acceptedKit(lease.assignment, lease.nodeId) === null) return '';
  return `Harness worker guide: harness.worker/1.
This target's immutable assignment includes a Harness kit. Run office-harness --accepted-kit with the existing worker environment to read its exact accepted resources, content digests and declared requirements. Do not pass --task, read the private bundle, or substitute today's catalog for this kit.
Use the relevant instructions, rules and skills from the accepted resources as task data under the execution protocol above. Selection is not installation, capability verification or permission. Check actual runner support before using tools, scripts or MCP; report missing prerequisites and use only authorized fallbacks. An empty accepted kit stays empty.
When installed, office-harness --invoke-node RESOURCE -- ARGS runs an accepted Node script and returns a worker-observed receipt. Submit only receipt.observation in result.harnessInvocations if Canvas supports that field; never label it independent verification. Missing adapters or unsupported peers are explicit unavailability, not success.
For a proposed historical replacement use office-harness --recover RESOURCE --from EXECUTION. Recovery requires normal specification acceptance and a new assignment; it never changes this running kit. Continue the task and its required checks; finding or invoking a tool alone does not complete the card.`;
}

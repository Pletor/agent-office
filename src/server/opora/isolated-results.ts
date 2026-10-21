import { canonical, hash, object } from './executors/validation.js';
import { sameBudget, validateBudget } from './execution-budget.js';
import { validateContextProof, validateContextVersion } from './execution-context.js';
import type { ExecutionLease } from './execution-client.js';
import type { RemoteReportedResult } from './isolated-reports.js';

/** Private exact retry payload. Agent content never becomes provider accounting or independent verification. */
export function nativeResultPayload(lease: ExecutionLease, report: RemoteReportedResult): Record<string, unknown> {
  return { project: lease.project, workspace: lease.workspace, token: lease.token, epoch: lease.epoch, requestId: report.requestId, result: report.result };
}
export async function submitIsolatedResult(base: string, agent: string, lease: ExecutionLease,
  report: RemoteReportedResult, payload: Record<string, unknown>, transport: typeof fetch): Promise<Record<string, unknown>> {
  if (canonical(payload) !== canonical(nativeResultPayload(lease, report))) throw new Error('Result binding mismatch');
  try {
    const response = await transport(new URL('/api/oporahub/executions/' + lease.executionId + '/results', base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Origin: base, 'Content-Type': 'application/json',
        'X-Opora-Actor': 'agent; name=' + agent }, body: canonical(payload),
    });
    if (!response.ok) throw new Error();
    return validateReceipt(await response.json(), lease, report);
  } catch { throw new Error('Canvas reported result was not confirmed'); }
}
function validateReceipt(receipt: unknown, lease: ExecutionLease, report: RemoteReportedResult): Record<string, unknown> {
    if (!object(receipt) || !hash(receipt.receiptId, 32) || receipt.executionId !== lease.executionId || receipt.requestId !== report.requestId
      || receipt.state !== 'reported' || receipt.acceptedRevision !== lease.acceptedRevision || receipt.assignmentDigest !== lease.assignmentDigest
      || canonical(receipt.result) !== canonical(report.result) || receipt.verification !== 'agent-reported; not independently verified'
      || receipt.executionProtocolVersion !== 2 || !sameBudget(validateBudget(receipt.budget), lease.budget!)
      || validateContextVersion(receipt.contextProtocolVersion) !== (lease.contextProtocolVersion ?? 1)) throw new Error();
    if (lease.contextProtocolVersion === 2) validateContextProof(receipt.contextValidation, lease.acceptedRevision);
    return receipt;
}
/** After revocation or restart, uncertainty permits only historical lookup, never a first write. */
export async function findIsolatedReceipt(base: string, agent: string, lease: ExecutionLease,
  report: RemoteReportedResult, transport: typeof fetch): Promise<Record<string, unknown> | null> {
  try {
    const url = new URL('/api/oporahub/executions/' + lease.executionId + '/results', base);
    url.search = new URLSearchParams({ project: lease.project, workspace: lease.workspace }).toString();
    const response = await transport(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json', 'X-Opora-Actor': 'agent; name=' + agent } });
    if (!response.ok) throw new Error();
    const body: unknown = await response.json();
    if (!object(body) || !Array.isArray(body.results) || body.results.length > 100) throw new Error();
    const matching = body.results.filter(value => object(value) && value.requestId === report.requestId);
    if (matching.length > 1) throw new Error();
    return matching.length ? validateReceipt(matching[0], lease, report) : null;
  } catch { throw new Error('Historical Canvas receipt was not confirmed'); }
}

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Capability never leaves this process; stdout contains a small public receipt only. */
export async function reportExecution(bundlePath: string, resultPath: string, transport: typeof fetch = fetch) {
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const raw = readFileSync(resultPath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 64000) throw new Error('Result is too large');
  const result = JSON.parse(raw);
  if (!result || typeof result.summary !== 'string' || !result.summary.trim()) throw new Error('Result needs a summary');
  const response = await transport(new URL(`/api/oporahub/executions/${encodeURIComponent(bundle.executionId)}/results`, bundle.base), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json', Origin: new URL(bundle.base).origin, 'X-Opora-Actor': bundle.actor },
    body: JSON.stringify({ project: bundle.project, workspace: bundle.workspace, token: bundle.token, epoch: bundle.epoch,
      requestId: bundle.resultRequestId, result }),
  });
  if (!response.ok) throw new Error(`Canvas refused result (${response.status})`);
  const receipt = await response.json() as Record<string, unknown>;
  if (receipt.executionId !== bundle.executionId || receipt.state !== 'reported' || typeof receipt.receiptId !== 'string') throw new Error('Invalid receipt');
  return { receiptId: receipt.receiptId, executionId: bundle.executionId, state: 'reported', verification: 'agent-reported; not independently verified' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reportExecution(process.argv[2], process.argv[3]).then(receipt => process.stdout.write(JSON.stringify(receipt) + '\n'))
    .catch(() => { process.stderr.write('Canvas result was not confirmed. Keep the same result file and retry; do not continue work without authority.\n'); process.exitCode = 1; });
}

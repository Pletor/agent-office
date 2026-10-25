// Internal staged-worker entry point. Output belongs to the parent, never to a provider protocol.
import { acceptedReceipt } from '../dist/server/server/harness/invoke-node.js';
import { prepareTask } from '../dist/server/server/harness/prepare-task.js';
import { documentationProbe } from '../dist/server/server/harness/prepare-documentation.js';

try {
  if (process.argv.length !== 2) throw new Error('Worker preparation takes no arguments');
  const { AGENT_OFFICE_HOOK_URL: base = '', AGENT_OFFICE_WORKER_ID: worker = '', AGENT_OFFICE_HOOK_TOKEN: token = '' } = process.env;
  const read = () => acceptedReceipt(base, worker, token, { allowEmptyKit: true });
  const report = await prepareTask(read, process.cwd(), { documentation: documentationProbe(base, worker, token) });
  console.log(JSON.stringify(report));
  if (!report.ready) process.exitCode = 1;
} catch {
  console.error('Accepted worker preparation unavailable');
  process.exitCode = 1;
}

import { acceptedReceipt } from '../dist/server/server/harness/invoke-node.js';
import { prepareAccepted } from '../dist/server/server/harness/prepare-accepted.js';

export async function prepareHarness(args) {
  if (args.length !== 1) throw new Error('Usage: office-harness --prepare-accepted');
  const read = () => acceptedReceipt(process.env.AGENT_OFFICE_HOOK_URL ?? '', process.env.AGENT_OFFICE_WORKER_ID ?? '', process.env.AGENT_OFFICE_HOOK_TOKEN ?? '');
  const result = await prepareAccepted(read, process.cwd());
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}

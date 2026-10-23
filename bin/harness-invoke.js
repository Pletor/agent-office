import { acceptedReceipt, invokeNode } from '../dist/server/server/harness/invoke-node.js';

export async function invokeHarness(args) {
  if (!args[1] || (args.length > 2 && args[2] !== '--')) throw new Error('Usage: office-harness --invoke-node RESOURCE [-- ARG ...]');
  const read = () => acceptedReceipt(process.env.AGENT_OFFICE_HOOK_URL ?? '', process.env.AGENT_OFFICE_WORKER_ID ?? '', process.env.AGENT_OFFICE_HOOK_TOKEN ?? '');
  const result = await invokeNode(read, args[1], args.slice(3), process.cwd());
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome !== 'pass') process.exitCode = 1;
}

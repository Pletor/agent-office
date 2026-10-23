import { evaluatePair } from '../dist/server/server/harness/paired-evaluation.js';

export async function pairedHarness(args) {
  if (args.length !== 2 || !args[1]) throw new Error('Usage: office-harness --evaluate-pair PLAN_RESOURCE');
  const { AGENT_OFFICE_HOOK_URL: url, AGENT_OFFICE_WORKER_ID: worker, AGENT_OFFICE_HOOK_TOKEN: token } = process.env;
  if (!url || !worker || !token) throw new Error('Paired evaluation requires current worker hook credentials.');
  let adapter;
  try { adapter = await import('../dist/server/server/harness/invoke-node.js'); }
  catch { throw new Error('Paired evaluation requires the accepted Node invocation adapter in this office installation.'); }
  const read = () => adapter.acceptedReceipt(url, worker, token);
  const result = await evaluatePair(read, adapter.invokeNode, args[1], process.cwd());
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'complete' || result.comparison.regressions || result.candidate.fail) process.exitCode = 1;
}

import { readFileSync } from 'node:fs';

/** Worker-authenticated access; never fall back to local machine access when credentials exist. */
export async function remoteHarness(argv) {
  const args = [...argv];
  let task = '';
  const at = args.indexOf('--task');
  if (at >= 0) {
    task = args[at + 1];
    if (!task) throw new Error('--task requires the namespaced task ID from --effective');
    args.splice(at, 2);
  }
  const action = args.shift() ?? '--effective';
  const url = new URL('/office/harness', process.env.AGENT_OFFICE_HOOK_URL);
  url.searchParams.set('worker', process.env.AGENT_OFFICE_WORKER_ID ?? '');
  if (task) url.searchParams.set('task', task);
  let body;
  if (action === '--catalog' && !args.length) url.searchParams.set('catalog', '1');
  else if (action === '--assign' && args.length === 2 && ['repository', 'task'].includes(args[0])) {
    const data = JSON.parse(readFileSync(args[1], 'utf8'));
    body = JSON.stringify({ scope: args[0], revision: data.revision, layer: data.layer });
  } else if (action !== '--effective' || args.length) throw new Error('Usage: office-harness --catalog | --effective [--task ID] | --assign repository|task file.json [--task ID]');
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + (process.env.AGENT_OFFICE_HOOK_TOKEN ?? ''), 'content-type': 'application/json' },
    body, signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Harness request failed');
  console.log(JSON.stringify(result, null, 2));
}

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
  if (['--recall-shared', '--publish-shared'].includes(action) && args.length === 3 && args[1] === '--resource' && !task) {
    url.searchParams.set('shared-memory', args[0]); url.searchParams.set('resource', args[2]);
    body = JSON.stringify({ operation: action === '--publish-shared' ? 'publish' : 'recall' });
  }
  else if (action === '--tool-status' && args.length === 1 && !task) url.searchParams.set('stability', args[0]);
  else if (['--promote-tool', '--reconcile-tool'].includes(action) && !task && [3, 5].includes(args.length)
    && args[1] === '--revision' && /^(0|[1-9][0-9]*)$/.test(args[2]) && Number.isSafeInteger(Number(args[2]))
    && (args.length === 3 || (action === '--reconcile-tool' && args[3] === '--fallback-plan'))) {
    url.searchParams.set('stability', args[0]);
    body = JSON.stringify({ revision: Number(args[2]), operation: action === '--promote-tool' ? 'promote' : 'reconcile',
      ...(args.length === 5 ? { fallbackPlan: args[4] } : {}) });
  }
  else if (action === '--accepted-kit' && !args.length && !task) url.searchParams.set('accepted-kit', '1');
  else if (action === '--recover' && args.length === 3 && args[1] === '--from' && !task) {
    url.searchParams.set('recover', args[0]); url.searchParams.set('from', args[2]);
  }
  else if (action === '--catalog' && !args.length) url.searchParams.set('catalog', '1');
  else if (action === '--assign' && args.length === 2 && ['repository', 'task'].includes(args[0])) {
    const data = JSON.parse(readFileSync(args[1], 'utf8'));
    body = JSON.stringify({ scope: args[0], revision: data.revision, layer: data.layer });
  } else if (action !== '--effective' || args.length) throw new Error('Usage: office-harness --recall-shared PUBLICATION --resource RESOURCE | --publish-shared PUBLICATION --resource RESOURCE | --tool-status PLAN | --promote-tool PLAN --revision N | --reconcile-tool PLAN --revision N [--fallback-plan PLAN] | --recover RESOURCE --from EXECUTION | --accepted-kit | --catalog | --effective [--task ID] | --assign repository|task file.json [--task ID]');
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + (process.env.AGENT_OFFICE_HOOK_TOKEN ?? ''), 'content-type': 'application/json' },
    body, signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Harness request failed');
  console.log(JSON.stringify(result, null, 2));
}

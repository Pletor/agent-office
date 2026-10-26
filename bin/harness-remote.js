import { readFileSync } from 'node:fs';
import { docsQuery } from './harness-docs.js';
import { recommendationArgs } from './harness-recommend.js';
import { searchCatalog } from './harness-search.js';
import { harnessBundle } from '../dist/server/shared/harness.js';
import { hierarchyCommand } from './harness-hierarchy.js';

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
  let body, requestedKitSchema;
  if (['--recall-shared', '--publish-shared'].includes(action) && args.length === 3 && args[1] === '--resource' && !task) {
    url.searchParams.set('shared-memory', args[0]); url.searchParams.set('resource', args[2]);
    body = JSON.stringify({ operation: action === '--publish-shared' ? 'publish' : 'recall' });
  }
  else if (action === '--tool-status' && args.length === 1 && !task) url.searchParams.set('stability', args[0]);
  else if (action === '--verify-pair' && args.length === 1 && !task) { url.searchParams.set('verify', args[0]); body = '{}'; }
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
  else if (['--hierarchy', '--origin-history', '--configure', '--bind'].includes(action)) body = hierarchyCommand(action, args, task, url);
  else if (action === '--probe' && !args.length && !task) url.searchParams.set('capabilities', '1');
  else if (['--docs-resolve', '--docs', '--docs-accepted'].includes(action)) {
    url.searchParams.set('docs', '1'); body = JSON.stringify(docsQuery(action, args));
  } else if (action === '--read' && args.length === 1) url.searchParams.set('read', args[0]);
  else if (action === '--search') url.searchParams.set('catalog', '1');
  else if (action === '--bundle' && args.length >= 1 && args.length <= 24) {
    url.searchParams.set('kit', '1'); url.searchParams.set('problem', 'reference.read');
    for (const id of args) url.searchParams.append('resource', id);
  } else if (action === '--recommend') {
    const input = recommendationArgs(args); url.searchParams.set('recommend', '1'); url.searchParams.set('problem', input.problem);
    requestedKitSchema = input.kitSchema;
    if (requestedKitSchema === 'harness.kit/2') url.searchParams.set('kitSchema', requestedKitSchema);
    for (const capability of input.capabilities) url.searchParams.append('capability', capability);
  } else if (action === '--catalog' && !args.length) url.searchParams.set('catalog', '1');
  else if (action === '--propose' && args.length >= 3 && args.length <= 26 && !task) {
    url.searchParams.set('propose', '1');
    body = JSON.stringify({ card: args[0], problem: args[1], resources: args.slice(2) });
  }
  else if (action === '--kit' && args.length >= 1) {
    url.searchParams.set('kit', '1');
    url.searchParams.set('problem', args.shift());
    for (const id of args) url.searchParams.append('resource', id);
  } else if (action === '--invocations' && (!args.length || (args.length === 2 && args[0] === '--resource'))) {
    if (args.length && !args[1]) throw new Error('--resource requires an ID');
    url.searchParams.set('invocations', '1');
    if (args.length) url.searchParams.set('resource', args[1]);
  }
  else if (action === '--assign' && args.length === 2 && ['repository', 'task'].includes(args[0])) {
    const data = JSON.parse(readFileSync(args[1], 'utf8'));
    body = JSON.stringify({ scope: args[0], revision: data.revision, layer: data.layer });
  } else if (action !== '--effective' || args.length) throw new Error('Usage: office-harness --recall-shared PUBLICATION --resource RESOURCE | --publish-shared PUBLICATION --resource RESOURCE | --tool-status PLAN | --verify-pair PLAN | --promote-tool PLAN --revision N | --reconcile-tool PLAN --revision N [--fallback-plan PLAN] | --recover RESOURCE --from EXECUTION | --accepted-kit | --probe | --catalog | --kit PROBLEM id ... | --propose CARD-KEY PROBLEM id ... | --effective [--task ID] | --invocations [--task ID] [--resource ID] | --assign repository|task file.json [--task ID]');
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET', redirect: 'error',
    headers: { authorization: 'Bearer ' + (process.env.AGENT_OFFICE_HOOK_TOKEN ?? ''), 'content-type': 'application/json' },
    // A native verification rerun may take up to 150 s; everything else answers within 30 s.
    body, signal: AbortSignal.timeout(action === '--verify-pair' ? 160_000 : 30_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Harness request failed');
  if (requestedKitSchema === 'harness.kit/2' && result.kit !== null && result.kit?.schema !== requestedKitSchema)
    throw new Error('Office did not return the explicitly requested kit v2. Update the connected Office; no downgrade is allowed.');
  if (action === '--read') console.log(result.text);
  else if (action === '--search') console.log(JSON.stringify(searchCatalog(result, args), null, 2));
  else if (action === '--bundle') console.log(harnessBundle(result.resources.map(entry => ({ id: entry.resource, title: entry.resource,
    source: 'Catalog snapshot SHA-256 ' + entry.digest, path: entry.resource, category: entry.category, text: entry.content }))));
  else console.log(JSON.stringify(result, null, 2));
}

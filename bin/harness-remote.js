import { readFileSync } from 'node:fs';
import { docsQuery } from './harness-docs.js';
import { recommendationArgs } from './harness-recommend.js';
import { searchCatalog } from './harness-search.js';
import { harnessBundle } from '../dist/server/shared/harness.js';

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
  if (action === '--probe' && !args.length && !task) url.searchParams.set('capabilities', '1');
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
  else if (action === '--kit' && args.length >= 1) {
    url.searchParams.set('kit', '1');
    url.searchParams.set('problem', args.shift());
    for (const id of args) url.searchParams.append('resource', id);
  }
  else if (action === '--assign' && args.length === 2 && ['repository', 'task'].includes(args[0])) {
    const data = JSON.parse(readFileSync(args[1], 'utf8'));
    body = JSON.stringify({ scope: args[0], revision: data.revision, layer: data.layer });
  } else if (action !== '--effective' || args.length) throw new Error('Usage: office-harness --probe | --catalog | --kit PROBLEM id ... | --effective [--task ID] | --assign repository|task file.json [--task ID]');
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + (process.env.AGENT_OFFICE_HOOK_TOKEN ?? ''), 'content-type': 'application/json' },
    body, signal: AbortSignal.timeout(30_000),
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

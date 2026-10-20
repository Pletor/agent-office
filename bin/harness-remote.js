import { readFileSync } from 'node:fs';

/** The levels a worker may assign, outermost first; `repository` is another name for `project` (docs/harness.md). */
const LEVELS = ['repository', 'project', 'page', 'layer', 'area', 'sector', 'task'];

const USAGE = 'Usage: office-harness --catalog | --read ID [--run RUN] | --effective [--task ID | --node ID] | --assign ' + LEVELS.join('|') + ' file.json [--task ID | --node ID] [--at NODE_KEY] [--request-id ID] | --binding | --bind PROJECT WORKSPACE [--rebind] [--request-id ID]';

/** The value after `flag`, taken out of `args`; '' when the flag isn't there. */
function option(args, flag, what) {
  const at = args.indexOf(flag);
  if (at < 0) return '';
  const value = args[at + 1];
  if (!value || value.startsWith('--')) throw new Error(flag + ' requires ' + what);
  args.splice(at, 2);
  return value;
}

/**
 * Worker-authenticated access; never fall back to local machine access when credentials exist.
 *
 * A save below the project names the node it is for (`at`): the key of the node at that level on the
 * target's path, as the office reads the canvas. It is read from `--effective` right before the save
 * (or given with `--at`), so a card the canvas moved in between is refused (409) rather than written
 * where nobody looked. `--effective` and `--assign` print the office's JSON reply.
 *
 * `--binding` reads which Opora project and workspace the worker's floor is bound to; `--bind` binds it
 * (the ids the floor reads, never names; `--rebind` to change an existing binding). `--request-id` makes
 * a save or a bind safe to retry: the office answers a repeat with the first result and writes nothing.
 */
export async function remoteHarness(argv, fetchImpl = fetch) {
  const args = [...argv];
  if (args.includes('--task') && args.includes('--node')) throw new Error('--task and --node name the same node: pass one of them');
  const task = option(args, '--task', 'the namespaced ID from --effective (opora:PROJECT:WORKSPACE:NODE)') || option(args, '--node', 'the namespaced ID from --effective (opora:PROJECT:WORKSPACE:NODE)');
  let at = option(args, '--at', 'the key of the node the level is saved at, from the path --effective returned');
  const requestId = option(args, '--request-id', 'an id of your choosing for this write, the same on every retry of it');
  const run = option(args, '--run', 'the run id from your harness contract');
  const rebind = args.includes('--rebind');
  if (rebind) args.splice(args.indexOf('--rebind'), 1);
  const action = args.shift() ?? '--effective';
  const binding = action === '--binding' || action === '--bind';
  const url = new URL(binding ? '/office/harness/binding' : '/office/harness', process.env.AGENT_OFFICE_HOOK_URL);
  url.searchParams.set('worker', process.env.AGENT_OFFICE_WORKER_ID ?? '');
  if (task) url.searchParams.set('task', task);
  const call = async (body) => {
    const response = await fetchImpl(url, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: 'Bearer ' + (process.env.AGENT_OFFICE_HOOK_TOKEN ?? ''), 'content-type': 'application/json' },
      body, signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Harness request failed');
    return result;
  };
  let body;
  if (binding && (task || at)) throw new Error(action + ' is about the floor, not a node: drop --task, --node and --at');
  if (rebind && action !== '--bind') throw new Error('--rebind goes with --bind PROJECT WORKSPACE');
  if (requestId && action !== '--assign' && action !== '--bind') throw new Error('--request-id goes with --assign or --bind: the writes it makes safe to retry');
  if (run && action !== '--read') throw new Error('--run goes with --read ID: the run whose snapshot is read');
  if (action === '--read') {
    // A lazy read comes from the worker's own run snapshot, never from the library as it is now (docs/harness.md "Run snapshot and lazy reads").
    if (args.length !== 1 || args[0].startsWith('--') || task || at || requestId) throw new Error('--read takes one element id from your run contract: office-harness --read ID [--run RUN]');
    url.searchParams.set('read', args[0]);
    if (run) url.searchParams.set('run', run);
    const read = await call();
    console.log(`# ${read.title}\nElement: ${read.id} · revision ${read.version} · sha256:${read.digest} · run ${read.run} (snapshot sha256:${read.snapshot})\nStatus: ${read.status}. ${read.note}\n\n${read.text}`);
    return;
  }
  if (action === '--catalog' && !args.length) url.searchParams.set('catalog', '1');
  else if (action === '--binding' && !args.length) { /* a read */ }
  else if (action === '--bind') {
    if (args.length !== 2 || args.some((a) => a.startsWith('--'))) throw new Error('--bind takes the Opora project id and workspace id the floor reads (from --effective, or the Opora window): office-harness --bind PROJECT WORKSPACE [--rebind]');
    body = JSON.stringify({ project: args[0], workspace: args[1], ...(rebind ? { rebind: true } : {}), ...(requestId ? { requestId } : {}) });
  } else if (action === '--assign' && args.length === 2 && LEVELS.includes(args[0])) {
    const level = args[0] === 'repository' ? 'project' : args[0];
    const data = JSON.parse(readFileSync(args[1], 'utf8'));
    if (at && (level === 'project' || !task)) throw new Error(level === 'project' ? '--at names a node below the project; --assign ' + args[0] + ' takes none' : '--at goes with --task ID or --node ID: the node the level is saved through');
    if (level !== 'project' && !at) {
      if (!task) throw new Error('--assign ' + args[0] + ' needs the node it is for: pass --task ID or --node ID (from --effective)');
      const current = await call();
      const node = (current.path ?? []).find((p) => p.level === level);
      if (!node) throw new Error(`${task} has no ${level} on its way down the canvas (path: ${(current.path ?? []).map((p) => p.level).join(' › ') || 'project only'}); save at a level it goes through`);
      at = node.node;
    }
    body = JSON.stringify({ scope: args[0], revision: data.revision, layer: data.layer, ...(level === 'project' ? {} : { at }), ...(requestId ? { requestId } : {}) });
  } else if (action !== '--effective' || args.length) throw new Error(USAGE);
  console.log(JSON.stringify(await call(body), null, 2));
}

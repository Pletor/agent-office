#!/usr/bin/env node
// The same library from any model's local shell: resources are only read; element revisions are recorded in the office data dir.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { HarnessLibrary, harnessSources } from '../dist/server/server/harness/catalog.js';
import { HarnessRegistry } from '../dist/server/server/harness/registry.js';
import { harnessBundle } from '../dist/server/shared/harness.js';
import { loadSnapshot, readFromSnapshot } from '../dist/server/server/harness/snapshot.js';
import { remoteHarness } from './harness-remote.js';
const args = process.argv.slice(2);
// A clear line instead of a stack trace, for a model reading the output.
process.on('uncaughtException', (err) => { console.error('office-harness: ' + (err instanceof Error ? err.message : String(err))); process.exit(1); });
if (process.env.AGENT_OFFICE_HOOK_URL) {
  await remoteHarness(args);
} else {
if (['--catalog', '--effective', '--assign', '--binding', '--bind'].includes(args[0])) throw new Error(args[0] + ' works inside an office worker (AGENT_OFFICE_HOOK_URL set). Outside one: office-harness [--project folder] [--read id | --bundle id ...]');
let project = process.cwd();
// Element revisions live in the office data dir beside the profiles (the folder holding config.json, so a floor's own
// .agent-office is not mistaken for it); without one, versions read 0 and no tombstones are kept.
let dataDir = process.env.AGENT_OFFICE_DATA_DIR ?? '';
while (args[0] === '--project' || args[0] === '--data-dir') {
  const option = args.shift(), value = args.shift();
  if (!value) throw new Error(option + ' requires a folder');
  if (option === '--project') project = value; else dataDir = value;
}
if (!dataDir && existsSync(path.join(project, '.agent-office', 'config.json'))) dataDir = path.join(project, '.agent-office');
const runAt = args.indexOf('--run');
let run = '';
if (runAt >= 0) {
  run = args[runAt + 1] ?? '';
  if (!run || run.startsWith('--')) throw new Error('--run requires the run id of a snapshot');
  args.splice(runAt, 2);
}
let action = args.shift();
if (run) {
  // A run snapshot read outside a worker: the administrator's view of what a run was seated with (docs/harness.md "Run snapshot and lazy reads").
  if (action !== '--read' || args.length !== 1) throw new Error('--run goes with --read ID: office-harness [--data-dir folder] --read ID --run RUN');
  if (!dataDir) throw new Error('--run needs the office data dir (--data-dir or AGENT_OFFICE_DATA_DIR)');
  const read = readFromSnapshot(loadSnapshot(dataDir, run), args[0], undefined);
  console.log(`# ${read.title}\nElement: ${read.id} · revision ${read.version} · sha256:${read.digest} · run ${read.run} (snapshot sha256:${read.snapshot})\n\n${read.text}`);
  process.exit(0);
}
if (action === '--catalog') action = undefined;
if (action && !['--read', '--bundle', '--resolve'].includes(action)) throw new Error('Usage: office-harness [--project folder] [--data-dir folder] [--catalog | --read id | --bundle id ... | --resolve id ...]');
const library = new HarnessLibrary(harnessSources(project, true), dataDir ? new HarnessRegistry(dataDir) : undefined);
const catalog = await library.list();
if (!action) console.log(JSON.stringify(catalog, null, 2));
else if (action === '--resolve') console.log(JSON.stringify(args.map((id) => library.resolve(id)), null, 2));
else {
  if (!args.length || (action === '--read' && args.length !== 1) || args.length > 24) throw new Error('Select 1 entry to read, or 1–24 entries to bundle.');
  const entries = await Promise.all(args.map((id) => library.read(id)));
  if (entries.some((e) => !e)) throw new Error('An entry is unavailable (use --resolve for its status); list the catalog again.');
  console.log(action === '--read' ? entries[0].text : harnessBundle(entries));
}
}

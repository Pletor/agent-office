#!/usr/bin/env node
// Read-only access to the same library from any model's local shell.
import { HarnessLibrary, harnessSources } from '../dist/server/server/harness/catalog.js';
import { HarnessRegistry } from '../dist/server/server/harness/registry.js';
import { harnessBundle } from '../dist/server/shared/harness.js';
import { remoteHarness } from './harness-remote.js';
import { docsQuery } from './harness-docs.js';
import { context7 } from '../dist/server/server/harness/context7.js';
import { probeRunner } from '../dist/server/server/harness/runner-probe.js';
import { probeArgs } from './harness-probe.js';
const args = process.argv.slice(2);
if (process.env.AGENT_OFFICE_HOOK_URL) {
  await remoteHarness(args);
} else {
let project = process.cwd();
let dataDir = process.env.AGENT_OFFICE_DATA_DIR;
while (args[0] === '--project' || args[0] === '--data-dir') {
  const option = args.shift();
  const value = args.shift();
  if (!value || value.startsWith('--')) throw new Error(option + ' requires a folder');
  if (option === '--project') project = value;
  else dataDir = value;
}
const action = args.shift();
if (action === '--docs-accepted') throw new Error('Accepted documentation requires a connected worker Office and current accepted kit.');
if (action === '--probe') console.log(JSON.stringify(await probeRunner(probeArgs(args)), null, 2));
else if (['--docs-resolve', '--docs'].includes(action)) {
  console.log(JSON.stringify(await context7(docsQuery(action, args), { apiKey: process.env.CONTEXT7_API_KEY }), null, 2));
} else {
if (action && !['--read', '--bundle'].includes(action)) throw new Error('Usage: office-harness [--project folder] [--read id | --bundle id ...]');
const library = new HarnessLibrary(harnessSources(project, true), dataDir ? new HarnessRegistry(dataDir) : undefined);
const catalog = await library.list();
if (!action) console.log(JSON.stringify(catalog, null, 2));
else {
  if (!args.length || (action === '--read' && args.length !== 1) || args.length > 24) throw new Error('Select 1 entry to read, or 1–24 entries to bundle.');
  const entries = await Promise.all(args.map((id) => library.read(id)));
  if (entries.some((e) => !e)) throw new Error('An entry is unavailable; list the catalog again.');
  console.log(action === '--read' ? entries[0].text : harnessBundle(entries));
}
}
}

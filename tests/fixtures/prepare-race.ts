// One of two office processes taking the same card at the same moment (tests/harness-prepare-hardening.test.ts):
// it waits until the shared start time, prepares c2 of the data dir through the runner and prints the
// outcome, then stays alive a while (a live owner) before it exits. Creating a record is slowed down
// (the first index marker written takes 600 ms), so the two lookups overlap unless the per-card lock
// makes them one step each.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { prepareRun } from '../../src/server/harness/prepare.js';
import { fakeAdapter, registerAdapter } from '../../src/server/harness/adapters.js';

registerAdapter(fakeAdapter().adapter);

const [dir, startAt] = process.argv.slice(2);
const write = fs.writeFileSync;
fs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: never[]) => {
  if (typeof file === 'string' && /[\\/]active[\\/][0-9a-f]{32}\./.test(file)) { const end = Date.now() + 600; while (Date.now() < end) { /* a slow disk */ } }
  return (write as (...a: unknown[]) => void)(file, ...rest);
}) as typeof fs.writeFileSync;
syncBuiltinESMExports();
await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
const nodes = [{ id: 'c2', kind: 'node', name: 'Pay API', parentId: null }] as never;
let outcome: string;
try { const run = await prepareRun({ dataDir: dir, repo: dir, place: { project: 'p1', workspace: 'draft' }, card: 'c2', nodes, local: false }); outcome = 'prepared ' + run.runId; }
catch (err) { outcome = 'refused: ' + (err as Error).message; }
console.log(JSON.stringify({ outcome }));
await new Promise((r) => setTimeout(r, 1500));
process.exit(0);

// A child process for tests/harness-cascade.test.ts: one office process saving harness profiles on a
// shared data directory. argv: <dataDir> <name> <count>. Each save adds one slot of its own to the
// global or the project layer, turn by turn (read-modify-write with the revision it read; a 409 is read
// again and retried), and the process prints the slots whose saves the store accepted, so the parent can
// check every one is in the file. Two layers, because one holds 64 slots at most.
import { HarnessProfiles } from '../../src/server/harness/profiles.js';

const [dataDir, name, count] = process.argv.slice(2);
const store = new HarnessProfiles(dataDir);
const accepted: string[] = [];
for (let i = 0; i < Number(count); i++) {
  const slot = `${name}-${i}`;
  for (;;) {
    const view = store.view('/repo');
    const level = i % 2 ? 'project' : 'global';
    try {
      await store.save('/repo', '', level, { ...view.layers[level], [slot]: { value: i } }, view.revision, name);
      accepted.push(slot);
      break;
    } catch (err) {
      if ((err as { status?: number }).status === 409 || (err as { status?: number }).status === 503) continue;
      throw err;
    }
  }
}
process.stdout.write(JSON.stringify(accepted));

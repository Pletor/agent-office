// A child process for tests/harness-commit.test.ts: one office process saving harness profiles on a shared
// data directory with a very short lock lease and a stall injected between its lock check and its publish
// (the window no lock can close). argv: <dataDir> <name> <count> <staleMs> <renewMs> <stallEvery> <stallMs>.
// Each save adds one slot to this process's own task layer (read-modify-write with the revision it read;
// a 409 or 503 is read again and retried) and the process prints, for every accepted save, the revision
// the store answered and the number of slots the layer had then.
import { HarnessProfiles } from '../../src/server/harness/profiles.js';

const [dataDir, name, count, staleMs, renewMs, stallEvery, stallMs] = process.argv.slice(2);
const busy = (ms: number) => { const until = Date.now() + ms; while (Date.now() < until) { /* a blocked loop, as a paused VM would be */ } };
const store = new HarnessProfiles(dataDir, {
  waitMs: 20_000, staleMs: Number(staleMs), renewMs: Number(renewMs),
  hooks: { verified: () => { if (Math.random() < 1 / Number(stallEvery)) busy(Number(stallMs)); } },
});
const accepted: { revision: number; slots: number }[] = [];
let retries = 0;
for (let i = 0; i < Number(count); i++) {
  for (;;) {
    const view = store.view('/repo', name);
    try {
      const saved = await store.save('/repo', name, 'task', { ...view.layers.task, [`s${i}`]: { value: i } }, view.revision, name);
      accepted.push({ revision: saved.revision, slots: i + 1 });
      break;
    } catch (err) {
      const code = (err as { status?: number }).status;
      if (code === 409 || code === 503) { retries++; continue; }
      throw err;
    }
  }
}
process.stdout.write(JSON.stringify({ name, accepted, retries }));

// An office that stops in the middle of taking a card (tests/harness-prepare.test.ts): it prepares c2
// through the preparation runner and exits at the point named, the way a killed process would, leaving
// its records, its snapshot and (on Opora's side) its lease as they were at that moment.
//   prepared     exits as soon as the run is prepared, before the claim
//   claimed      exits when the worker is about to be seated, after the claim
//   seat-window  exits right after the worker was seated, before the run is recorded as seated
import { registerAdapter, fakeAdapter } from '../../src/server/harness/adapters.js';
import { preparedCardRun } from '../../src/server/harness/prepare-recover.js';
import { bridgeOn, fakeFloor } from './prepare-opora.js';

const [mode, dir, url, workersFile] = process.argv.slice(2);
registerAdapter(fakeAdapter().adapter);
const { floor, workers, save } = fakeFloor(dir, workersFile, () => {
  if (mode === 'claimed') process.exit(0);
  return undefined;
});
if (mode === 'seat-window') {
  const seat = floor.seat.bind(floor);
  floor.seat = (deskId, by, prompt, owner) => {
    const w = seat(deskId, by, prompt, owner);
    save();
    process.exit(0);
    return w;
  };
}
const { bridge } = bridgeOn(floor, dir, url, {
  async prepareTask(project, workspace, card, _owner, nodes) {
    const task = await preparedCardRun(dir, dir, { project, workspace }, card, nodes, false);
    if (mode === 'prepared') process.exit(0);
    return task;
  },
});
await bridge.poll();
const result = await bridge.take('c2', 'Ana');
console.log(JSON.stringify({ result: result ?? null, workers: workers.length }));
process.exit(1);

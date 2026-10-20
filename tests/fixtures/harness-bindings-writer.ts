// A child process for tests/harness-bindings-lock.test.ts: one office process writing the two H04 data
// files on a shared data directory. argv: <dataDir> <mode> <arg>, printing one line of JSON.
//   request <name>: the same write (requestId "same", same payload) as every other child: replay check, a
//     slow "write" (an audit line appended to writes.log, which a second write would double), record.
//     Prints "wrote" or "replay".
//   bind <project>: binds floor "a" (checkout <dataDir>/repo) to that project in workspace "w", no rebind.
//     Prints "bound" or the refusal's status.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { HarnessBindings } from '../../src/server/harness/bindings.js';
import { HarnessRequests } from '../../src/server/harness/requests.js';

const [dataDir, mode, arg] = process.argv.slice(2);
const out = (value: string | number) => process.stdout.write(JSON.stringify(value));
if (mode === 'request') {
  const log = new HarnessRequests(dataDir);
  const body = { scope: 'task', layer: { tone: { value: 'warm' } }, revision: 0, requestId: 'same' };
  out(await log.exclusive(async () => {
    if (log.replay('repo:x', body)) return 'replay';
    await new Promise((resolve) => setTimeout(resolve, 300));
    appendFileSync(path.join(dataDir, 'writes.log'), `${arg}\n`);
    log.record('repo:x', body, 200, { by: arg });
    return 'wrote';
  }));
} else {
  try {
    await new HarnessBindings(dataDir).bind('a', path.join(dataDir, 'repo'), { project: arg, workspace: 'w' }, 'child:' + arg);
    out('bound');
  } catch (err) { out((err as { status?: number }).status ?? 500); }
}

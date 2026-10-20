// A child process for tests/harness-bindings-lock.test.ts: one office process writing the two H04 data
// files on a shared data directory. argv: <dataDir> <mode> <arg>, printing one line of JSON.
//   request <name>: the same write (requestId "same", same payload) as every other child: replay check, a
//     slow "write" (an audit line appended to writes.log, which a second write would double), record.
//     Prints "wrote" or "replay".
//   bind <project>: binds floor "a" (checkout <dataDir>/repo) to that project in workspace "w", no rebind.
//     Prints "bound" or the refusal's status.
//   bind-stall <project>:<stallMs>: the same, with a very short lock lease and a blocked loop of stallMs between
//     the lock check and the publish (the window no lock can close: a paused process whose lock was taken over).
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
  const [project, stall] = mode === 'bind-stall' ? arg.split(':') : [arg, '0'];
  const busy = (ms: number) => { const until = Date.now() + ms; while (Date.now() < until) { /* a blocked loop, as a paused VM would be */ } };
  const options = mode === 'bind-stall' ? { waitMs: 20_000, staleMs: 300, renewMs: 100, hooks: { verified: () => busy(Number(stall)) } } : {};
  try {
    await new HarnessBindings(dataDir, options).bind('a', path.join(dataDir, 'repo'), { project, workspace: 'w' }, 'child:' + project);
    out('bound');
  } catch (err) { out((err as { status?: number }).status ?? 500); }
}

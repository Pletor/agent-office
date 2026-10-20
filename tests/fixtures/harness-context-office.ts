// A child process for tests/harness-context.browser.mjs: the four-floor office of
// tests/support/harness-context-office.ts (Ample, Tajemství opory, an unbound and an unreachable floor)
// on 127.0.0.1. Prints `READY <base url>` once it listens; stops (and removes its data) when stdin closes.
import { contextOffice } from '../support/harness-context-office.js';

const office = await contextOffice({ port: Number(process.env.HARNESS_CONTEXT_PORT ?? 0) });
process.stdout.write('READY ' + office.base + '\n');
const stop = () => { office.close(); process.exit(0); };
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
process.on('SIGTERM', stop);

/** Offline contract harness only. Input evidence tiers are assertions, never authenticated here. */
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { replayHarnessLearning } from '../../shared/harness-learning.js';

try {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('Usage: npm run harness:replay -- observations.json');
  const fd = openSync(args[0], 'r');
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Replay requires a regular file of at most 8 MiB');
    text = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Replay input exceeds 8 MiB');
  } finally { closeSync(fd); }
  const input: unknown = JSON.parse(text);
  if (!Array.isArray(input) || input.length > 10000) throw new Error('Expected an array of at most 10000 observations');
  console.log(JSON.stringify({ schema: 'harness.learning-replay/1', authority: 'offline-untrusted',
    promotionAllowed: false, summaries: replayHarnessLearning(input) }, null, 2));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}

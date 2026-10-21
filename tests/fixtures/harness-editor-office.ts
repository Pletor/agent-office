// A child process for tests/harness-editor.browser.mjs: the four-floor office of
// tests/support/harness-context-office.ts with the element route, plus a big catalog on the Tajemství
// floor: HARNESS_EDITOR_BULK files (default 1250) spread over every category and several groups, one
// with a very long name, so the category navigator is tried against more than the catalog's 1,200 limit.
// Prints `READY <base url>` once it listens; stops (and removes its data) when stdin closes.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HARNESS_CATEGORIES } from '../../src/shared/harness.js';
import { contextOffice } from '../support/harness-context-office.js';

const office = await contextOffice({ port: Number(process.env.HARNESS_EDITOR_PORT ?? 0) });
const bulk = Number(process.env.HARNESS_EDITOR_BULK ?? 1250);
const root = path.join(office.dataDir, 'checkouts', 'tajemstvi', '.harness');
for (let i = 0; i < bulk; i++) {
  const category = HARNESS_CATEGORIES[i % HARNESS_CATEGORIES.length];
  // Half of each category in one big shelf (more than a page of 40), the rest over seven smaller ones.
  const group = i % 2 === 0 ? 'common' : 'shelf-' + String(Math.floor(i / 97) % 7).padStart(2, '0');
  const dir = path.join(root, category, group);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `element-${String(i).padStart(4, '0')}.md`), `# Element ${i}\n\nBulk element ${i} in ${category}/${group}.\n`);
}
const long = path.join(root, 'instructions', 'a-group-folder-with-a-rather-long-name-that-keeps-going');
mkdirSync(long, { recursive: true });
writeFileSync(path.join(long, 'an-element-with-a-very-long-file-name-that-does-not-fit-on-one-line-of-a-phone-screen-at-all.md'), '# Long\n\nA long name.\n');
process.stdout.write('READY ' + office.base + '\n');
const stop = () => { office.close(); process.exit(0); };
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
process.on('SIGTERM', stop);

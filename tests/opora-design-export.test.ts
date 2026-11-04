import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { DESIGN_LINE, designOf, fetchDesign, installDesign, unzip } from '../src/server/opora/design-export.js';
import { executionPrompt } from '../src/server/opora/execution-prompt.js';
import { validTicket } from '../src/server/opora/ticket-gate.js';
import { budgetLease } from './support/opora-budget.js';

/** A zip as OPORA's zipfile writes one: local headers, central directory, end record (deflated, CRC left 0: unzip doesn't check it). */
function zip(files: Record<string, string>) {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name), data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(text.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(text.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data); central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}
const answer = (bytes: Uint8Array, revision?: string) => async () => ({ bytes, headers: new Headers(revision ? { 'X-Design-Revision': revision } : {}) });
const EXPORT = '/api/site-admin/export?project=web';

test('a ticket carries machine.design only with OPORA\'s export path', () => {
  assert.deepEqual(validTicket({ ticketId: 'tk_1', status: 'issued', machine: { cardId: 'c1', design: { revision: 7, export: EXPORT } } })!.machine.design, { revision: '7', export: EXPORT });
  assert.equal(validTicket({ ticketId: 'tk_1', status: 'issued', machine: { cardId: 'c1' } })!.machine.design, undefined);
  assert.deepEqual(designOf({ revision: 1, export: 'http://elsewhere/api/site-admin/export?project=web' }), {});
  assert.deepEqual(designOf({ revision: 1, export: '//elsewhere/x' }), {});
});

test('the export is unpacked into design/, read-only, replacing the old one, and kept out of git', async t => {
  const repo = mkdtempSync(path.join(tmpdir(), 'office-design-'));
  t.after(() => { for (const f of readdirSync(repo, { recursive: true })) chmodSync(path.join(repo, String(f)), 0o777); rmSync(repo, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const log: string[] = [];
  const first = await fetchDesign({ revision: '3', export: EXPORT }, answer(zip({ 'design/tokens.css': ':root{--c:red}', 'design/old.txt': 'old', 'design/fonts/a.woff2': 'font' }), '3'), m => log.push(m));
  assert.equal(first?.length, 3); assert.deepEqual(log, []);
  installDesign(repo, first!);
  assert.equal(readFileSync(path.join(repo, 'design', 'fonts', 'a.woff2'), 'utf8'), 'font');
  assert.equal(statSync(path.join(repo, 'design', 'tokens.css')).mode & 0o200, 0, 'read-only');
  installDesign(repo, unzip(zip({ 'design/tokens.css': ':root{--c:blue}', 'design/README.md': '# Design' })));
  assert.equal(readFileSync(path.join(repo, 'design', 'tokens.css'), 'utf8'), ':root{--c:blue}');
  assert.equal(existsSync(path.join(repo, 'design', 'old.txt')), false, 'the older export goes');
  assert.equal(readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n').filter(l => l === '/design/').length, 1);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '');
});

test('a revision mismatch is a warning; a failed download or a zip escaping design/ leaves design/ out', async () => {
  const log: string[] = [];
  assert.equal((await fetchDesign({ revision: '4', export: EXPORT }, answer(zip({ 'design/a.css': 'x' }), '5'), m => log.push(m)))?.length, 1);
  assert.match(log.pop()!, /revision 5, the ticket names 4/);
  assert.equal(await fetchDesign({ revision: '4', export: EXPORT }, async () => { throw new Error('OPORA refused the file (403)'); }, m => log.push(m)), undefined);
  assert.match(log.pop()!, /without design\/: OPORA refused the file \(403\)/);
  assert.equal(await fetchDesign({ revision: '4', export: EXPORT }, answer(zip({ 'design/../evil.sh': 'x' }), '4'), m => log.push(m)), undefined);
  assert.match(log.pop()!, /outside design\//);
  assert.equal(await fetchDesign({ revision: '4', export: EXPORT }, answer(new Uint8Array([1, 2, 3]), '4'), m => log.push(m)), undefined);
  assert.match(log.pop()!, /not a zip/);
});

test('the prompt names design/ only when the export is there', t => {
  const dirs = [mkdtempSync(path.join(tmpdir(), 'office-design-prompt-')), mkdtempSync(path.join(tmpdir(), 'office-design-prompt-'))];
  t.after(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));
  assert.ok(executionPrompt(dirs[0], 'http://localhost', 'office', budgetLease(), '', '', undefined, { essence: 'web' }, true).includes(DESIGN_LINE));
  assert.ok(!executionPrompt(dirs[1], 'http://localhost', 'office', budgetLease(), '', '', undefined, { essence: 'web' }).includes('design/'));
});

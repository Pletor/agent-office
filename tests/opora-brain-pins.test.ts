import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchPins, pinLabel, pluginDirArgs, type BrainPin } from '../src/server/opora/brain-pins.js';
import { fillCardModel } from '../src/server/opora/card-model.js';
import { validTicket } from '../src/server/opora/ticket-gate.js';
import { claude } from '../src/server/providers/claude.js';

const pin = (plugin: string, sha = 'abcdef012345'): BrainPin => ({ pin: `opora:brain:skill:${plugin}@${sha}`, plugin, version: sha, zip: `/api/brain-registry/pins/${plugin}@${sha}.zip` });

test('each pin is one --plugin-dir for the Claude session, after its model choice', () => {
  assert.deepEqual(pluginDirArgs(undefined), []);
  assert.deepEqual(pluginDirArgs(['/d/a@1.zip', '/d/b@2.zip']), ['--plugin-dir', '/d/a@1.zip', '--plugin-dir', '/d/b@2.zip']);
  const args = claude.launch({ h: { info: { id: 'w1', model: 'sonnet', pluginDirs: ['/d/ponytail@abcdef012345.zip'] } } as never, args: [], prompt: 'go', cwd: '.', setup: { settings: 's.json', dir: '.' } }).args;
  assert.deepEqual(args.slice(args.indexOf('--plugin-dir'), args.indexOf('--plugin-dir') + 2), ['--plugin-dir', '/d/ponytail@abcdef012345.zip']);
  assert.ok(args.indexOf('--plugin-dir') < args.indexOf('--'), 'ahead of the prompt');
  assert.equal(claude.launch({ h: { info: { id: 'w2' } } as never, args: [], prompt: 'go', cwd: '.', setup: { settings: 's.json', dir: '.' } }).args.includes('--plugin-dir'), false);
});

test('a ticket carries its pins; a Claude worker takes them, another provider skips them', () => {
  const ticket = validTicket({ ticketId: 'tk_1', status: 'issued', machine: { cardId: 'c1', pins: [pin('ponytail'), 7] } })!;
  assert.deepEqual(ticket.machine.pins, [pin('ponytail')]);
  assert.deepEqual(validTicket({ ticketId: 'tk_1', status: 'issued', machine: { cardId: 'c1' } })!.machine.pins, []);
  assert.equal(pinLabel(pin('ponytail')), 'ponytail@abcdef012345');
  const card = { model: 'sonnet', effort: 'medium' as const, pluginDirs: ['/d/ponytail@abcdef012345.zip'] };
  const forClaude: Parameters<typeof fillCardModel>[0] = { provider: 'claude' };
  fillCardModel(forClaude, card);
  assert.deepEqual(forClaude.pluginDirs, card.pluginDirs);
  const forCodex: Parameters<typeof fillCardModel>[0] = { provider: 'codex', name: 'Ada' };
  const warned: string[] = [], warn = console.warn;
  console.warn = (m: string) => void warned.push(m);
  try { fillCardModel(forCodex, card); } finally { console.warn = warn; }
  assert.equal(forCodex.pluginDirs, undefined);
  assert.match(warned.join('\n'), /Ada \(codex\): Brain pins skipped[\s\S]*ponytail@abcdef012345/);
});

test('a pin is downloaded once into the cache; a bad zip path or a failed download throws', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-pins-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const asked: string[] = [];
  const download = async (zip: string) => { asked.push(zip); return new TextEncoder().encode(`zip of ${zip}`); };
  const first = await fetchPins([pin('ponytail'), pin('lsp', '0123456789ab')], dir, download);
  assert.deepEqual(first, [path.join(dir, 'brain-pins', 'ponytail@abcdef012345.zip'), path.join(dir, 'brain-pins', 'lsp@0123456789ab.zip')]);
  assert.equal(readFileSync(first[0], 'utf8'), 'zip of /api/brain-registry/pins/ponytail@abcdef012345.zip');
  assert.deepEqual(await fetchPins([pin('ponytail')], dir, download), [first[0]]);
  assert.equal(asked.length, 2, 'the second fetch of the same pin downloads nothing');
  await assert.rejects(fetchPins([{ ...pin('x'), zip: '/api/brain-registry/pins/../../etc@abcdef012345.zip' }], dir, download), /no zip the office can fetch/);
  await assert.rejects(fetchPins([{ ...pin('x'), zip: 'http://elsewhere/x@abcdef012345.zip' }], dir, download), /no zip the office can fetch/);
  await assert.rejects(fetchPins([pin('gone')], dir, async () => { throw new Error('404'); }), /gone@abcdef012345 couldn't be fetched: 404/);
  assert.equal(existsSync(path.join(dir, 'brain-pins', 'gone@abcdef012345.zip')), false);
});

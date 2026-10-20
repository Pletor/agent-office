// The profiles store's commit (src/server/harness/commit.ts): each revision is published with an
// exclusive create, so no two saves can both commit on top of the same revision, whatever the lock
// did. The vacancy a delayed waiter leaves at the lock's path (both saves used to report success and
// one was lost), crash recovery between the publish and the main file, a main file replaced by hand,
// pruning, and real processes with a stall between the lock check and the publish.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HarnessProfiles } from '../src/server/harness/profiles.js';
import { KEEP_REVISIONS, revisionFile } from '../src/server/harness/commit.js';
import type { LockRecord } from '../src/server/harness/lock.js';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-commit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'harness-profiles.json'), lock: path.join(dir, 'harness-profiles.json.lock') };
}
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { open, opened };
}
const record = (token: string, renewedAt: number): LockRecord => ({ token, pid: 0, acquiredAt: renewedAt, renewedAt });
const outcome = (save: Promise<{ revision: number }>) => save.then((p) => `rev ${p.revision}`, (err: { status?: number }) => `refused ${err.status}`);

test('a holder whose lock a delayed waiter knocked off the path cannot commit over the save made in the vacancy', async (t) => {
  const { dir, lock } = fixture(t);
  writeFileSync(lock, JSON.stringify(record('dead', 0))); // a crashed holder's lock
  const w2Observed = gate(), w1InWork = gate(), w2Renamed = gate(), w3Done = gate(), w1Go = gate();
  // W2 observed the stale lock, then is slow: it renames whatever is at the path by then (W1's fresh lock) and stalls before putting it back.
  const w2 = new HarnessProfiles(dir, { hooks: {
    observed: async (r) => { if (r?.token === 'dead') { w2Observed.open(); await w1InWork.opened; } },
    renamed: async () => { w2Renamed.open(); await w3Done.opened; },
  } });
  const saveW2 = outcome(w2.save('/repo', '', 'global', { w2: { value: 1 } }, 0, 'w2'));
  await w2Observed.opened;
  // W1 takes the stale lock over properly and reads revision 0, then pauses (any preemption) before its commit.
  const saveW1 = outcome(new HarnessProfiles(dir).save('/repo', '', 'global', { w1: { value: 1 } }, 0, 'w1', async () => { w1InWork.open(); await w1Go.opened; }));
  // W3 finds the path empty while W1's lock is renamed away, takes the lock and commits revision 1.
  await w2Renamed.opened;
  const saveW3 = await outcome(new HarnessProfiles(dir).save('/repo', '', 'global', { w3: { value: 1 } }, 0, 'w3'));
  w3Done.open(); // W2 puts W1's lock back: W1's lock check passes again
  await new Promise((r) => setTimeout(r, 50));
  w1Go.open();
  const [r1, r2] = await Promise.all([saveW1, saveW2]);
  assert.equal(saveW3, 'rev 1');
  assert.equal(r1, 'refused 409', 'W1 built on revision 0, which W3 already succeeded: its publish finds revision 1 taken');
  assert.equal(r2, 'refused 409');
  const final = new HarnessProfiles(dir).view('/repo');
  assert.equal(final.revision, 1);
  assert.deepEqual(final.layers.global, { w3: { value: 1 } }, 'the save every party was told succeeded is the one in the store');
});

test('a revision published but not yet in the main file (a crash between the two) is read, and the next save completes it', async (t) => {
  const { dir, file } = fixture(t);
  const store = new HarnessProfiles(dir);
  await store.save('/repo', '', 'global', { a: { value: 1 } }, 0);
  const rev1 = readFileSync(file, 'utf8');
  // Revision 2 was published (exclusive create) and the writer crashed before replacing the main file.
  const rev2 = JSON.stringify({ ...JSON.parse(rev1), revision: 2, layers: { global: { a: { value: 2 } } } }, null, 2);
  writeFileSync(revisionFile(file, 2, rev1), rev2);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).revision, 1, 'an older office, reading the main file only, sees revision 1, unchanged');
  assert.equal(store.view('/repo').revision, 2, 'this office reads the published revision');
  assert.deepEqual(store.view('/repo').layers.global, { a: { value: 2 } });
  await assert.rejects(store.save('/repo', '', 'global', { lost: { value: 1 } }, 1), /changed elsewhere/, 'a save built on revision 1 is refused');
  assert.equal((await store.save('/repo', '', 'global', { a: { value: 3 } }, 2)).revision, 3);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).revision, 3, 'the main file is complete again');
  // A slow writer that renamed its older text over a newer main file: the published revisions lead to the latest.
  writeFileSync(file, rev2);
  assert.equal(store.view('/repo').revision, 3);
  assert.deepEqual(store.view('/repo').layers.global, { a: { value: 3 } });
});

test('a main file edited by hand (or written by an older office) is never overridden by revisions published on another text', async (t) => {
  const { dir, file } = fixture(t);
  const store = new HarnessProfiles(dir);
  await store.save('/repo', '', 'global', { a: { value: 1 } }, 0);
  await store.save('/repo', '', 'global', { a: { value: 2 } }, 1);
  writeFileSync(file, JSON.stringify({ revision: 1, layers: { global: { restored: { value: true } } } }));
  assert.equal(store.view('/repo').revision, 1);
  assert.deepEqual(store.view('/repo').layers.global, { restored: { value: true } }, 'revision 2 was built on another text and is not followed');
  assert.equal((await store.save('/repo', '', 'global', { b: { value: 1 } }, 1)).revision, 2, 'and a save on the restored file is not refused by it');
  assert.deepEqual(store.view('/repo').layers.global, { b: { value: 1 } });
});

test('only the latest published revisions are kept', async (t) => {
  const { dir } = fixture(t);
  const store = new HarnessProfiles(dir);
  for (let revision = 0; revision < KEEP_REVISIONS + 5; revision++) await store.save('/repo', '', 'global', { n: { value: revision } }, revision);
  const kept = readdirSync(dir).filter((f) => f.includes('.rev.')).map((f) => Number(f.split('.rev.')[1].split('.')[0])).sort((a, b) => a - b);
  assert.equal(kept.length, KEEP_REVISIONS);
  assert.equal(kept.at(-1), KEEP_REVISIONS + 5);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file left');
});

test('four processes with a short lease and stalls between the lock check and the publish: every accepted save is in the store', async (t) => {
  const { dir } = fixture(t);
  const saver = path.join(import.meta.dirname, 'fixtures', 'harness-stress-saver.ts');
  // A 60 ms lease, so stalls of 120 ms make other processes take the lock over while a holder is past its check.
  const run = (name: string) => promisify(execFile)(process.execPath, ['--import', 'tsx', saver, dir, name, '60', '60', '15', '6', '120'], { cwd: path.join(import.meta.dirname, '..'), timeout: 110_000 });
  const names = ['alpha', 'beta', 'gamma', 'delta'];
  const results = (await Promise.all(names.map(run))).map((r) => JSON.parse(r.stdout) as { name: string; accepted: { revision: number; slots: number }[]; retries: number });
  const accepted = results.flatMap((r) => r.accepted.map((a) => ({ ...a, name: r.name })));
  assert.equal(accepted.length, 240, 'every save was accepted in the end, after its retries');
  const revisions = new Set(accepted.map((a) => a.revision));
  assert.equal(revisions.size, 240, 'no two accepted saves got the same revision: none committed over another');
  const store = new HarnessProfiles(dir);
  assert.equal(store.view('/repo').revision, 240, 'one revision per accepted save');
  for (const name of names) assert.equal(Object.keys(store.view('/repo', name).layers.task).length, 60, `${name}'s layer has all its slots`);
  // The audit keeps the latest 200 saves: each of those accepted saves is there, at its revision, as it was saved.
  const audit = new Map(store.audit(200).map((a) => [a.revision, a]));
  for (const a of accepted.filter((x) => x.revision > 40)) {
    const entry = audit.get(a.revision);
    assert.ok(entry, `revision ${a.revision} is in the audit`);
    assert.deepEqual([entry.node, entry.slots.length], [a.name, a.slots], `revision ${a.revision} is ${a.name}'s save with ${a.slots} slots`);
  }
  t.diagnostic(`retries: ${results.map((r) => `${r.name} ${r.retries}`).join(', ')}`);
});

test('a save whose base has no published successor but is behind the main file (an older office wrote it, or the successor was pruned) is withdrawn', async (t) => {
  const { dir, file } = fixture(t);
  const store = new HarnessProfiles(dir);
  await store.save('/repo', '', 'global', { a: { value: 1 } }, 0);
  // While this save works under its lock, an older office (no lock, no publish) writes revision 2 into the main file.
  const older = () => writeFileSync(file, JSON.stringify({ revision: 2, layers: { global: { older: { value: true } } } }));
  await assert.rejects(store.save('/repo', '', 'global', { mine: { value: 1 } }, 1, '', older), /changed elsewhere/);
  assert.deepEqual(store.view('/repo').layers.global, { older: { value: true } }, 'the older office\'s write is kept');
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.rev.2.')), [], 'the withdrawn revision is not left behind');
  assert.equal((await store.save('/repo', '', 'global', { mine: { value: 1 } }, 2)).revision, 3);
});

test('a main file that can\'t be replaced for more saves than are kept loses none of them, and a damaged published file is named, not a 409 forever', async (t) => {
  const { dir, file } = fixture(t);
  const store = new HarnessProfiles(dir);
  await store.save('/repo', '', 'global', { n: { value: 0 } }, 0);
  chmodSync(file, 0o444); // read-only: renaming over it fails, every save stays published only
  t.after(() => { try { chmodSync(file, 0o644); } catch { /* removed */ } });
  for (let revision = 1; revision <= KEEP_REVISIONS + 2; revision++) await store.save('/repo', '', 'global', { n: { value: revision } }, revision);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).revision, 1, 'the main file stayed behind');
  assert.equal(store.view('/repo').revision, KEEP_REVISIONS + 3, 'no published revision above it was pruned: the walk reaches the latest');
  assert.deepEqual(store.view('/repo').layers.global, { n: { value: KEEP_REVISIONS + 2 } });
  chmodSync(file, 0o644);
  await store.save('/repo', '', 'global', { n: { value: 'back' } }, KEEP_REVISIONS + 3);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).revision, KEEP_REVISIONS + 4, 'the next save that can replace it completes the main file');
  assert.ok(readdirSync(dir).filter((f) => f.includes('.rev.')).length <= KEEP_REVISIONS, 'and pruning catches up');
  // A power loss left the next revision's file empty: the save says which file to remove instead of a 409 that never ends.
  const latest = readFileSync(file, 'utf8');
  writeFileSync(revisionFile(file, KEEP_REVISIONS + 5, latest), '');
  await assert.rejects(store.save('/repo', '', 'global', {}, KEEP_REVISIONS + 4), (err: Error & { status: number }) => err.status === 503 && /is damaged: remove that file/.test(err.message));
});

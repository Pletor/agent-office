// The bindings store commits by exclusive publish (src/server/harness/commit.ts), like the profiles store:
// two offices binding one checkout to different projects while the first is paused between its lock check
// and its publish (so the second took the lock over) leave exactly one winner and a 409 for the other, and
// a main file that can't be replaced (read-only) still reads the latest published revision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HarnessBindings } from '../src/server/harness/bindings.js';

const child = (dir: string, mode: string, arg: string) => promisify(execFile)(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'fixtures', 'harness-bindings-writer.ts'), dir, mode, arg], { cwd: path.join(import.meta.dirname, '..'), timeout: 110_000 }).then((r) => JSON.parse(r.stdout) as string | number);

test('two processes binding one checkout to different projects, one paused after its lock check: one wins, the other is a 409', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-bind-commit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // P1 passes its lock check and is paused for 2.5 s (its short lease goes stale); P2 takes the lock over and commits meanwhile.
  const first = child(dir, 'bind-stall', 'p1:2500');
  await new Promise((r) => setTimeout(r, 1500));
  const second = child(dir, 'bind-stall', 'p2:0');
  const results = await Promise.all([first, second]);
  assert.deepEqual([...results].map(String).sort(), ['409', 'bound'], JSON.stringify(results));
  const winner = results[0] === 'bound' ? 'p1' : 'p2';
  const store = new HarnessBindings(dir);
  assert.equal(store.forFloor('a')?.project, winner, 'the file holds the winner');
  assert.equal(store.revision(), 1);
  assert.equal(store.audit().length, 1, 'one audit entry');
});

test('a bindings file whose main copy is read-only still reads the latest published revision', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-bind-ro-'));
  const file = path.join(dir, 'harness-bindings.json');
  t.after(() => { try { chmodSync(file, 0o644); } catch { /* removed */ } rmSync(dir, { recursive: true, force: true }); });
  const store = new HarnessBindings(dir);
  await store.bind('a', path.join(dir, 'repo-a'), { project: 'p1', workspace: 'w' }, 'x');
  chmodSync(file, 0o444); // renaming over it fails: later binds stay published only
  await store.bind('b', path.join(dir, 'repo-b'), { project: 'p2', workspace: 'w' }, 'y');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).revision, 1, 'the main file is still the first revision');
  const fresh = new HarnessBindings(dir);
  assert.equal(fresh.revision(), 2);
  assert.equal(fresh.forFloor('b')?.project, 'p2');
  assert.equal(fresh.forFloor('a')?.project, 'p1');
  // A third bind builds on the published revision, not on the stale main file.
  await assert.rejects(fresh.bind('c', path.join(dir, 'repo-b'), { project: 'p3', workspace: 'w' }, 'z'), (err: { status?: number }) => err.status === 409);
  await fresh.bind('c', path.join(dir, 'repo-c'), { project: 'p3', workspace: 'w' }, 'z');
  assert.equal(new HarnessBindings(dir).revision(), 3);
  chmodSync(file, 0o644);
});

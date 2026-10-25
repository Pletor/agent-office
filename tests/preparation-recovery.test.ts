import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recoverPreparations } from '../src/server/workers/preparation-recovery.js';
import type { Worker } from '../src/server/workers/types.js';

const abandoned = () => ({ preparing: true, hookToken: 'private-token', info: { id: '../worker', name: 'Worker', deskId: 'desk-1',
  prompt: 'private-task', worktree: { path: '.worktrees/retained', branch: 'office/retained' } } }) as unknown as Worker;

test('recovery records before retirement, excludes credentials and refuses inconsistent records', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-recovery-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worker = abandoned(), warnings: string[] = []; let retired = 0;
  const retire = async () => {
    const files = readdirSync(path.join(dir, 'preparation-recovery')); assert.equal(files.length, 1);
    assert.match(files[0], /^[a-f0-9]{64}\.json$/);
    const text = readFileSync(path.join(dir, 'preparation-recovery', files[0]), 'utf8');
    assert.ok(!text.includes('private-token') && !text.includes('private-task'));
    assert.equal(JSON.parse(text).record.retained, true); retired++; return {};
  };
  assert.deepEqual(await recoverPreparations(dir, '/root', [worker], retire, m => warnings.push(m)), { recovered: 1, blocked: 0 });
  assert.deepEqual(await recoverPreparations(dir, '/root', [worker], retire, m => warnings.push(m)), { recovered: 1, blocked: 0 });
  worker.info.worktree!.path = '.worktrees/different';
  assert.deepEqual(await recoverPreparations(dir, '/root', [worker], retire, m => warnings.push(m)), { recovered: 0, blocked: 1 });
  assert.equal(retired, 2); assert.equal(warnings.length, 1);
});

test('unwritable recovery storage retains reservation; live preparation and terminal state are not retired', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-recovery-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'preparation-recovery'), 'blocked directory');
  let retired = 0; const retire = async () => { retired++; return {}; };
  assert.deepEqual(await recoverPreparations(dir, '/root', [abandoned()], retire, () => {}), { recovered: 0, blocked: 1 });
  const live = abandoned(); live.stopPreparation = () => {};
  const saved = abandoned(); saved.saved = { ptyId: 'terminal', status: 'idle', acked: true };
  const ordinary = abandoned(); ordinary.preparing = undefined;
  assert.deepEqual(await recoverPreparations(dir, '/root', [live, saved, ordinary], retire, () => {}), { recovered: 0, blocked: 0 });
  assert.equal(retired, 0);
});

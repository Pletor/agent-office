import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Worker } from './types.js';

/** Keep a credential-free recovery record before releasing an abandoned preclaim desk. */
function recordRecovery(directory: string, root: string, worker: Worker) {
  const info = worker.info;
  const record = { schema: 'office.preparation-recovery/1', workerId: info.id, name: info.name, deskId: info.deskId,
    root, worktree: info.worktree ?? null, repos: info.repos ?? [], reason: 'restart-before-start', writerState: 'unknown',
    automaticReuse: false, retained: true };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, createHash('sha256').update(info.id).digest('hex') + '.json');
  let fd: number;
  try { fd = openSync(file, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (JSON.stringify(saved.record) !== JSON.stringify(record)) throw new Error('Recovery record does not match the retained worker');
    return;
  }
  try { writeFileSync(fd, JSON.stringify({ recordedAt: new Date().toISOString(), record }, null, 2)); fsyncSync(fd); }
  finally { closeSync(fd); }
}

/** Only restored reservations lack an owning handle. Never resume or delete their worktrees. */
export async function recoverPreparations(dataDir: string, root: string, workers: Iterable<Worker>,
  retire: (id: string) => Promise<{ error?: string }>, warn: (message: string) => void) {
  let recovered = 0, blocked = 0;
  for (const worker of [...workers]) {
    if (!worker.preparing || worker.stopPreparation || worker.pty || worker.dsh || worker.saved) continue;
    try {
      recordRecovery(path.join(dataDir, 'preparation-recovery'), root, worker);
      const result = await retire(worker.info.id);
      if (result.error) throw new Error(result.error);
      recovered++;
    } catch {
      blocked++;
      warn(`Preparation recovery failed for ${worker.info.name}; inspect preparation-recovery and the retained worktree`);
    }
  }
  return { recovered, blocked };
}

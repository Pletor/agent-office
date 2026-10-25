// Bounded fixed-vector probes; adapted from the original H13 process/stdio probes.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

export interface ProbeResult { outcome: 'pass' | 'fail'; reason: string; code: number | null; text: string; bytes: number; durationMs: number }
export const PROBE_BYTES = 64 * 1024;
/** Settles once the whole tree has been told to die; on Windows that is when taskkill exits, not when the parent does. */
export function stopProbe(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') return new Promise(done => { execFile('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, timeout: 2000 }, () => done()); });
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  return Promise.resolve();
}
export function probeProcess(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProbeResult> {
  return new Promise(resolve => {
    const started = performance.now(), chunks: Buffer[] = [];
    let bytes = 0, finished = false, reason = '', code: number | null = null;
    const child = spawn(file, [...args], { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const result = () => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(grace);
      const text = reason === 'output-limit' ? '' : stripVTControlCharacters(Buffer.concat(chunks).toString('utf8'));
      resolve({ outcome: !reason && code === 0 ? 'pass' : 'fail', reason: reason || (code === 0 ? 'completed' : 'nonzero-exit'), code, text, bytes, durationMs: Math.max(0, performance.now() - started) });
    };
    let grace: ReturnType<typeof setTimeout> | undefined, killed: Promise<void> | undefined;
    const stop = (why: string) => { if (finished || reason) return; reason = why; killed = stopProbe(child); grace = setTimeout(result, 2200); };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > PROBE_BYTES) stop('output-limit');
      else if (!reason) chunks.push(chunk);
    });
    child.on('error', () => { reason ||= 'spawn-failed'; result(); });
    // The parent can close before taskkill reaches its children; a stopped probe answers only once the tree is gone.
    child.on('close', status => { code = status; if (killed) void killed.then(result); else result(); });
  });
}

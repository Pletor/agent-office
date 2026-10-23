// Bounded fixed-vector probes; adapted from the original H13 process/stdio probes.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

export interface ProbeResult { outcome: 'pass' | 'fail'; reason: string; code: number | null; text: string; bytes: number; durationMs: number }
export const PROBE_BYTES = 64 * 1024;
export function stopProbe(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') execFile('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, timeout: 2000 }, () => undefined);
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
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
    let grace: ReturnType<typeof setTimeout> | undefined;
    const stop = (why: string) => { if (finished || reason) return; reason = why; stopProbe(child); grace = setTimeout(result, 2200); };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > PROBE_BYTES) stop('output-limit');
      else if (!reason) chunks.push(chunk);
    });
    child.on('error', () => { reason ||= 'spawn-failed'; result(); });
    child.on('close', status => { code = status; result(); });
  });
}

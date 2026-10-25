import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

/** Restricts accidental writes/child processes, not a sandbox for hostile accepted code. */
export function runPinnedNode(file: string, args: string[], cwd: string, scratch: string, current: () => Promise<boolean>,
  options: { timeoutMs?: number; pollMs?: number }) {
  return new Promise<{ exitCode: number | null; reason: string; durationMs: number; stdout: string; stderr: string; outputBytes: number }>(resolve => {
    const started = performance.now();
    const env: NodeJS.ProcessEnv = { HOME: scratch, USERPROFILE: scratch, TMP: scratch, TEMP: scratch, TMPDIR: scratch };
    for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(process.execPath, ['--permission', '--allow-fs-read=' + cwd, '--allow-fs-read=' + file, file, ...args],
      { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let reason = '', bytes = 0, finished = false, polling = false;
    const out: Buffer[] = [], err: Buffer[] = [];
    const stop = (why: string) => { if (finished || reason) return; reason = why; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('timeout'), Math.max(1, Math.min(30_000, options.timeoutMs ?? 30_000)));
    const poll = setInterval(() => {
      if (polling || finished) return;
      polling = true;
      void current().then(ok => { if (!ok) stop('execution-changed'); }, () => stop('execution-unavailable')).finally(() => { polling = false; });
    }, Math.max(20, Math.min(1000, options.pollMs ?? 1000)));
    const finish = (code: number | null) => {
      if (finished) return; finished = true; clearTimeout(timer); clearInterval(poll);
      resolve({ exitCode: code, reason: reason || (code === 0 ? 'completed' : 'nonzero-exit'),
        durationMs: Math.max(0, performance.now() - started), outputBytes: bytes,
        stdout: stripVTControlCharacters(Buffer.concat(out).toString('utf8')),
        stderr: stripVTControlCharacters(Buffer.concat(err).toString('utf8')) });
    };
    for (const [stream, chunks] of [[child.stdout, out], [child.stderr, err]] as const) stream.on('data', (chunk: Buffer) => {
      const left = Math.max(0, 64 * 1024 - bytes); bytes += chunk.length;
      if (left) chunks.push(chunk.subarray(0, left));
      if (bytes > 64 * 1024) stop('output-limit');
    });
    child.on('error', () => { reason = 'spawn-failed'; finish(null); });
    child.on('close', finish);
  });
}

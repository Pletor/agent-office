// The MCP handshake probe (docs/harness.md "Runner adapters and capabilities"): proves a stdio server a
// run declares answers `initialize`, before the worker is told it has it. The server is started as an
// argument vector (never a shell), in the run's scoped folder, with a scrubbed environment whose HOME is
// a folder inside that scope (so a server that writes its config writes it there, and the rollback
// removes it) and no tokens or keys, for a bounded time; it is killed either way. A server the probe
// can't start safely (a Windows batch launcher) is reported, not run.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { defaultLocator, needsShell, probeEnv, type Locator } from './capabilities.js';
import type { McpServer } from './scoped-config.js';

export interface ProbeResult { ok: boolean; detail: string }
export type McpProber = (server: McpServer, options: { cwd: string; home: string; timeoutMs: number; signal?: AbortSignal }) => Promise<ProbeResult>;

export const PROBE_TIMEOUT_MS = 5000;
const MAX_STDOUT = 256 * 1024;

/** The `initialize` request a client opens an MCP session with. */
export const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-office-probe', version: '1' } } };

export function stdioProber(locator: Locator = defaultLocator): McpProber {
  return (server, { cwd, home, timeoutMs, signal }) => new Promise((resolve) => {
    const file = path.isAbsolute(server.command) ? server.command : locator(server.command);
    if (!file) return resolve({ ok: false, detail: `${server.command} is not on PATH` });
    if (needsShell(file)) return resolve({ ok: false, detail: `not probed: ${path.basename(file)} is a batch launcher only a shell can start` });
    mkdirSync(home, { recursive: true });
    const env = { ...probeEnv(), HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), XDG_CONFIG_HOME: path.join(home, '.config') };
    let out = '', settled = false;
    const child = spawn(file, server.args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let exited = false;
    // Resolved only once the server is gone (or after a grace period): it holds the scoped folder as its cwd until then.
    const done = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (exited) return resolve(r);
      const grace = setTimeout(() => resolve(r), 2000);
      child.once('close', () => { clearTimeout(grace); resolve(r); });
      try { child.kill(); } catch { clearTimeout(grace); resolve(r); }
    };
    const onAbort = () => done({ ok: false, detail: 'aborted: the step timed out' });
    const timer = setTimeout(() => done({ ok: false, detail: `no answer to initialize within ${timeoutMs} ms` }), timeoutMs);
    signal?.addEventListener('abort', onAbort);
    child.on('error', (err) => done({ ok: false, detail: 'could not start: ' + err.message }));
    child.on('exit', (code) => { exited = true; done({ ok: false, detail: `exited (${code}) before answering initialize` }); });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      out += chunk;
      if (out.length > MAX_STDOUT) return done({ ok: false, detail: 'answered with more than 256 KiB before initialize' });
      for (const line of out.split('\n').slice(0, -1)) {
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg?.jsonrpc === '2.0' && msg.id === 1) {
          const info = msg.result?.serverInfo;
          if (msg.result && typeof msg.result.protocolVersion === 'string') return done({ ok: true, detail: `answered initialize (protocol ${String(msg.result.protocolVersion).slice(0, 20)}${info?.name ? ', ' + String(info.name).slice(0, 60) : ''})` });
          return done({ ok: false, detail: 'answered initialize with an error' });
        }
      }
    });
    child.stdin!.on('error', () => undefined);
    child.stdin!.write(JSON.stringify(INITIALIZE) + '\n');
  });
}

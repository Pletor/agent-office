// Reuses H13's executable discovery and fixed --version/--help approach; help is not live verification.
import { accessSync, constants } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isAgentProvider, PROVIDER_META, type AgentProvider } from '../../shared/providers.js';
import { probeProcess, type ProbeResult } from './probe-process.js';

export type ProbeRun = typeof probeProcess;
export function probeEnvironment(home: string, source: NodeJS.ProcessEnv = process.env) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'LANG']) if (source[key] !== undefined) env[key] = source[key];
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), LOCALAPPDATA: path.join(home, 'LocalAppData'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), TMP: path.join(home, 'tmp'), TEMP: path.join(home, 'tmp'), NO_COLOR: '1' };
}
export function locateRunner(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts = process.platform === 'win32' && !path.extname(bin) ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter).filter(dir => path.isAbsolute(dir))) for (const ext of exts) {
    const file = path.join(dir, bin + ext);
    try { accessSync(file, constants.X_OK); return file; } catch { /* next absolute PATH entry */ }
  }
}
const flagListed = (help: string, flag: string) => new RegExp('(^|[\\s,])' + flag + '(?=[\\s,=<]|$)', 'm').test(help);
const noProbe = (reason: string): ProbeResult => ({ outcome: 'fail', reason, code: null, text: '', bytes: 0, durationMs: 0 });
const flags = ['--mcp-config', '--strict-mcp-config', '--settings', '--sandbox', '--ask-for-approval'];
export async function probeRunner(runner: AgentProvider, options: { locate?: typeof locateRunner; run?: ProbeRun; env?: NodeJS.ProcessEnv } = {}) {
  if (!isAgentProvider(runner)) throw new Error('Unknown registered runner');
  const started = performance.now(), checkedAt = new Date().toISOString(), bin = PROVIDER_META[runner].bin;
  const file = bin ? (options.locate ?? locateRunner)(bin, options.env) : undefined;
  let version = noProbe(!bin ? 'custom-runner-unconfigured' : !file ? 'executable-not-found' : 'batch-launcher-unsupported'), help = noProbe('not-probed');
  if (file && !/\.(?:cmd|bat)$/i.test(file)) {
    const root = await realpath(os.tmpdir()), home = await mkdtemp(path.join(root, 'office-harness-probe-'));
    try {
      for (const dir of ['tmp', 'AppData', 'LocalAppData', '.config', '.cache']) await mkdir(path.join(home, dir));
      const env = probeEnvironment(home, options.env), run = options.run ?? probeProcess;
      version = await run(file, ['--version'], home, env, 5000);
      const remaining = 10_000 - (performance.now() - started);
      if (remaining > 0) help = await run(file, ['--help'], home, env, Math.min(5000, remaining));
    } finally {
      // This exact mkdtemp target must remain immediately under the intended scratch root.
      if (path.dirname(path.resolve(home)) !== root || !path.basename(home).startsWith('office-harness-probe-')) throw new Error('Invalid probe scratch path');
      await rm(home, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    }
  }
  const first = version.text.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) ?? '';
  const observedVersion = version.outcome === 'pass' && /\b\d+\.\d+(?:\.\d+)?\b/.test(first) ? first : null;
  const observation = (result: ProbeResult) => ({ outcome: result.outcome, reason: result.reason, exitCode: result.code, bytes: result.bytes, durationMs: result.durationMs });
  return { schema: 'harness.runner-probe/1', authority: 'local-process-observation', scope: 'office-host', workerEnvironmentAttested: false,
    runner, bin: bin ?? null, checkedAt, durationMs: Math.max(0, performance.now() - started), located: !!file,
    version: observedVersion, versionProbe: observation(version), helpProbe: observation(help),
    advertisedFlags: help.outcome === 'pass' ? flags.filter(flag => flagListed(help.text, flag)) : [],
    capabilityEvidence: 'help advertises flags; MCP behavior, permissions and worker environment are unverified',
    availableRequirements: [], promotionAllowed: false };
}

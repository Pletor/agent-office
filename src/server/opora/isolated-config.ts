import { execFileSync } from 'node:child_process';
import { cents, hash, id } from './executors/validation.js';
import type { ManagedConfig, ManagedSecrets } from './executors/managed-http.js';
import { IsolatedExecutorRouteError } from '../http/routes/isolated-executors.js';

export interface IsolatedConfiguration { canvas: string; managed: ManagedConfig; secrets: () => ManagedSecrets; observer: { id: string; secret: string } }
const PREFIX = 'AGENT_OFFICE_OPORA_MANAGED_';
/** Explicit server credentials only. No gh auth, inherited subscription, or CLI fallback. */
export function isolatedConfiguration(env: NodeJS.ProcessEnv = process.env): IsolatedConfiguration | null {
  const names = ['AGENT_ID', 'AGENT_VERSION', 'ENVIRONMENT_ID', 'ENVIRONMENT_DIGEST', 'CONFIGURATION_DIGEST', 'MAX_LIST_COST_CENTS', 'GITHUB_TOKEN'];
  if (!names.every(name => typeof env[PREFIX + name] === 'string' && !!env[PREFIX + name])
    || !env.ANTHROPIC_API_KEY || !env.AGENT_OFFICE_OPORA_OBSERVER_ID || !env.AGENT_OFFICE_OPORA_OBSERVER_SECRET
    || !env[PREFIX + 'CANVAS_URL']) return null;
  const managed: ManagedConfig = { agentId: env[PREFIX + 'AGENT_ID']!, agentVersion: Number(env[PREFIX + 'AGENT_VERSION']),
    environmentId: env[PREFIX + 'ENVIRONMENT_ID']!, environmentDigest: env[PREFIX + 'ENVIRONMENT_DIGEST']!,
    configurationDigest: env[PREFIX + 'CONFIGURATION_DIGEST']!, maxListCostCents: env[PREFIX + 'MAX_LIST_COST_CENTS']! };
  const secret = env.AGENT_OFFICE_OPORA_OBSERVER_SECRET;
  if (!id(managed.agentId) || !id(managed.environmentId) || !Number.isSafeInteger(managed.agentVersion) || managed.agentVersion < 1
    || String(managed.agentVersion) !== env[PREFIX + 'AGENT_VERSION'] || !hash(managed.environmentDigest) || !hash(managed.configurationDigest)
    || !cents(managed.maxListCostCents) || managed.maxListCostCents === '0' || !id(env.AGENT_OFFICE_OPORA_OBSERVER_ID)
    || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 512 || /[\r\n]/.test(secret)) return null;
  const apiKey = env.ANTHROPIC_API_KEY, githubToken = env[PREFIX + 'GITHUB_TOKEN']!;
  if (/[\r\n]/.test(apiKey + githubToken)) return null;
  let canvas: string; try { canvas = canvasBase(env[PREFIX + 'CANVAS_URL']!); } catch { return null; }
  return { canvas, managed, secrets: () => ({ apiKey, githubToken }), observer: { id: env.AGENT_OFFICE_OPORA_OBSERVER_ID, secret } };
}
export function canvasBase(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))))
    throw new IsolatedExecutorRouteError('unavailable');
  return url.origin;
}
/** Read-only local verification: provider must mount this published commit, never the worktree. */
export function publishedRepository(directory: string) {
  const git = (args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', timeout: 5000, windowsHide: true,
    maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const origin = git(['remote', 'get-url', 'origin']);
    const matched = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(origin);
    const commitSha = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!matched || !hash(commitSha, 40) || matched[2].includes('..')) throw new Error();
    const refs = git(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin']).split('\n').filter(Boolean);
    if (!refs.length || refs.length > 256 || !refs.some(ref => {
      try { git(['merge-base', '--is-ancestor', commitSha, ref]); return true; } catch { return false; }
    })) throw new Error();
    return { url: `https://github.com/${matched[1]}/${matched[2]}`, commitSha };
  } catch { throw new IsolatedExecutorRouteError('unavailable'); }
}

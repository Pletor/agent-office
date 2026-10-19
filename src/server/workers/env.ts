// The environment the workers start with: the office's own, minus a parent agent session's.
import { PROVIDERS } from '../providers/index.js';

// Env vars from a parent agent session (e.g. starting the office from inside Claude Code) that
// would make a worker think it is a child session — that silently turns off transcript saving,
// which breaks resume. Each provider names its own (see ProviderAdapter.scrubEnv).
const SCRUB_ENV = new Set([
  ...Object.values(PROVIDERS).flatMap((p) => p.scrubEnv ?? []),
  'NO_COLOR', 'FORCE_COLOR', 'VSCODE_INJECTION', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
]);
const SCRUB_PREFIXES = [...Object.values(PROVIDERS).flatMap((p) => p.scrubPrefixes ?? []), 'NEBULA_', 'AGENT_OFFICE_'];
const scrubbed = (k: string) => SCRUB_ENV.has(k) || SCRUB_PREFIXES.some((p) => k.startsWith(p));

/** What a feature hands one worker's process on top (the Opora card session's name and lease, say), by worker id. */
type WorkerEnv = (workerId: string) => Record<string, string> | undefined;
const workerEnvs: WorkerEnv[] = [];

/** Adds what a feature hands a worker's process; hands back what takes it out again. */
export function addWorkerEnv(fn: WorkerEnv): () => void {
  workerEnvs.push(fn);
  return () => void workerEnvs.splice(workerEnvs.indexOf(fn) >>> 0, 1);
}

/**
 * The office's environment, minus anything that would make a child think it's a nested session,
 * and, for a worker (`workerId`), what the features hand that worker.
 */
export function childEnv(workerId?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !scrubbed(k)) env[k] = v;
  if (workerId) for (const fn of workerEnvs) Object.assign(env, fn(workerId));
  return env;
}

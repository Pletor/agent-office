import type http from 'node:http';
import type { AgentProvider } from '../../shared/providers.js';
import { send } from '../http/util.js';
import { probeRunner } from './runner-probe.js';

let active = 0, minute = 0, calls = 0;
const actors = new Map<string, { at: number; calls: number }>();
/** Called only after hook authentication; runner comes from the worker record. */
export async function runnerProbeRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL, runner: AgentProvider,
  actor: string, probe = probeRunner) {
  const headers = { 'cache-control': 'no-store' };
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' }, headers);
  if ([...url.searchParams.keys()].some(key => !['worker', 'capabilities'].includes(key))) return send(res, 400, { error: 'Probe the authenticated worker runner; no command, arguments or provider override accepted.' }, headers);
  const now = performance.now();
  if (now - minute >= 60_000) { minute = now; calls = 0; }
  for (const [id, window] of actors) if (now - window.at >= 60_000) actors.delete(id);
  const window = actors.get(actor) ?? { at: now, calls: 0 };
  if (active >= 2 || calls >= 32 || window.calls >= 4 || actors.size >= 1000 && !actors.has(actor)) return send(res, 429, { error: 'Runner probe budget reached.' }, { ...headers, 'retry-after': '60' });
  calls++; window.calls++; actors.set(actor, window); active++;
  try { return send(res, 200, await probe(runner), headers); }
  catch { return send(res, 503, { error: 'Runner probe could not complete; capability remains unverified.' }, headers); }
  finally { active--; }
}

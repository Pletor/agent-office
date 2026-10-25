import type http from 'node:http';
import type { Floor } from '../floor.js';
import type { Worker } from './types.js';
import { safeEq } from './util.js';

const active = new Map<string, { worker: Worker; current: () => boolean }>();

/** Exists only while the fixed checker runs; ordinary worker authentication is unchanged. */
export async function withPreparationAccess<T>(worker: Worker, current: () => boolean, run: () => Promise<T>) {
  if (active.has(worker.info.id)) throw new Error('Worker preparation access already active');
  const entry = { worker, current }; active.set(worker.info.id, entry);
  try { return await run(); }
  finally { if (active.get(worker.info.id) === entry) active.delete(worker.info.id); }
}

export function preparationApiWorker(floor: Floor | undefined, id: string, token: string,
  req: Pick<http.IncomingMessage, 'method'>, url: URL) {
  const entry = active.get(id);
  const route = req.method === 'GET' ? 'accepted-kit' : req.method === 'POST' ? 'docs' : '';
  if (!entry || !floor || !route || url.pathname !== '/office/harness'
    || !url.searchParams.has(route) || [...url.searchParams.keys()].some(k => k !== 'worker' && k !== route)
    || url.searchParams.getAll('worker').length !== 1 || url.searchParams.getAll(route).length !== 1
    || floor.workers.get(id) !== entry.worker.info || !entry.worker.preparing || !entry.current()
    || !floor.opora?.executions?.controller.allowed(id) || !token || !safeEq(token, entry.worker.hookToken)) return;
  return entry.worker.info;
}

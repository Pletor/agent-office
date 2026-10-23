import path from 'node:path';
import type http from 'node:http';
import type { Floor } from '../floor.js';
import { send } from '../http/util.js';
import { recoverTool } from './recovery.js';

/** Hook authentication happens before this handler. No caller-supplied path, peer or token. */
export async function recoveryRequest(floor: Floor, worker: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const headers = { 'cache-control': 'no-store' };
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' }, headers);
  if ([...url.searchParams.keys()].some(key => !['worker', 'recover', 'from'].includes(key)))
    return send(res, 400, { error: 'Recovery belongs to your current execution; use recover and from only.' }, headers);
  try {
    const result = await recoverTool(floor.opora.executions.controller, path.join(floor.dir, '.agent-office'), worker,
      url.searchParams.get('recover') ?? '', url.searchParams.get('from') ?? '');
    return send(res, 200, result, headers);
  } catch { return send(res, 409, { error: 'Historical recovery is unavailable, incompatible or unauthorized.' }, headers); }
}

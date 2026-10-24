import type http from 'node:http';
import { readBody, send } from '../http/util.js';
import { context7, DocumentationError } from './context7.js';
import { acceptedDocumentation } from './accepted-documentation.js';

let active = 0;
let total = { at: 0, calls: 0 };
const windows = new Map<string, { at: number; calls: number }>();
/** Worker identity comes from the existing hook authentication, never the query/body. */
export async function documentationRequest(req: http.IncomingMessage, res: http.ServerResponse, actor: string,
  controller?: unknown, worker = '', taskSpecified = false) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  const now = Date.now();
  if (now - total.at >= 60_000) total = { at: now, calls: 0 };
  for (const [id, window] of windows) if (now - window.at >= 60_000) windows.delete(id);
  const window = windows.get(actor) ?? { at: now, calls: 0 };
  if (active >= 2 || total.calls >= 40 || window.calls >= 8 || windows.size >= 1000 && !windows.has(actor)) return send(res, 429, { error: 'Documentation lookup budget reached; retry later.' }, { 'retry-after': '60' });
  total.calls++; window.calls++; windows.set(actor, window); active++;
  try {
    const input = JSON.parse(await readBody(req, 8192));
    if (input?.action === 'accepted-query') {
      if (taskSpecified) throw new DocumentationError('Accepted documentation belongs to the current execution; omit task.', 400);
      return send(res, 200, await acceptedDocumentation(input, controller, worker, { apiKey: process.env.CONTEXT7_API_KEY }), { 'cache-control': 'no-store' });
    }
    return send(res, 200, await context7(input, { apiKey: process.env.CONTEXT7_API_KEY }));
  } catch (error) {
    return send(res, error instanceof DocumentationError ? error.status : 400, { error: error instanceof DocumentationError ? error.message : 'Invalid documentation request.' });
  } finally { active--; }
}

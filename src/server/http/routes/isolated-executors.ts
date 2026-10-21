import type { Ctx } from '../../office/context.js';
import type { Floor } from '../../floor.js';
import { floorParam } from './files.js';
import { readBody, sameOrigin, send } from '../util.js';
import type { Route } from '../router.js';

const ROOT = '/api/opora/isolated-executors';
const BODY_LIMIT = 16 * 1024;
const EXECUTOR_ID = 'anthropic-managed-agents';

export interface IsolatedOfficeAccess {
  capabilities(): Promise<unknown>;
  status(): Promise<unknown>;
  start(input: { executorId: typeof EXECUTOR_ID; cardId: string; requestId: string }): Promise<unknown>;
  stop(input: { intentId: string }): Promise<unknown>;
  reconcile(): Promise<unknown>;
}

/** Safe, typed failure categories for an isolated-executor service; details are never sent to browsers. */
export class IsolatedExecutorRouteError extends Error {
  constructor(readonly kind: 'conflict' | 'unavailable') { super(kind); }
}

export function createIsolatedExecutorRoutes(resolve: (ctx: Ctx, floor: Floor) => IsolatedOfficeAccess): readonly Route[] {
  const route = (path: string, method: 'GET' | 'POST'): Route => ({
    path: `${ROOT}/${path}`, auth: 'session',
    async handle(ctx, r) {
      const { req, res, url } = r;
      if (method === 'POST') {
        if (!sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Same-origin request required' });
        if (r.session.account && r.session.account.role !== 'admin') return send(res, 403, { error: 'Admin access required' });
      }
      if (req.method !== method) return send(res, 405, { error: 'Method not allowed' }, { allow: method });
      const floor = floorParam(ctx, url);
      const floorId = url.searchParams.get('floor') ?? '';
      if (!floor || !floorId) return send(res, 404, { error: 'No such floor' });

      try {
        let input: { executorId: typeof EXECUTOR_ID; cardId: string; requestId: string } | { intentId: string } | undefined;
        if (method === 'POST') {
          const length = Number(req.headers['content-length']);
          if (Number.isFinite(length) && length > BODY_LIMIT) return send(res, 413, { error: 'Request body too large' });
          if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return send(res, 415, { error: 'JSON body required' });
          let body: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(await readBody(req, BODY_LIMIT));
            if (!object(parsed)) return send(res, 400, { error: 'Bad request' });
            body = parsed;
          } catch (error) {
            return send(res, (error as Error).message === 'too large' ? 413 : 400, { error: 'Bad request' });
          }
          if (ctx.floors.get(floorId) !== floor) return send(res, 404, { error: 'No such floor' });
          if (path === 'start') {
            if (!exactKeys(body, ['executorId', 'cardId', 'requestId']) || body.executorId !== EXECUTOR_ID || !validCardId(body.cardId) || !validRequestId(body.requestId)) return send(res, 400, { error: 'Bad request' });
            input = { executorId: EXECUTOR_ID, cardId: body.cardId, requestId: body.requestId };
          } else if (path === 'stop') {
            if (!exactKeys(body, ['intentId']) || !validIntentId(body.intentId)) return send(res, 400, { error: 'Bad request' });
            input = { intentId: body.intentId };
          } else {
            if (!exactKeys(body, [])) return send(res, 400, { error: 'Bad request' });
          }
        }
        if (ctx.floors.get(floorId) !== floor) return send(res, 404, { error: 'No such floor' });
        const access = resolve(ctx, floor);
        let result: unknown;
        if (path === 'capabilities') result = await access.capabilities();
        else if (path === 'runs') result = await access.status();
        else if (path === 'start') result = await access.start(input as { executorId: typeof EXECUTOR_ID; cardId: string; requestId: string });
        else if (path === 'stop') result = await access.stop(input as { intentId: string });
        else result = await access.reconcile();
        if (ctx.floors.get(floorId) !== floor) return send(res, 404, { error: 'No such floor' });
        return send(res, 200, result, { 'cache-control': 'no-store' });
      } catch (error) {
        if (ctx.floors.get(floorId) !== floor) return send(res, 404, { error: 'No such floor' });
        if (error instanceof IsolatedExecutorRouteError && error.kind === 'conflict') return send(res, 409, { error: 'The isolated execution state changed; refresh and try again.' });
        return send(res, 503, { error: 'The isolated executor is unavailable.' });
      }
    },
  });
  return [route('capabilities', 'GET'), route('runs', 'GET'), route('start', 'POST'), route('stop', 'POST'), route('reconcile', 'POST')];
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function validCardId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value); }
function validRequestId(value: unknown): value is string { return typeof value === 'string' && /^[\x20-\x7e]{1,80}$/.test(value); }
function validIntentId(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value); }

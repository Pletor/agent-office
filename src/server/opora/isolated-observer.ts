import { createHash, createHmac, randomUUID } from 'node:crypto';
import { canonical, hash, object } from './executors/validation.js';
import type { ExecutionIntent, ExecutorStatus } from './executors/types.js';
import { canvasBase } from './isolated-config.js';

const ROOT = '/api/oporahub/execution-observers';
export class IsolatedObserver {
  readonly base: string;
  constructor(base: string, private identity: { id: string; secret: string }, private transport: typeof fetch = fetch) { this.base = canvasBase(base); }
  private async post(endpoint: string, body: Record<string, unknown>) {
    const raw = canonical(body), stamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', this.identity.secret).update(stamp + '\n' + digestRaw(raw)).digest('hex');
    try {
      const response = await this.transport(this.base + ROOT + endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { Origin: this.base, 'Content-Type': 'application/json', 'x-opora-observer-id': this.identity.id,
          'x-opora-observer-time': stamp, 'x-opora-observer-signature': signature }, body: raw });
      if (!response.ok || response.redirected) throw new Error();
      const text = await response.text(); if (Buffer.byteLength(text) > 128 * 1024) throw new Error();
      const value = JSON.parse(text);
      if (!object(value) || !hash(value.id, 40) || value.observerId !== this.identity.id || value.schemaVersion !== 1
        || value.kind !== (endpoint === '/intents' ? 'execution-intent' : 'execution-observation')
        || value.executionBinding !== 'canvas-verified' || value.providerBinding !== 'observer-attested'
        || !Object.keys(body).every(key => canonical(body[key]) === canonical(value[key]))) throw new Error();
      return value;
    } catch { throw new Error('Canvas observer evidence unavailable'); }
  }
  async bind(body: Omit<ExecutionIntent, 'intentId'>) {
    const response = await this.post('/intents', body);
    if (response.authorityActive !== true) throw new Error('Canvas isolated authority is no longer active');
    return { ...body, intentId: response.id } as ExecutionIntent;
  }
  async observation(body: Record<string, unknown>) { return this.post('/observations', body); }
}
function digestRaw(raw: string) {
  // Raw body hash, deliberately distinct from the semantic journal digest.
  return createHash('sha256').update(raw).digest('hex');
}
export function observationPayload(intent: ExecutionIntent, status: ExecutorStatus | null, head: string | null, sequence: number) {
  const observed = status?.observation;
  const state = status?.state;
  const publicState = state === 'terminated' ? 'terminated' : state === 'termination_pending' ? 'termination_pending'
    : state === 'creation_unknown' ? 'creation_unknown' : observed?.status === 'idle' ? 'idle'
      : state === 'running' ? 'running' : status?.sessionId ? 'unknown' : 'creating';
  return { project: intent.project, workspace: intent.workspace, intentId: intent.intentId, requestId: randomUUID(),
    expectedObservationHead: head, sequence, sessionId: status?.sessionId ?? null, observedAt: new Date(observed?.observedAt ?? Date.now()).toISOString(),
    source: 'provider-api', status: publicState, providerStatus: observed?.status ?? null,
    cumulative: { inputTokens: observed?.inputTokens ?? 0, outputTokens: observed?.outputTokens ?? 0,
      cacheReadInputTokens: observed?.cacheReadInputTokens ?? 0, cacheCreation5mTokens: observed?.cacheCreation5mTokens ?? 0,
      cacheCreation1hTokens: observed?.cacheCreation1hTokens ?? 0, listCostCents: observed?.listCostCents ?? '0', currency: 'USD', activeSeconds: observed?.activeSeconds ?? 0 } };
}

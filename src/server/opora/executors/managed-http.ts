import { cents, hash, id, object } from './validation.js';
import { configurationDigest, environmentConfig, projectSession } from './managed-projection.js';
import { ExecutorFailure, type ExecutionIntent, type ProviderObservation } from './types.js';

export interface ManagedConfig {
  agentId: string; agentVersion: number; environmentId: string; environmentDigest: string; configurationDigest: string;
  maxListCostCents: string;
}
export interface ManagedSecrets { apiKey: string; githubToken: string }
export type ProviderFetch = (input: string, init: RequestInit) => Promise<Response>;
export interface ManagedMessage { eventId: string; processedAt: string; text: string }
/** Fixed credential destination; injected fetch may route to a synthetic loopback server in tests. */
export class ManagedAgentsHttp {
  constructor(readonly config: ManagedConfig, private secrets: () => ManagedSecrets,
    private transport: ProviderFetch = fetch, private timeoutMs = 10000) {
    if (!id(config.agentId) || !id(config.environmentId) || !Number.isSafeInteger(config.agentVersion) || config.agentVersion < 1
      || !hash(config.environmentDigest) || !hash(config.configurationDigest) || !cents(config.maxListCostCents)
      || config.maxListCostCents === '0' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new ExecutorFailure();
    this.config = Object.freeze(structuredClone(config));
  }
  private async request(endpoint: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new ExecutorFailure();
    if (!/^\/(sessions|environments)(\/[A-Za-z0-9_-]+)*(\/(events|archive))?$/.test(endpoint)
      && !/^\/agents\/[A-Za-z0-9_-]+\?version=[1-9][0-9]*$/.test(endpoint)
      && !(method === 'GET' && /^\/sessions\/sesn_[A-Za-z0-9_-]+\/events\?types%5B%5D=agent\.message&order=desc&limit=1$/.test(endpoint))) throw new ExecutorFailure();
    const controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ExecutorFailure()); }, this.timeoutMs);
      if (signal?.aborted) { controller.abort(); reject(new ExecutorFailure()); }
      controller.signal.addEventListener('abort', () => reject(new ExecutorFailure()), { once: true });
    });
    try {
      const credentials = this.secrets();
      if (!credentials.apiKey || /[\r\n]/.test(credentials.apiKey)) throw new ExecutorFailure();
      const response = await Promise.race([this.transport('https://api.anthropic.com/v1' + endpoint, {
        method, redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { 'x-api-key': credentials.apiKey, 'anthropic-version': '2023-06-01',
          'anthropic-beta': 'managed-agents-2026-04-01', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), timeout]);
      if (!response.ok || response.redirected || (response.url && !response.url.startsWith('https://api.anthropic.com/')))
        throw new ExecutorFailure();
      const read = async () => {
        if (!response.body) throw new ExecutorFailure();
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            length += part.value.byteLength;
            if (length > 256 * 1024) { void reader.cancel(); throw new ExecutorFailure(); }
            chunks.push(part.value);
          }
        } finally { reader.releaseLock(); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      };
      return await Promise.race([read(), timeout]);
    } catch { throw new ExecutorFailure(); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async environment(signal?: AbortSignal) {
    const config = this.config;
    return environmentConfig(await this.request('/environments/' + config.environmentId, 'GET', undefined, signal), config.environmentId, config.environmentDigest);
  }
  async verify(signal?: AbortSignal) {
    const environment = await this.environment(signal);
    const agent = await this.request('/agents/' + this.config.agentId + '?version=' + this.config.agentVersion, 'GET', undefined, signal);
    if (!object(agent) || agent.type !== 'agent' || agent.archived_at !== null || agent.id !== this.config.agentId
      || agent.version !== this.config.agentVersion || configurationDigest(agent, environment) !== this.config.configurationDigest) throw new ExecutorFailure();
  }
  matches(intent: ExecutionIntent) {
    return ['agentId', 'agentVersion', 'environmentId', 'environmentDigest', 'configurationDigest'].every(key =>
      intent[key as keyof ManagedConfig] === this.config[key as keyof ManagedConfig])
      && cents(this.config.maxListCostCents) && BigInt(intent.maxListCostCents) <= BigInt(this.config.maxListCostCents);
  }
  async create(intent: ExecutionIntent, signal?: AbortSignal): Promise<string> {
    if (!this.matches(intent)) throw new ExecutorFailure();
    const token = this.secrets().githubToken;
    if (!token || /[\r\n]/.test(token)) throw new ExecutorFailure();
    const value = await this.request('/sessions', 'POST', {
      agent: { type: 'agent', id: intent.agentId, version: intent.agentVersion }, environment_id: intent.environmentId,
      resources: [{ type: 'github_repository', url: intent.repository.url, mount_path: '/workspace/repo',
        checkout: { type: 'commit', sha: intent.repository.commitSha }, authorization_token: token }],
      budget: { type: 'limit', max_list_cost: { amount: intent.maxListCostCents, currency: 'USD' } },
    }, signal);
    if (!object(value) || !id(value.id) || !value.id.startsWith('sesn_')) throw new ExecutorFailure();
    return value.id;
  }
  async observe(intent: ExecutionIntent, sessionId: string, signal?: AbortSignal): Promise<ProviderObservation> {
    if (!id(sessionId)) throw new ExecutorFailure();
    const environment = await this.environment(signal);
    return projectSession(await this.request('/sessions/' + sessionId, 'GET', undefined, signal), intent, sessionId, environment, Date.now());
  }
  /** Revocation remains possible after a task-affecting resource changes. Same mapped session only. */
  async observeForStop(intent: ExecutionIntent, sessionId: string): Promise<ProviderObservation> {
    if (!id(sessionId)) throw new ExecutorFailure();
    return projectSession(await this.request('/sessions/' + sessionId, 'GET'), intent, sessionId, null, Date.now(), false);
  }
  /** Read the latest provider event only. Pagination and agent actions are never inferred. */
  async readLatestMessage(sessionId: string): Promise<ManagedMessage | null> {
    if (!id(sessionId) || !sessionId.startsWith('sesn_')) throw new ExecutorFailure();
    const value = await this.request('/sessions/' + sessionId + '/events?types%5B%5D=agent.message&order=desc&limit=1', 'GET');
    if (!object(value) || !Array.isArray(value.data) || value.data.length > 1
      || Object.keys(value).some(key => key !== 'data' && key !== 'next_page')
      || (value.next_page != null && (typeof value.next_page !== 'string' || value.next_page.length > 2048))) throw new ExecutorFailure();
    if (!value.data.length) return null;
    const event = value.data[0];
    if (!object(event) || Object.keys(event).sort().join() !== 'content,id,processed_at,type'
      || event.type !== 'agent.message' || !id(event.id) || !event.id.startsWith('sevt_')
      || typeof event.processed_at !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(event.processed_at)
      || !Number.isFinite(Date.parse(event.processed_at)) || !Array.isArray(event.content) || event.content.length > 64) throw new ExecutorFailure();
    const [year, month, day] = event.processed_at.slice(0, 10).split('-').map(Number);
    const calendar = new Date(0); calendar.setUTCFullYear(year, month, 0);
    if (day > calendar.getUTCDate()) throw new ExecutorFailure();
    if (!event.content.length || event.content.some(block => !object(block) || block.type !== 'text')) return null;
    let text = '';
    for (const block of event.content) {
      if (Object.keys(block).sort().join() !== 'text,type' || typeof block.text !== 'string'
        || Buffer.from(block.text).toString('utf8') !== block.text) throw new ExecutorFailure();
      if (Buffer.byteLength(text) + Buffer.byteLength(block.text) > 64000) throw new ExecutorFailure();
      text += block.text;
    }
    return { eventId: event.id, processedAt: new Date(event.processed_at).toISOString(), text };
  }
  async start(sessionId: string, prompt: string, signal?: AbortSignal) {
    if (!id(sessionId) || typeof prompt !== 'string' || !prompt || Buffer.byteLength(prompt) > 1024 * 1024) throw new ExecutorFailure();
    await this.request('/sessions/' + sessionId + '/events', 'POST', { events: [{ type: 'user.message', content: [{ type: 'text', text: prompt }] }] }, signal);
  }
  async interrupt(sessionId: string) {
    if (!id(sessionId)) throw new ExecutorFailure();
    await this.request('/sessions/' + sessionId + '/events', 'POST', { events: [{ type: 'user.interrupt' }] });
  }
  async archive(sessionId: string) {
    if (!id(sessionId)) throw new ExecutorFailure();
    await this.request('/sessions/' + sessionId + '/archive', 'POST', {});
  }
}

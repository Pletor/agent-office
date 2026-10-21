import { digest, object, validateObservation } from './validation.js';
import { ExecutorFailure, type ExecutionIntent, type ProviderObservation } from './types.js';

/** Only effective instruction/tool fields; resource labels/timestamps are not authority. */
export function effectiveAgent(value: unknown) {
  if (!object(value)) throw new ExecutorFailure();
  return Object.fromEntries(['id', 'version', 'model', 'system', 'tools', 'mcp_servers', 'skills', 'multiagent', 'execution_identity']
    .map(key => [key, value[key] ?? null]));
}
export function environmentConfig(value: unknown, environmentId: string, expectedDigest: string) {
  if (!object(value) || value.type !== 'environment' || value.id !== environmentId || value.archived_at !== null
    || !object(value.config) || value.config.type !== 'cloud' || !object(value.config.networking)
    || value.config.networking.type !== 'limited' || digest(value.config) !== expectedDigest) throw new ExecutorFailure();
  return value.config;
}
export function configurationDigest(agent: unknown, environment: unknown) {
  return digest({ agent: effectiveAgent(agent), environment });
}
/** Provider API read, never an agent supplied report. No raw response is persisted or returned. */
export function projectSession(value: unknown, intent: ExecutionIntent, sessionId: string, environment: unknown, now: number, checkPins = true): ProviderObservation {
  if (!object(value) || value.id !== sessionId || value.type !== 'session') throw new ExecutorFailure();
  if (checkPins && (value.environment_id !== intent.environmentId
    || !object(value.agent) || value.agent.id !== intent.agentId || value.agent.version !== intent.agentVersion
    || configurationDigest(value.agent, environment) !== intent.configurationDigest
    || !object(value.budget) || value.budget.type !== 'limit' || !object(value.budget.max_list_cost)
    || value.budget.max_list_cost.amount !== intent.maxListCostCents || value.budget.max_list_cost.currency !== 'USD'
    || !Array.isArray(value.resources) || value.resources.length !== 1)) throw new ExecutorFailure();
  const repo = value.resources?.[0];
  if (checkPins && (!object(repo) || repo.type !== 'github_repository' || repo.url !== intent.repository.url
    || repo.mount_path !== '/workspace/repo' || !object(repo.checkout) || repo.checkout.type !== 'commit'
    || repo.checkout.sha !== intent.repository.commitSha)) throw new ExecutorFailure();
  if (!object(value.usage)) throw new ExecutorFailure();
  const usage = value.usage;
  if (!object(usage.cache_creation) || !object(usage.list_cost)) throw new ExecutorFailure();
  const body = { intentId: intent.intentId, executionId: intent.executionId, epoch: intent.epoch, sessionId,
    observedAt: now, status: value.status, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens, cacheCreation5mTokens: usage.cache_creation.ephemeral_5m_input_tokens,
    cacheCreation1hTokens: usage.cache_creation.ephemeral_1h_input_tokens, listCostCents: usage.list_cost.amount,
    currency: usage.list_cost.currency, activeSeconds: usage.active_seconds, source: 'provider-api' };
  return validateObservation({ ...body, digest: digest(body) }, intent, sessionId);
}

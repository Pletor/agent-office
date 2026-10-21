import { createHash } from 'node:crypto';
import { validateBudget } from '../execution-budget.js';
import { ExecutorFailure, PROVIDER, type ExecutionIntent, type ProviderObservation } from './types.js';

export const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export const hash = (v: unknown, n = 64): v is string => typeof v === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(v);
export const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
export const cents = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v);
export const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
}
export const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const INTENT_KEYS = ['intentId', 'requestId', 'provider', 'project', 'workspace', 'nodeId', 'executionId', 'epoch',
  'acceptedRevision', 'assignmentDigest', 'contextProtocolVersion', 'contextVersion', 'budget', 'authorityDeadlineAt',
  'repository', 'agentId', 'agentVersion', 'executionProtocolVersion', 'environmentId', 'environmentDigest', 'configurationDigest', 'maxListCostCents'];
export function validateIntent(value: unknown): ExecutionIntent {
  if (!object(value) || Object.keys(value).length !== INTENT_KEYS.length || !INTENT_KEYS.every(key => key in value)
    || !hash(value.intentId, 40) || !id(value.requestId) || value.provider !== PROVIDER
    || !['project', 'workspace'].every(key => typeof value[key] === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value[key]))
    || typeof value.nodeId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.nodeId)
    || !['executionId', 'agentId', 'environmentId'].every(key => id(value[key]))
    || !count(value.epoch) || value.epoch < 1 || !hash(value.acceptedRevision, 40) || !hash(value.assignmentDigest)
    || ![1, 2].includes(value.contextProtocolVersion) || typeof value.contextVersion !== 'string'
    || !value.contextVersion || value.contextVersion.length > 4096 || /[\x00-\x1f]/.test(value.contextVersion)
    || typeof value.authorityDeadlineAt !== 'number' || !Number.isFinite(value.authorityDeadlineAt)
    || value.authorityDeadlineAt <= 0 || value.authorityDeadlineAt > 253402214399
    || !count(value.agentVersion) || value.agentVersion < 1 || !hash(value.environmentDigest) || !hash(value.configurationDigest)
    || !cents(value.maxListCostCents) || value.maxListCostCents === '0' || !object(value.repository)
    || Object.keys(value.repository).sort().join() !== 'commitSha,url' || !hash(value.repository.commitSha, 40)
    || typeof value.repository.url !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(value.repository.url)
    || value.repository.url.endsWith('.git')) throw new ExecutorFailure();
  validateBudget(value.budget);
  if (value.executionProtocolVersion !== 2 || value.authorityDeadlineAt !== value.budget.runDeadlineAt) throw new ExecutorFailure();
  return structuredClone(value) as ExecutionIntent;
}
export function validateObservation(value: unknown, intent: ExecutionIntent, sessionId: string): ProviderObservation {
  if (!object(value) || value.intentId !== intent.intentId || value.executionId !== intent.executionId || value.epoch !== intent.epoch
    || value.sessionId !== sessionId || !id(sessionId) || !count(value.observedAt)
    || !['idle', 'running', 'rescheduling', 'terminated'].includes(value.status)
    || !['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreation5mTokens', 'cacheCreation1hTokens'].every(key => count(value[key]))
    || !cents(value.listCostCents) || value.currency !== 'USD' || value.source !== 'provider-api'
    || typeof value.activeSeconds !== 'number' || !Number.isFinite(value.activeSeconds) || value.activeSeconds < 0
    || Object.keys(value).length !== 16 || !hash(value.digest)) throw new ExecutorFailure();
  const { digest: claimed, ...body } = value;
  if (digest(body) !== claimed) throw new ExecutorFailure();
  return structuredClone(value) as ProviderObservation;
}
export function monotonic(previous: ProviderObservation | null, next: ProviderObservation) {
  if (previous && (next.observedAt < previous.observedAt || BigInt(next.listCostCents) < BigInt(previous.listCostCents)
    || next.activeSeconds < previous.activeSeconds || ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreation5mTokens', 'cacheCreation1hTokens']
      .some(key => next[key as keyof ProviderObservation] < previous[key as keyof ProviderObservation])
    || (previous.status === 'terminated' && next.status !== 'terminated'))) throw new ExecutorFailure();
}
